import { Router } from "express";
import mongoose from "mongoose";
import { Coupon, Customer, InventoryMovement, Order, Product, Sale, Table, User } from "../models.js";
import { asyncRoute, permit } from "../middleware.js";
import { audit, httpError, nextFolio } from "../utils.js";
import { activeLiveUsers, publishLiveEvent } from "../live.js";

const router = Router();
const transitions = { por_aceptar: ["aceptada", "cancelada"], aceptada: ["preparando", "cancelada"], preparando: ["lista", "cancelada"], lista: ["entregada", "cancelada"], entregada: [], cancelada: [] };
const elevated = (user) => user.isInitialAdmin || ["superadministrador", "admin"].includes(user.role) || user.permissions.includes("*");
const can = (req, permission) => elevated(req.user) || req.user.permissions.includes(permission);
const populateOrder = (query) => query.populate("table", "number label name area guestCount").populate("customer", "name birthDate creditLimit creditBalance").populate("waiter", "name username profileImageUrl").populate("assignedWaiter", "name username profileImageUrl").populate("assignedBar", "name username profileImageUrl").populate("createdBy", "name username profileImageUrl").populate("acceptedBy", "name profileImageUrl").populate("deliveredBy", "name profileImageUrl").populate("messages.user", "name profileImageUrl").populate("timeExtensions.user", "name profileImageUrl");

function activeProductDiscount(product, now = new Date()) {
  if (!product.discountType || product.discountType === "ninguno" || !product.discountValue) return 0;
  if (product.discountStartsAt && product.discountStartsAt > now) return 0;
  if (product.discountEndsAt && product.discountEndsAt < now) return 0;
  return product.discountType === "porcentaje" ? product.prices.sale * product.discountValue / 100 : product.discountValue;
}

function buildItem(product, requested, saleMode) {
  const quantity = Math.max(1, Number(requested.quantity));
  const basePrice = saleMode === "costo" ? product.prices.cost : saleMode === "mayoreo" ? product.prices.wholesale : product.prices.sale;
  const automaticDiscount = saleMode === "venta" && !requested.courtesy ? Math.min(basePrice, activeProductDiscount(product)) : 0;
  const unitPrice = requested.courtesy ? 0 : Math.max(0, basePrice - automaticDiscount);
  return { product: product._id, name: product.name, quantity, unitPrice, costPrice: product.prices.cost, subtotal: unitPrice * quantity, discountAmount: automaticDiscount * quantity, courtesy: Boolean(requested.courtesy), courtesyReason: requested.courtesyReason, notes: requested.notes };
}

async function commitInventory(items, order, saleMode, req, session) {
  for (const item of items) {
    const before = await Product.findOne({ _id: item.product, active: true, available: true, stock: { $ne: 86, $gte: item.quantity } }).session(session);
    if (!before) throw httpError(409, `${item.name} no está disponible, tiene 86 o no cuenta con existencia suficiente`);
    const after = await Product.findByIdAndUpdate(before._id, { $inc: { stock: -item.quantity } }, { new: true, session });
    const type = item.courtesy ? "cortesia" : saleMode === "mayoreo" ? "venta_mayoreo" : saleMode === "costo" ? "venta_costo" : "venta";
    await InventoryMovement.create([{ product: before._id, type, quantity: -item.quantity, stockBefore: before.stock, stockAfter: after.stock, reason: `Comanda ${order.folio}`, order: order._id, user: req.user._id }], { session });
  }
}

async function restoreInventory(order, reason, req, session, saleId = null) {
  if (!order.inventoryCommitted || order.inventoryRestoredAt) return;
  for (const item of order.items) {
    const before = await Product.findById(item.product).session(session);
    if (!before) continue;
    const after = await Product.findByIdAndUpdate(before._id, { $inc: { stock: item.quantity } }, { new: true, session });
    await InventoryMovement.create([{ product: before._id, type: "cancelacion", quantity: item.quantity, stockBefore: before.stock, stockAfter: after.stock, reason, order: order._id, sale: saleId, user: req.user._id }], { session });
  }
  order.inventoryRestoredAt = new Date();
}

router.get("/", asyncRoute(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.commandStatus = req.query.status;
  else if (req.query.history !== "true") { filter.closedAt = null; filter.commandStatus = { $ne: "cancelada" }; }
  if (req.user.role === "mesero") filter.$or = [{ assignedWaiter: req.user._id }, { createdBy: req.user._id }];
  if (req.user.role === "barra") filter.$or = [{ assignedBar: req.user._id }, { createdBy: req.user._id }];
  res.json(await populateOrder(Order.find(filter)).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 500, 1000)));
}));

router.get("/:id", asyncRoute(async (req, res) => { const order = await populateOrder(Order.findById(req.params.id)); if (!order) throw httpError(404, "Comanda no encontrada"); res.json(order); }));

router.post("/", permit("comandas.agregar"), asyncRoute(async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const requestedItems = Array.isArray(req.body.items) ? req.body.items : [];
      const productIds = requestedItems.map((item) => item.product);
      if (!productIds.length) throw httpError(422, "La orden debe contener al menos un producto");
      const products = await Product.find({ _id: { $in: productIds }, active: true, available: true, stock: { $ne: 86 } }).session(session);
      if (products.length !== new Set(productIds.map(String)).size) throw httpError(422, "Uno o más productos no están disponibles o tienen código 86");
      const productMap = new Map(products.map((product) => [String(product._id), product]));
      const saleMode = req.body.saleMode ?? "venta";
      if (saleMode === "costo" && !can(req, "ventas.costo")) throw httpError(403, "No tienes permiso para vender a costo");
      if (saleMode === "mayoreo" && !can(req, "ventas.mayoreo")) throw httpError(403, "No tienes permiso para vender a mayoreo");
      if ((Number(req.body.discountAmount) > 0 || Number(req.body.discountPercent) > 0) && !can(req, "ventas.descuento")) throw httpError(403, "No tienes permiso para aplicar descuentos manuales");
      if (requestedItems.some((item) => item.courtesy) && !can(req, "ventas.cortesia")) throw httpError(403, "No tienes permiso para registrar cortesías");
      if (req.body.couponCode && !can(req, "ventas.cupon")) throw httpError(403, "No tienes permiso para aplicar cupones");
      const serviceSource = req.body.serviceSource === "barra" ? "barra" : "mesero";
      let assignedWaiter = null;
      let assignedBar = null;
      if (serviceSource === "mesero") {
        const requestedWaiter = req.body.assignedWaiter || (req.user.role === "mesero" ? req.user._id : null);
        if (!requestedWaiter) throw httpError(422, "Selecciona al mesero responsable de la comanda");
        assignedWaiter = await User.findOne({ _id: requestedWaiter, role: "mesero", active: true }).session(session);
        if (!assignedWaiter) throw httpError(422, "El mesero seleccionado no está activo o no es válido");
      }
      if (serviceSource === "barra") {
        const requestedBar = req.body.assignedBar || (req.user.role === "barra" ? req.user._id : null);
        if (!requestedBar) throw httpError(422, "Selecciona al usuario responsable de barra");
        assignedBar = await User.findOne({ _id: requestedBar, role: "barra", active: true }).session(session);
        if (!assignedBar) throw httpError(422, "El usuario de barra seleccionado no está activo o no es válido");
      }
      if (req.body.table) {
        const access = await Table.findOne({ _id: req.body.table, active: true }).session(session);
        if (!access) throw httpError(404, "Mesa no encontrada");
        if (!elevated(req.user) && !can(req, "mesas.todas") && access.accessMode === "restringida" && access.assignedWaiters.length && !access.assignedWaiters.some((id) => String(id) === String(req.user._id))) throw httpError(403, "Sólo el mesero asignado, el capitán o un administrador pueden levantar pedidos en esta mesa");
        if (serviceSource === "mesero" && access.accessMode === "restringida" && access.assignedWaiters.length && !access.assignedWaiters.some((id) => String(id) === String(assignedWaiter._id))) throw httpError(422, "El mesero seleccionado no está asignado a esta mesa");
      }
      const items = requestedItems.map((requested) => buildItem(productMap.get(String(requested.product)), requested, saleMode));
      const productDiscount = items.reduce((sum, item) => sum + item.discountAmount, 0);
      const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
      const discountPercent = Math.min(100, Math.max(0, Number(req.body.discountPercent) || 0));
      let discountAmount = discountPercent > 0 ? subtotal * discountPercent / 100 : Math.min(subtotal, Math.max(0, Number(req.body.discountAmount) || 0)); let couponId = null;
      if (req.body.couponCode) {
        const now = new Date();
        const coupon = await Coupon.findOne({ code: String(req.body.couponCode).toUpperCase(), active: true, $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }] }).session(session);
        if (!coupon || (coupon.maxUses && coupon.uses >= coupon.maxUses)) throw httpError(422, "Cupón inválido o agotado");
        if (subtotal < coupon.minimumPurchase) throw httpError(422, "La compra no alcanza el mínimo del cupón");
        if (coupon.birthdayOnly || coupon.ineRequired) { const customer = await Customer.findById(req.body.customer).session(session); const isBirthday = customer?.birthDate && customer.birthDate.getUTCDate() === now.getUTCDate() && customer.birthDate.getUTCMonth() === now.getUTCMonth(); if (!customer?.birthdayVerifiedAt || (coupon.birthdayOnly && !isBirthday)) throw httpError(422, "El beneficio requiere cumpleaños e identidad verificados"); }
        const value = coupon.type === "porcentaje" ? subtotal * coupon.value / 100 : coupon.type === "monto" ? coupon.value : coupon.value > 0 ? coupon.value : subtotal;
        discountAmount += coupon.maximumDiscount ? Math.min(value, coupon.maximumDiscount) : value; discountAmount = Math.min(discountAmount, subtotal); coupon.uses += 1; await coupon.save({ session }); couponId = coupon._id;
      }
      const folio = await nextFolio("orders", "ORD", 6, session);
      const sourceMessage = serviceSource === "barra" ? `Comanda asignada a barra: ${assignedBar.name}` : `Comanda asignada al mesero ${assignedWaiter.name}`;
      const [order] = await Order.create([{ ...req.body, folio, waiter: assignedWaiter?._id || req.user._id, assignedWaiter: assignedWaiter?._id || null, assignedBar: assignedBar?._id || null, createdBy: req.user._id, serviceSource, items, saleMode, subtotal, discountPercent, discountAmount, total: subtotal - discountAmount, coupon: couponId, inventoryCommitted: true, messages: [{ text: `${sourceMessage}. Descuento automático en productos: ${productDiscount.toFixed(2)}`, kind: "sistema", user: req.user._id }] }], { session });
      await commitInventory(items, order, saleMode, req, session);
      if (req.body.table) { const table = await Table.findOneAndUpdate({ _id: req.body.table, status: { $in: ["libre", "reservada", "ocupada"] } }, { status: "ocupada", customer: req.body.customer ?? null, guestName: req.body.guestName || null, guestCount: Math.max(1, Number(req.body.guestCount) || 1), arrivedAt: new Date(), currentOrder: order._id }, { new: true, session }); if (!table) throw httpError(409, "La mesa no está disponible"); }
      await audit(req, { action: "Creó comanda y reservó inventario", module: "Comandas", entity: "Order", entityId: order._id, reference: folio, metadata: { folio, total: order.total, items: items.length, serviceSource, assignedWaiter: assignedWaiter?._id || null, assignedBar: assignedBar?._id || null } }, session); return order;
    });
    publishLiveEvent({ type: "order.created", title: `Nueva comanda ${result.folio}`, message: `${req.user.name} registró una nueva comanda`, orderId: result._id }, req.user._id);
    res.status(201).json(result);
  } finally { await session.endSession(); }
}));

router.patch("/:id/items", permit("comandas.agregar"), asyncRoute(async (req, res) => {
  const session = await mongoose.startSession();
  try { const result = await session.withTransaction(async () => {
    const order = await Order.findOne({ _id: req.params.id, closedAt: null, commandStatus: { $ne: "cancelada" } }).session(session); if (!order) throw httpError(404, "Orden abierta no encontrada");
    if (order.table && !elevated(req.user) && !can(req, "mesas.todas")) { const table = await Table.findById(order.table).select("accessMode assignedWaiters").session(session); if (table?.accessMode === "restringida" && table.assignedWaiters.length && !table.assignedWaiters.some((id) => String(id) === String(req.user._id))) throw httpError(403, "Sólo el mesero asignado, el capitán o un administrador pueden agregar pedidos a esta mesa"); }
    const requested = Array.isArray(req.body.items) ? req.body.items : []; const ids = requested.map((item) => item.product); if (!ids.length) throw httpError(422, "Debes agregar al menos un producto");
    const products = await Product.find({ _id: { $in: ids }, active: true, available: true, stock: { $ne: 86 } }).session(session); if (products.length !== new Set(ids.map(String)).size) throw httpError(422, "Uno o más productos no están disponibles o tienen 86");
    const productMap = new Map(products.map((product) => [String(product._id), product])); const newItems = requested.map((item) => buildItem(productMap.get(String(item.product)), item, order.saleMode));
    if (newItems.some((item) => item.courtesy) && !can(req, "ventas.cortesia")) throw httpError(403, "No tienes permiso para cortesías");
    await commitInventory(newItems, order, order.saleMode, req, session); order.items.push(...newItems); order.subtotal = order.items.reduce((sum, item) => sum + item.subtotal, 0); order.discountAmount = Math.min(order.subtotal, order.discountAmount || 0); order.total = order.subtotal - order.discountAmount; if (["lista", "entregada"].includes(order.commandStatus)) order.commandStatus = "por_aceptar"; order.messages.push({ text: `Se agregaron ${newItems.length} productos`, kind: "sistema", user: req.user._id }); await order.save({ session });
    await audit(req, { action: "Agregó productos y reservó inventario", module: "Comandas", entity: "Order", entityId: order._id, reference: order.folio, metadata: { items: newItems.length, total: order.total } }, session); return order;
  }); publishLiveEvent({ type: "order.items", title: `Nuevos productos en ${result.folio}`, message: `${req.user.name} agregó productos a la comanda`, orderId: result._id }, req.user._id); res.json(result); } finally { await session.endSession(); }
}));

router.patch("/:id/status", permit("comandas.actualizar"), asyncRoute(async (req, res) => {
  const order = await Order.findById(req.params.id); if (!order) throw httpError(404, "Orden no encontrada"); const nextStatus = req.body.status;
  if (!transitions[order.commandStatus]?.includes(nextStatus)) throw httpError(409, `No se puede cambiar de ${order.commandStatus} a ${nextStatus}`);
  if (nextStatus === "aceptada") { const minutes = Number(req.body.estimatedMinutes); if (!minutes) throw httpError(422, "Debes indicar el tiempo estimado"); order.acceptedBy = req.user._id; order.acceptedAt = new Date(); order.estimatedMinutes = minutes; order.timerEndsAt = new Date(Date.now() + minutes * 60000); }
  if (nextStatus === "lista") order.readyAt = new Date(); if (nextStatus === "entregada") { order.deliveredBy = req.user._id; order.deliveredAt = new Date(); }
  order.commandStatus = nextStatus; order.messages.push({ text: `Estado actualizado a ${nextStatus}`, kind: "sistema", user: req.user._id }); await order.save();
  await audit(req, { action: `Cambió comanda a ${nextStatus}`, module: "Comandas", entity: "Order", entityId: order._id, reference: order.folio, metadata: { estimatedMinutes: order.estimatedMinutes } });
  publishLiveEvent({ type: `order.${nextStatus}`, title: nextStatus === "aceptada" ? `Comanda ${order.folio} aceptada` : `Comanda ${order.folio}: ${nextStatus}`, message: nextStatus === "aceptada" ? `${req.user.name} aceptó la comanda con ${order.estimatedMinutes} minutos de preparación` : `${req.user.name} cambió el estado a ${nextStatus}`, orderId: order._id, estimatedMinutes: order.estimatedMinutes, activeUsers: activeLiveUsers() }, req.user._id);
  res.json(order);
}));

router.post("/:id/extend", permit("comandas.actualizar"), asyncRoute(async (req, res) => { const minutes = Number(req.body.minutes); if (![5, 10, 15, 20, 30].includes(minutes)) throw httpError(422, "Selecciona 5, 10, 15, 20 o 30 minutos"); const order = await Order.findOne({ _id: req.params.id, commandStatus: { $in: ["aceptada", "preparando"] } }); if (!order) throw httpError(404, "Comanda en cocina no encontrada"); order.timerEndsAt = new Date(Math.max(Date.now(), order.timerEndsAt?.getTime() || Date.now()) + minutes * 60000); order.timeExtensions.push({ minutes, reason: req.body.reason || "Cocina solicita más tiempo", user: req.user._id }); order.messages.push({ text: `Cocina solicita ${minutes} minutos adicionales: ${req.body.reason || "sin detalle"}`, kind: "aviso", user: req.user._id }); await order.save(); await audit(req, { action: "Amplió tiempo de cocina", module: "Comandas", entity: "Order", entityId: order._id, reference: order.folio, metadata: { minutes, reason: req.body.reason } }); publishLiveEvent({ type: "order.extended", title: `Más tiempo para ${order.folio}`, message: `${req.user.name} añadió ${minutes} minutos: ${req.body.reason || "sin detalle"}`, orderId: order._id, minutes }, req.user._id); res.json(order); }));
router.post("/:id/messages", permit("comandas.chat"), asyncRoute(async (req, res) => { const text = String(req.body.text || "").trim(); if (!text) throw httpError(422, "Escribe un mensaje"); const order = await Order.findById(req.params.id); if (!order) throw httpError(404, "Comanda no encontrada"); order.messages.push({ text, kind: req.body.kind || "mensaje", user: req.user._id }); await order.save(); await audit(req, { action: "Envió mensaje de comanda", module: "Comandas", entity: "Order", entityId: order._id, metadata: { kind: req.body.kind || "mensaje" } }); publishLiveEvent({ type: "order.message", title: `Mensaje en ${order.folio}`, message: `${req.user.name}: ${text}`, orderId: order._id }, req.user._id); res.json(order.messages.at(-1)); }));
router.post("/:id/close", permit("comandas.actualizar"), asyncRoute(async (req, res) => { const order = await Order.findOne({ _id: req.params.id, closedAt: null, commandStatus: { $ne: "cancelada" } }); if (!order) throw httpError(404, "Comanda abierta no encontrada"); order.commandStatus = "entregada"; order.deliveredAt = order.deliveredAt || new Date(); order.deliveredBy = req.user._id; order.messages.push({ text: "Comanda entregada al cliente; queda pendiente el cobro", kind: "sistema", user: req.user._id }); await order.save(); await audit(req, { action: "Cerró comanda de cocina", module: "Comandas", entity: "Order", entityId: order._id }); publishLiveEvent({ type: "order.entregada", title: `Comanda ${order.folio} entregada`, message: `${req.user.name} confirmó la entrega al cliente`, orderId: order._id }, req.user._id); res.json(order); }));
router.post("/:id/cancel", permit("comandas.cancelar"), asyncRoute(async (req, res) => {
  const session = await mongoose.startSession();
  try { const result = await session.withTransaction(async () => { if (await Sale.exists({ order: req.params.id, status: "completada" }).session(session)) throw httpError(409, "La comanda ya tiene venta; cancela la venta desde el historial de Ventas"); const order = await Order.findOne({ _id: req.params.id, closedAt: null, commandStatus: { $ne: "cancelada" } }).session(session); if (!order) throw httpError(404, "Comanda abierta no encontrada"); const reason = String(req.body.reason || "Cancelación de comanda"); await restoreInventory(order, `Cancelación ${order.folio}: ${reason}`, req, session); order.commandStatus = "cancelada"; order.cancelReason = reason; order.cancelledAt = new Date(); order.cancelledBy = req.user._id; order.closedAt = new Date(); order.messages.push({ text: `Comanda cancelada: ${reason}. Inventario devuelto.`, kind: "sistema", user: req.user._id }); await order.save({ session }); if (order.table) await Table.findByIdAndUpdate(order.table, { status: "libre", currentOrder: null, customer: null, guestName: null, guestCount: 0 }, { session }); await audit(req, { action: "Canceló comanda y devolvió inventario", module: "Comandas", entity: "Order", entityId: order._id, reference: order.folio, metadata: { reason } }, session); return order; }); publishLiveEvent({ type: "order.cancelada", title: `Comanda ${result.folio} cancelada`, message: `${req.user.name} canceló la comanda y el inventario fue devuelto`, orderId: result._id }, req.user._id); res.json(result); } finally { await session.endSession(); }
}));

export { restoreInventory };
export default router;
