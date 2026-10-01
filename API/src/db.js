import mongoose from "mongoose";

export function normalizeMongoUri(rawValue) {
  let uri = String(rawValue ?? "").trim();
  if ((uri.startsWith('"') && uri.endsWith('"')) || (uri.startsWith("'") && uri.endsWith("'"))) uri = uri.slice(1, -1).trim();
  uri = uri.replace(/^MONGODB_URI\s*=\s*/i, "").trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri)) {
    throw new Error('MONGODB_URI inválida. Debe comenzar exactamente con "mongodb://" o "mongodb+srv://". Copia la cadena desde MongoDB Atlas > Connect > Drivers.');
  }
  if (/[<>]/.test(uri)) throw new Error("MONGODB_URI todavía contiene un marcador como <db_password>. Reemplázalo con los datos reales de Atlas.");
  return uri;
}

export async function connectDatabase() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI no está configurada");
  const uri = normalizeMongoUri(process.env.MONGODB_URI);
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { autoIndex: process.env.NODE_ENV !== "production" });
  console.log("MongoDB conectado");
}
