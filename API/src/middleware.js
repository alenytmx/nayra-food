import jwt from "jsonwebtoken";
import { User } from "./models.js";

export async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ message: "Sesión requerida" });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user?.active) return res.status(401).json({ message: "Usuario inactivo o inexistente" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Sesión inválida o vencida" });
  }
}

export function permit(...permissions) {
  return (req, res, next) => {
    if (["superadministrador", "admin"].includes(req.user.role) || req.user.isInitialAdmin || req.user.permissions.includes("*") || permissions.some((permission) => req.user.permissions.includes(permission))) return next();
    return res.status(403).json({ message: "No tienes permiso para realizar esta acción" });
  };
}

export function notFound(req, res) {
  res.status(404).json({ message: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(error, req, res, _next) {
  console.error(error);
  if (error.name === "ValidationError") return res.status(422).json({ message: "Datos inválidos", errors: Object.values(error.errors).map((item) => item.message) });
  if (error.code === 11000) return res.status(409).json({ message: "Ya existe un registro con esos datos", fields: error.keyValue });
  res.status(error.status ?? 500).json({ message: error.expose ? error.message : "Ocurrió un error interno" });
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
