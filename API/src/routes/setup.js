import { Router } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import { AuditLog, BusinessSettings, Counter, User } from "../models.js";
import { asyncRoute } from "../middleware.js";
import { httpError } from "../utils.js";

const router = Router();
const setupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

router.get("/status", asyncRoute(async (_req, res) => {
  const [users, initialAdmin] = await Promise.all([User.countDocuments(), User.exists({ isInitialAdmin: true, active: true })]);
  res.json({ requiresSetup: users === 0, configured: Boolean(initialAdmin), blockedByExistingUsers: users > 0 && !initialAdmin });
}));

router.get("/branding", asyncRoute(async (_req, res) => {
  const settings = await BusinessSettings.findOneAndUpdate({ key: "main" }, { $set: { systemVersion: "6.1.2" }, $setOnInsert: { key: "main" } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  res.json({ businessName: settings.businessName, loginTitle: settings.loginTitle, loginSubtitle: settings.loginSubtitle, loginBackgroundUrl: settings.loginBackgroundUrl, accentColor: settings.accentColor, theme: settings.theme, soundEnabled: settings.soundEnabled, systemVersion: settings.systemVersion, supportEmail: settings.supportEmail });
}));

router.post("/admin", setupLimiter, asyncRoute(async (req, res) => {
  const remoteAddress = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) throw httpError(403, "El administrador inicial sólo puede configurarse desde esta computadora");
  const name = String(req.body.name ?? "").trim();
  const username = String(req.body.username ?? "").trim().toLowerCase();
  const password = String(req.body.password ?? "");
  if (name.length < 2 || !/^[a-z0-9._-]{3,30}$/.test(username)) throw httpError(422, "Nombre o usuario no válidos");
  if (password.length < 12) throw httpError(422, "La contraseña debe tener al menos 12 caracteres");

  const session = await mongoose.startSession();
  try {
    const user = await session.withTransaction(async () => {
      if (await User.exists({}).session(session)) throw httpError(409, "El administrador inicial ya fue configurado");
      await Counter.findOneAndUpdate({ key: "setup:initial-admin" }, { $set: { sequence: 1 } }, { upsert: true, new: true, session });
      const now = new Date();
      const [created] = await User.create([{
        name,
        username,
        passwordHash: await User.hashPassword(password),
        role: "superadministrador",
        permissions: ["*"],
        active: true,
        isInitialAdmin: true,
        passwordChangedAt: now,
        setupCompletedAt: now,
      }], { session });
      await AuditLog.create([{ user: created._id, username, action: "Configuró administrador inicial", module: "Configuración", entity: "User", entityId: created._id, reference: username, metadata: { setupCompletedAt: now }, ip: req.ip }], { session });
      return created;
    });
    const token = jwt.sign({ sub: user._id.toString(), role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN ?? "8h", issuer: "nayrafood" });
    res.status(201).json({ token, user: { id: user._id, name: user.name, username: user.username, role: user.role, permissions: user.permissions, isInitialAdmin: user.isInitialAdmin, setupCompletedAt: user.setupCompletedAt } });
  } finally { await session.endSession(); }
}));

export default router;
