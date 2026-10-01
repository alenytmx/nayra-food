import { Router } from "express";
import mongoose from "mongoose";
import { CashSession, Sale } from "../models.js";
import { asyncRoute, permit } from "../middleware.js";
import { audit, httpError, nextFolio } from "../utils.js";

const router = Router();
router.get("/current", asyncRoute(async (req, res) => {
  const cash = await CashSession.findOne({ status: "abierta" }).sort({ openedAt: -1 }).populate("user", "name username role").populate("movements.user", "name username role").lean();
  if (!cash) return res.json(null);
  cash.sales = await Sale.find({ cashSession: cash._id }).populate({ path: "order", select: "folio items table", populate: { path: "table", select: "number label name area" } }).select("folio order paymentCondition payments total status createdAt").sort({ createdAt: -1 }).lean();
  res.json(cash);
}));

router.post("/open", permit("caja.abrir"), asyncRoute(async (req, res) => {
  if (await CashSession.exists({ status: "abierta" })) throw httpError(409, "Ya existe una caja abierta para el restaurante");
  const openingAmount = Number(req.body.openingAmount);
  if (!Number.isFinite(openingAmount) || openingAmount < 0) throw httpError(422, "El fondo inicial no es válido");
  const folio = await nextFolio("cash", "CAJA");
  const cash = await CashSession.create({ folio, user: req.user._id, openingAmount, movements: [{ type: "fondo", amount: openingAmount, method: "efectivo", reason: "Fondo inicial", user: req.user._id }] });
  await audit(req, { action: "Abrió caja", module: "Caja", entity: "CashSession", entityId: cash._id, reference: folio, metadata: { openingAmount } });
  res.status(201).json(cash);
}));

router.post("/:id/movements", permit("caja.movimientos"), asyncRoute(async (req, res) => {
  const { type, method = "efectivo", reason } = req.body;
  const amount = Number(req.body.amount);
  if (!["entrada", "retiro"].includes(type) || !Number.isFinite(amount) || amount <= 0 || !reason) throw httpError(422, "Tipo, monto y motivo son obligatorios");
  const signedAmount = type === "retiro" ? -amount : amount;
  const cash = await CashSession.findOneAndUpdate({ _id: req.params.id, status: "abierta" }, { $push: { movements: { type, amount: signedAmount, method, reason, user: req.user._id } } }, { new: true });
  if (!cash) throw httpError(404, "Caja abierta no encontrada");
  await audit(req, { action: type === "retiro" ? "Registró retiro" : "Registró entrada", module: "Caja", entity: "CashSession", entityId: cash._id, metadata: { amount, reason } });
  res.json(cash);
}));

router.post("/:id/close", permit("caja.cerrar"), asyncRoute(async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const cash = await session.withTransaction(async () => {
      const current = await CashSession.findOne({ _id: req.params.id, status: "abierta" }).session(session);
      if (!current) throw httpError(404, "Caja abierta no encontrada");
      const expectedCash = current.movements.filter((item) => item.method === "efectivo").reduce((sum, item) => sum + item.amount, 0);
      const countedCash = Number(req.body.countedCash);
      if (!Number.isFinite(countedCash) || countedCash < 0) throw httpError(422, "El efectivo contado no es válido");
      current.status = "cerrada"; current.closedAt = new Date(); current.expectedCash = expectedCash; current.countedCash = countedCash; current.difference = countedCash - expectedCash; current.closingNotes = req.body.notes; await current.save({ session });
      await audit(req, { action: "Cerró caja", module: "Caja", entity: "CashSession", entityId: current._id, metadata: { expectedCash, countedCash, difference: current.difference } }, session);
      return current;
    });
    res.json(cash);
  } finally { await session.endSession(); }
}));

export default router;
