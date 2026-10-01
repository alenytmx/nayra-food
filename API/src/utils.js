import { AuditLog, Counter } from "./models.js";

export async function nextFolio(key, prefix, digits = 6, session) {
  const counter = await Counter.findOneAndUpdate({ key }, { $inc: { sequence: 1 } }, { new: true, upsert: true, session });
  return `${prefix}-${String(counter.sequence).padStart(digits, "0")}`;
}

export async function audit(req, { action, module, entity, entityId, reference, metadata = {} }, session) {
  return AuditLog.create([{
    user: req.user?._id,
    username: req.user?.username,
    action,
    module,
    entity,
    entityId,
    reference,
    metadata,
    ip: req.ip,
  }], { session });
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

export function dateRange(query) {
  const start = query.start ? new Date(`${query.start}T00:00:00.000Z`) : new Date(new Date().setUTCHours(0, 0, 0, 0));
  const end = query.end ? new Date(`${query.end}T23:59:59.999Z`) : new Date(new Date().setUTCHours(23, 59, 59, 999));
  return { start, end };
}
