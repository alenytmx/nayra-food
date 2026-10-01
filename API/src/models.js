import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const { Schema, model, models } = mongoose;
const money = { type: Number, min: 0, default: 0 };

const userSchema = new Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, trim: true, lowercase: true, unique: true },
  email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["superadministrador", "admin", "supervisor", "caja", "mesero", "barra", "capitan", "cocina", "reparto"], default: "mesero" },
  permissions: [{ type: String, trim: true }],
  active: { type: Boolean, default: true },
  isInitialAdmin: { type: Boolean, default: false },
  passwordChangedAt: Date,
  setupCompletedAt: Date,
  profileImageUrl: { type: String, default: null },
}, { timestamps: true });
userSchema.methods.verifyPassword = function verifyPassword(password) { return bcrypt.compare(password, this.passwordHash); };
userSchema.statics.hashPassword = (password) => bcrypt.hash(password, 12);

const productSchema = new Schema({
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  name: { type: String, required: true, trim: true, index: true },
  category: { type: String, required: true, trim: true, index: true },
  description: { type: String, trim: true, maxlength: 500 },
  imageUrl: { type: String, default: null },
  prices: { cost: money, sale: money, wholesale: money },
  stock: { type: Number, min: 0, default: 0 },
  minimumStock: { type: Number, min: 0, default: 0 },
  unit: { type: String, default: "pieza" },
  recipe: [{ ingredient: { type: Schema.Types.ObjectId, ref: "Product" }, quantity: { type: Number, min: 0 } }],
  available: { type: Boolean, default: true },
  visibleWhenOutOfStock: { type: Boolean, default: true },
  discountType: { type: String, enum: ["ninguno", "porcentaje", "monto"], default: "ninguno" },
  discountValue: money,
  discountStartsAt: Date,
  discountEndsAt: Date,
  active: { type: Boolean, default: true },
}, { timestamps: true });

const areaSchema = new Schema({
  name: { type: String, required: true, trim: true, unique: true },
  description: { type: String, trim: true, maxlength: 300 },
  color: { type: String, default: "#ef6a2c" },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const productCategorySchema = new Schema({
  name: { type: String, required: true, trim: true, unique: true },
  description: { type: String, trim: true, maxlength: 300 },
  color: { type: String, default: "#ef6a2c" },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const customerSchema = new Schema({
  name: { type: String, required: true, trim: true, index: true },
  phone: { type: String, trim: true, index: true },
  email: { type: String, trim: true, lowercase: true },
  birthDate: Date,
  ineImageUrl: String,
  birthdayVerifiedAt: Date,
  creditLimit: money,
  creditBalance: money,
  visits: { type: Number, min: 0, default: 0 },
  notes: { type: String, maxlength: 500 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const tableSchema = new Schema({
  number: { type: Number, min: 1, sparse: true },
  label: { type: String, required: true, trim: true, uppercase: true, index: true },
  name: { type: String, trim: true },
  capacity: { type: Number, min: 1, default: 4 },
  area: { type: String, default: "Salón principal" },
  areaRef: { type: Schema.Types.ObjectId, ref: "Area", default: null },
  accessMode: { type: String, enum: ["libre", "restringida"], default: "libre" },
  assignedWaiters: [{ type: Schema.Types.ObjectId, ref: "User" }],
  status: { type: String, enum: ["libre", "ocupada", "reservada", "limpieza"], default: "libre", index: true },
  customer: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
  guestName: { type: String, trim: true },
  guestCount: { type: Number, min: 0, default: 0 },
  arrivedAt: Date,
  reservationAt: Date,
  currentOrder: { type: Schema.Types.ObjectId, ref: "Order", default: null },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const orderItemSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  name: { type: String, required: true },
  quantity: { type: Number, min: 1, required: true },
  unitPrice: money,
  costPrice: money,
  subtotal: money,
  discountAmount: money,
  courtesy: { type: Boolean, default: false },
  courtesyReason: String,
  notes: String,
}, { _id: true });

const orderSchema = new Schema({
  folio: { type: String, required: true, unique: true, index: true },
  orderType: { type: String, enum: ["restaurante", "para_llevar", "domicilio", "aplicacion"], required: true, index: true },
  table: { type: Schema.Types.ObjectId, ref: "Table", default: null },
  customer: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
  guestName: String,
  waiter: { type: Schema.Types.ObjectId, ref: "User", required: true },
  serviceSource: { type: String, enum: ["mesero", "barra"], default: "mesero", index: true },
  assignedWaiter: { type: Schema.Types.ObjectId, ref: "User", default: null },
  assignedBar: { type: Schema.Types.ObjectId, ref: "User", default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  deliveryPlatform: String,
  address: String,
  items: [orderItemSchema],
  inventoryCommitted: { type: Boolean, default: false },
  inventoryRestoredAt: Date,
  saleMode: { type: String, enum: ["venta", "costo", "mayoreo"], default: "venta" },
  paymentCondition: { type: String, enum: ["contado", "credito", "cortesia"], default: "contado" },
  discount: { type: Number, min: 0, default: 0 },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  coupon: { type: Schema.Types.ObjectId, ref: "Coupon", default: null },
  subtotal: money,
  discountAmount: money,
  total: money,
  commandStatus: { type: String, enum: ["por_aceptar", "aceptada", "preparando", "lista", "entregada", "cancelada"], default: "por_aceptar", index: true },
  estimatedMinutes: { type: Number, min: 1 },
  timerEndsAt: Date,
  timeExtensions: [{ minutes: { type: Number, min: 1 }, reason: String, user: { type: Schema.Types.ObjectId, ref: "User" }, createdAt: { type: Date, default: Date.now } }],
  messages: [{ text: { type: String, required: true, maxlength: 500 }, kind: { type: String, enum: ["mensaje", "pregunta", "aviso", "sistema"], default: "mensaje" }, user: { type: Schema.Types.ObjectId, ref: "User" }, createdAt: { type: Date, default: Date.now } }],
  acceptedBy: { type: Schema.Types.ObjectId, ref: "User" },
  acceptedAt: Date,
  readyAt: Date,
  deliveredBy: { type: Schema.Types.ObjectId, ref: "User" },
  deliveredAt: Date,
  closedAt: Date,
  cancelReason: String,
  cancelledAt: Date,
  cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

const paymentSchema = new Schema({
  method: { type: String, enum: ["efectivo", "tarjeta", "transferencia"], required: true },
  amount: { type: Number, min: 0, required: true },
  cardFeePercent: { type: Number, min: 0, default: 0 },
  cardFeeAmount: money,
}, { _id: false });

const saleSchema = new Schema({
  folio: { type: String, required: true, unique: true, index: true },
  order: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
  cashSession: { type: Schema.Types.ObjectId, ref: "CashSession", default: null },
  customer: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  paymentCondition: { type: String, enum: ["contado", "credito", "cortesia"], required: true },
  payments: [paymentSchema],
  amountReceived: money,
  change: money,
  subtotal: money,
  discountAmount: money,
  total: money,
  totalCost: money,
  grossProfit: money,
  paidAmount: money,
  balanceDue: money,
  creditGeneratedAmount: money,
  dueDate: Date,
  creditPayments: [{ method: { type: String, enum: ["efectivo", "tarjeta", "transferencia"], required: true }, amount: money, user: { type: Schema.Types.ObjectId, ref: "User" }, createdAt: { type: Date, default: Date.now } }],
  notes: { type: String, maxlength: 500 },
  editedAt: Date,
  editedBy: { type: Schema.Types.ObjectId, ref: "User" },
  cancelReason: String,
  cancelledAt: Date,
  cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
  status: { type: String, enum: ["completada", "cancelada", "devuelta"], default: "completada" },
}, { timestamps: true });

const cashMovementSchema = new Schema({
  type: { type: String, enum: ["fondo", "venta", "abono", "entrada", "retiro", "gasto", "cancelacion"], required: true },
  amount: { type: Number, required: true },
  method: { type: String, enum: ["efectivo", "tarjeta", "transferencia"], default: "efectivo" },
  reason: String,
  reference: { type: Schema.Types.ObjectId },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const cashSessionSchema = new Schema({
  folio: { type: String, required: true, unique: true },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  openingAmount: money,
  openedAt: { type: Date, default: Date.now },
  closedAt: Date,
  status: { type: String, enum: ["abierta", "cerrada"], default: "abierta", index: true },
  movements: [cashMovementSchema],
  expectedCash: money,
  countedCash: money,
  difference: { type: Number, default: 0 },
  closingNotes: String,
}, { timestamps: true });

const couponSchema = new Schema({
  code: { type: String, required: true, uppercase: true, trim: true, unique: true },
  name: { type: String, required: true },
  type: { type: String, enum: ["porcentaje", "monto", "cortesia"], required: true },
  value: money,
  maximumDiscount: money,
  minimumPurchase: money,
  birthdayOnly: { type: Boolean, default: false },
  ineRequired: { type: Boolean, default: false },
  startsAt: Date,
  endsAt: Date,
  maxUses: { type: Number, min: 0 },
  uses: { type: Number, min: 0, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const expenseSchema = new Schema({
  folio: { type: String, required: true, unique: true },
  category: { type: String, required: true },
  concept: { type: String, required: true },
  amount: { type: Number, min: 0, required: true },
  paymentMethod: { type: String, enum: ["efectivo", "tarjeta", "transferencia"], required: true },
  cashSession: { type: Schema.Types.ObjectId, ref: "CashSession", default: null },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  receiptUrl: String,
  occurredAt: { type: Date, default: Date.now },
}, { timestamps: true });

const businessSettingsSchema = new Schema({
  key: { type: String, default: "main", unique: true },
  businessName: { type: String, trim: true, default: "NAYRAFOOD RESTAURANTE" },
  legalName: { type: String, trim: true },
  taxId: { type: String, trim: true },
  address: { type: String, trim: true },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  ticketFooter: { type: String, trim: true, default: "Gracias por su visita" },
  ticketSize: { type: String, enum: ["58mm", "80mm", "carta"], default: "80mm" },
  theme: { type: String, enum: ["claro", "oscuro", "transparente", "sistema"], default: "claro" },
  accentColor: { type: String, default: "#ef6a2c" },
  soundEnabled: { type: Boolean, default: true },
  loginTitle: { type: String, default: "NAYRAFOOD RESTAURANTE" },
  loginSubtitle: { type: String, default: "Tu restaurante, bajo control." },
  loginBackgroundUrl: { type: String, default: null },
  slogan: String,
  socialNetworks: String,
  systemVersion: { type: String, default: "6.1.2" },
  supportEmail: { type: String, default: "corpsierracode@gmail.com" },
}, { timestamps: true });

const inventoryMovementSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
  type: { type: String, enum: ["entrada", "salida", "venta", "venta_mayoreo", "venta_costo", "cortesia", "cancelacion", "ajuste"], required: true, index: true },
  quantity: { type: Number, required: true },
  stockBefore: { type: Number, required: true },
  stockAfter: { type: Number, required: true },
  reason: { type: String, required: true, trim: true },
  order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
  sale: { type: Schema.Types.ObjectId, ref: "Sale", default: null },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

const auditLogSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "User" },
  username: String,
  action: { type: String, required: true },
  module: { type: String, required: true, index: true },
  entity: String,
  entityId: Schema.Types.ObjectId,
  reference: String,
  metadata: Schema.Types.Mixed,
  ip: String,
}, { timestamps: true });

const counterSchema = new Schema({ key: { type: String, required: true, unique: true }, sequence: { type: Number, default: 0 } });

export const User = models.User || model("User", userSchema);
export const Product = models.Product || model("Product", productSchema);
export const Area = models.Area || model("Area", areaSchema);
export const ProductCategory = models.ProductCategory || model("ProductCategory", productCategorySchema);
export const Customer = models.Customer || model("Customer", customerSchema);
export const Table = models.Table || model("Table", tableSchema);
export const Order = models.Order || model("Order", orderSchema);
export const Sale = models.Sale || model("Sale", saleSchema);
export const CashSession = models.CashSession || model("CashSession", cashSessionSchema);
export const Coupon = models.Coupon || model("Coupon", couponSchema);
export const Expense = models.Expense || model("Expense", expenseSchema);
export const BusinessSettings = models.BusinessSettings || model("BusinessSettings", businessSettingsSchema);
export const AuditLog = models.AuditLog || model("AuditLog", auditLogSchema);
export const InventoryMovement = models.InventoryMovement || model("InventoryMovement", inventoryMovementSchema);
export const Counter = models.Counter || model("Counter", counterSchema);
