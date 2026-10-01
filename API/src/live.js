import jwt from "jsonwebtoken";
import { User } from "./models.js";

const clients = new Map();

function writeEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function liveEvents(req, res) {
  try {
    const payload = jwt.verify(String(req.query.token || ""), process.env.JWT_SECRET);
    const user = await User.findById(payload.sub).select("name username role active");
    if (!user?.active) return res.status(401).json({ message: "Sesión inválida" });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const clientId = `${user._id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    clients.set(clientId, { response: res, userId: String(user._id) });
    writeEvent(res, { type: "connected", title: "Sesión activa", message: "Notificaciones en tiempo real conectadas", createdAt: new Date().toISOString() });
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
    req.on("close", () => { clearInterval(heartbeat); clients.delete(clientId); });
  } catch {
    res.status(401).json({ message: "No fue posible conectar las notificaciones" });
  }
}

export function publishLiveEvent(event, actorId = null) {
  const payload = { ...event, createdAt: event.createdAt || new Date().toISOString() };
  for (const { response, userId } of clients.values()) {
    if (actorId && String(actorId) === userId) continue;
    try { writeEvent(response, payload); } catch { /* la conexión se limpiará al cerrarse */ }
  }
}

export function activeLiveUsers() {
  return new Set([...clients.values()].map((client) => client.userId)).size;
}
