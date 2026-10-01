import { Router } from "express";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import { User } from "../models.js";
import { asyncRoute, authenticate } from "../middleware.js";
import { audit, httpError } from "../utils.js";

const router = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

router.post("/login", loginLimiter, asyncRoute(async (req, res) => {
  const { identity, password } = req.body;
  if (!identity || !password) throw httpError(422, "Usuario y contraseña son obligatorios");
  const normalized = String(identity).trim().toLowerCase();
  const user = await User.findOne({ active: true, $or: [{ username: normalized }, { email: normalized }] }).select("+passwordHash");
  if (!user || !(await user.verifyPassword(password))) throw httpError(401, "Credenciales incorrectas");
  const token = jwt.sign({ sub: user._id.toString(), role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN ?? "8h", issuer: "nayrafood" });
  req.user = user;
  await audit(req, { action: "Inicio de sesión", module: "Autenticación", entity: "User", entityId: user._id, reference: user.username });
  res.json({ token, user: { id: user._id, name: user.name, username: user.username, email: user.email, role: user.role, permissions: user.permissions, isInitialAdmin: user.isInitialAdmin, profileImageUrl: user.profileImageUrl } });
}));

router.get("/me", authenticate, asyncRoute(async (req, res) => {
  res.json({ user: { id: req.user._id, name: req.user.name, username: req.user.username, email: req.user.email, role: req.user.role, permissions: req.user.permissions, isInitialAdmin: req.user.isInitialAdmin, profileImageUrl: req.user.profileImageUrl } });
}));

router.post("/logout", authenticate, asyncRoute(async (req, res) => { await audit(req, { action: "Cierre de sesión", module: "Autenticación", entity: "User", entityId: req.user._id, reference: req.user.username }); res.status(204).end(); }));

export default router;
