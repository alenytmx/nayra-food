import { Router } from "express";
import mongoose from "mongoose";
import { CashSession, Customer, InventoryMovement, Order, Product, Sale, Table } from "../models.js";
import { asyncRoute, permit } from "../middleware.js";
import { audit, httpError, nextFolio } from "../utils.js";
import { restoreInventory } from "./orders.js";

const router = Router();
const populateSales = (query) => query.populate("customer", "name phone creditBalance creditLimit").populate("user", "name username").populate({ path: "order", select: "folio orderType saleMode items table guestName", populate: { path: "table", select: "number label name area" } });

router.get("/", asyncRoute(async (req, res) => {
  const filter = {}; if (req.query.condition) filter.paymentCondition = req.query.condition; if (req.query.status) filter.status = req.query.status;
  res.json(await populateSales(Sale.find(filter)).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 500, 1000)));
}));

router.post("/checkout", permit("ventas.agregar"), asyncRoute(async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const sale = await session.withTransaction(async () => {
      const cash = await CashSession.findOne({ status: "abierta" }).sort({ openedAt: -1 }).session(session);
      if (!cash) throw httpError(409, "Debes abrir la caja antes de registrar una venta");
      const order = await Order.findOne({ _id: req.body.orderId, closedAt: null, commandStatus: { $ne: "cancelada" } }).session(session);
      if (!order) throw httpError(404, "Orden abierta no encontrada");
      if (await Sale.exists({ order: order._id }).session(session)) throw httpError(409, "Esta comanda ya fue cobrada");
      const condition = req.body.paymentCondition ?? order.paymentCondition;
      const can = (permission) => req.user.isInitialAdmin || ["superadministrador", "admin"].includes(req.user.role) || req.user.permissions.includes("*") || req.user.permissions.includes(permission);
      if (condition === "credito" && !can("ventas.credito")) throw httpError(403, "No tienes permiso para vender a crédito");
      if (condition === "cortesia" && !can("ventas.cortesia")) throw httpError(403, "No tienes permiso para registrar cortesías");
      const payments = condition === "cortesia" ? [] : (Array.isArray(req.body.payments) ? req.body.payments : []).map((payment) => ({ method: payment.method, amount: Math.max(0, Number(payment.amount || 0)), cardFeePercent: Number(payment.cardFeePercent || 0), cardFeeAmount: Number(payment.cardFeeAmount || 0) })).filter((payment) => payment.amount > 0);
      if (payments.some((payment) => !["efectivo", "tarjeta", "transferencia"].includes(payment.method))) throw httpError(422, "Método de pago no válido");
      const paid = payments.reduce((sum, payment) => sum + payment.amount, 0);
      if (condition === "contado" && paid < order.total) throw httpError(422, "El pago no cubre el total de la cuenta");
      const balanceDue = condition === "credito" ? Math.max(0, order.total - paid) : 0;
      let customer = null;
      if (condition === "credito") {
        if (!order.customer) throw httpError(422, "Una venta a crédito requiere cliente registrado");
        customer = await Customer.findById(order.customer).session(session);
        if (!customer || customer.creditBalance + balanceDue > customer.creditLimit) throw httpError(409, "El cliente no tiene crédito disponible suficiente");
        customer.creditBalance += balanceDue; await customer.save({ session });
      }
      if (condition === "cortesia" && !order.items.every((item) => item.courtesy && item.courtesyReason)) throw httpError(422, "Cada producto de cortesía debe tener un motivo");
      if (!order.inventoryCommitted || order.inventoryRestoredAt) throw httpError(409, "La comanda no tiene inventario reservado; cancélala y créala nuevamente");

      const folio = await nextFolio("sales", "VENTA", 6, session);
      const totalCost = order.items.reduce((sum, item) => sum + item.costPrice * item.quantity, 0);
      const amountReceived = Number(req.body.amountReceived ?? paid);
      const change = condition === "contado" ? Math.max(0, amountReceived - order.total) : 0;
      if (change > 0) {
        const availableCash = cash.movements.filter((item) => item.method === "efectivo").reduce((sum, item) => sum + item.amount, 0);
        const receivedCash = payments.filter((item) => item.method === "efectivo").reduce((sum, item) => sum + item.amount, 0);
        if (availableCash + receivedCash < change) throw httpError(409, `No hay efectivo suficiente para dar ${change.toLocaleString("es-MX", { style: "currency", currency: "MXN" })} de cambio`);
      }
      const total = condition === "cortesia" ? 0 : order.total;
      const [created] = await Sale.create([{ folio, order: order._id, cashSession: cash._id, customer: order.customer, user: req.user._id, paymentCondition: condition, payments, amountReceived, change, subtotal: order.subtotal, discountAmount: order.discountAmount, total, totalCost, grossProfit: condition === "cortesia" ? -totalCost : order.total - totalCost, paidAmount: condition === "contado" ? order.total : Math.min(paid, order.total), balanceDue, creditGeneratedAmount: balanceDue, dueDate: condition === "credito" && req.body.dueDate ? new Date(req.body.dueDate) : undefined, notes: req.body.notes }], { session });
      for (const payment of payments) {
        const movementAmount = payment.amount - (condition === "contado" && payment.method === "efectivo" ? change : 0);
        cash.movements.push({ type: condition === "credito" ? "abono" : "venta", amount: movementAmount, method: payment.method, reason: `${condition === "credito" ? "Anticipo" : "Venta"} ${folio}`, reference: created._id, user: req.user._id });
      }
      await cash.save({ session });
      order.closedAt = new Date(); order.paymentCondition = condition; order.messages.push({ text: `Venta ${folio} registrada como ${condition}`, kind: "sistema", user: req.user._id }); await order.save({ session });
      if (order.table) await Table.findByIdAndUpdate(order.table, { status: "libre", currentOrder: null, customer: null, guestName: null, guestCount: 0 }, { session });
      if (order.customer) await Customer.findByIdAndUpdate(order.customer, { $inc: { visits: 1 } }, { session });
      await audit(req, { action: `Registró venta ${condition}`, module: "Ventas", entity: "Sale", entityId: created._id, reference: folio, metadata: { folio, total: created.total, balanceDue, payments } }, session); return created;
    });
    res.status(201).json(sale);
  } finally { await session.endSession(); }
}));

router.patch("/:id", permit("ventas.editar"), asyncRoute(async (req, res) => {
  const allowed = {}; for (const field of ["notes", "dueDate"]) if (req.body[field] !== undefined) allowed[field] = req.body[field];
  const sale = await Sale.findOneAndUpdate({ _id: req.params.id, status: "completada" }, { $set: { ...allowed, editedAt: new Date(), editedBy: req.user._id } }, { new: true, runValidators: true });
  if (!sale) throw httpError(404, "Venta activa no encontrada");
  if (Array.isArray(req.body.itemNotes)) { const order = await Order.findById(sale.order); for (const change of req.body.itemNotes) { const item = order.items.id(change.itemId); if (item) item.notes = String(change.notes || ""); } await order.save(); }
  await audit(req, { action: "Editó venta", module: "Ventas", entity: "Sale", entityId: sale._id, reference: sale.folio, metadata: { fields: Object.keys(allowed) } }); res.json(sale);
}));

router.post("/:id/cancel", permit("ventas.cancelar"), asyncRoute(async (req, res) => {
  const session = await mongoose.startSession();
  try { const result = await session.withTransaction(async () => {
    const sale = await Sale.findOne({ _id: req.params.id, status: "completada" }).session(session); if (!sale) throw httpError(404, "Venta activa no encontrada");
    const order = await Order.findById(sale.order).session(session); const reason = String(req.body.reason || "Cancelación de venta");
    await restoreInventory(order, `Cancelación ${sale.folio}: ${reason}`, req, session, sale._id);
    if (sale.paymentCondition === "credito" && sale.customer && sale.balanceDue > 0) await Customer.findByIdAndUpdate(sale.customer, { $inc: { creditBalance: -sale.balanceDue } }, { session });
    const cash = await CashSession.findById(sale.cashSession).session(session);
    if (cash) {
      const refunds = [...sale.payments.map((p) => ({ method: p.method, amount: p.amount - (p.method === "efectivo" ? sale.change : 0) })), ...sale.creditPayments.map((p) => ({ method: p.method, amount: p.amount }))];
      for (const refund of refunds) if (refund.amount > 0) cash.movements.push({ type: "cancelacion", amount: -refund.amount, method: refund.method, reason: `Cancelación ${sale.folio}`, reference: sale._id, user: req.user._id });
      await cash.save({ session });
    }
    sale.status = "cancelada"; sale.cancelReason = reason; sale.cancelledAt = new Date(); sale.cancelledBy = req.user._id; sale.balanceDue = 0; await sale.save({ session });
    order.commandStatus = "cancelada"; order.cancelReason = reason; order.cancelledAt = new Date(); order.cancelledBy = req.user._id; order.messages.push({ text: `Venta cancelada: ${reason}. Inventario devuelto.`, kind: "sistema", user: req.user._id }); await order.save({ session });
    await audit(req, { action: "Canceló venta y devolvió inventario", module: "Ventas", entity: "Sale", entityId: sale._id, reference: sale.folio, metadata: { reason, folio: sale.folio } }, session); return sale;
  }); res.json(result); } finally { await session.endSession(); }
}));

router.post("/:id/payment", permit("creditos.abonar"), asyncRoute(async (req, res) => {
  const session = await mongoose.startSession();
  try { const result = await session.withTransaction(async () => {
    const sale = await Sale.findOne({ _id: req.params.id, paymentCondition: "credito", status: "completada", balanceDue: { $gt: 0 } }).session(session); if (!sale) throw httpError(404, "Crédito pendiente no encontrado");
    const cash = await CashSession.findOne({ status: "abierta" }).sort({ openedAt: -1 }).session(session); if (!cash) throw httpError(409, "Debe existir una caja abierta para registrar un abono");
    const amount = Number(req.body.amount); const method = req.body.method; if (!Number.isFinite(amount) || amount <= 0 || !["efectivo", "tarjeta", "transferencia"].includes(method)) throw httpError(422, "Monto y método de abono no válidos");
    const applied = Math.min(amount, sale.balanceDue); sale.balanceDue -= applied; sale.paidAmount += applied; sale.creditPayments.push({ method, amount: applied, user: req.user._id }); await sale.save({ session });
    const customer = await Customer.findById(sale.customer).session(session); if (customer) { customer.creditBalance = Math.max(0, customer.creditBalance - applied); await customer.save({ session }); }
    cash.movements.push({ type: "abono", amount: applied, method, reason: `Abono ${sale.folio}`, reference: sale._id, user: req.user._id }); await cash.save({ session });
    await audit(req, { action: "Registró abono", module: "Créditos", entity: "Sale", entityId: sale._id, metadata: { amount: applied, method, balanceDue: sale.balanceDue } }, session); return { applied, saleBalance: sale.balanceDue, customerBalance: customer?.creditBalance ?? 0 };
  }); res.json(result); } finally { await session.endSession(); }
}));

export default router;
