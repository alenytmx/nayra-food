import "dotenv/config";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { connectDatabase } from "./db.js";
import { authenticate, errorHandler, notFound } from "./middleware.js";
import authRoutes from "./routes/auth.js";
import catalogRoutes from "./routes/catalog.js";
import orderRoutes from "./routes/orders.js";
import cashRoutes from "./routes/cash.js";
import salesRoutes from "./routes/sales.js";
import reportRoutes from "./routes/reports.js";
import setupRoutes from "./routes/setup.js";
import { liveEvents } from "./live.js";

for (const key of ["MONGODB_URI", "JWT_SECRET"]) if (!process.env[key]) throw new Error(`Falta la variable ${key}`);
fs.mkdirSync("uploads/products", { recursive: true });
fs.mkdirSync("uploads/private/identity", { recursive: true });
fs.mkdirSync("uploads/profiles", { recursive: true });

const app = express();
const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:5173").split(",").map((item) => item.trim()).filter(Boolean);
const isLocalNetworkOrigin = (origin) => {
  try {
    const { hostname, port, protocol } = new URL(origin);
    return protocol === "http:" && port === "5173" && (hostname === "localhost" || hostname === "127.0.0.1" || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname));
  } catch { return false; }
};
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin(origin, callback) { if (!origin || allowedOrigins.includes(origin) || (process.env.NODE_ENV !== "production" && isLocalNetworkOrigin(origin))) return callback(null, true); callback(new Error("Origen no permitido")); }, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use("/uploads/products", express.static("uploads/products", { maxAge: "7d", immutable: false }));
app.use("/uploads/profiles", express.static("uploads/profiles", { maxAge: "7d", immutable: false }));

app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "nayrafood-api", version: "6.1.2-restaurante", time: new Date().toISOString() }));
app.use("/api/setup", setupRoutes);
app.use("/api/auth", authRoutes);
app.get("/api/live/events", liveEvents);
app.use("/api", authenticate);
app.use("/api", catalogRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/cash", cashRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/reports", reportRoutes);
app.use(notFound);
app.use(errorHandler);

const port = Number(process.env.PORT) || 4000;
await connectDatabase();
app.listen(port, () => console.log(`NAYRAFOOD API escuchando en el puerto ${port}`));
