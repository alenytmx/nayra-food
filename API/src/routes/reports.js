import { Router } from "express";
import PDFDocument from "pdfkit";
import { CashSession, Expense, Sale } from "../models.js";
import { asyncRoute, permit } from "../middleware.js";
import { dateRange } from "../utils.js";

const router = Router();

async function buildSummary(query) {
  const { start, end } = dateRange(query);
  const [sales, expenses, cashSessions] = await Promise.all([
    Sale.find({ createdAt: { $gte: start, $lte: end }, status: "completada" }).lean(),
    Expense.find({ occurredAt: { $gte: start, $lte: end } }).lean(),
    CashSession.find({ openedAt: { $lte: end }, $or: [{ closedAt: { $gte: start } }, { status: "abierta" }] }).lean(),
  ]);
  const cashSales = sales.filter((sale) => sale.paymentCondition === "contado").reduce((sum, sale) => sum + sale.total, 0);
  const creditGenerated = sales.filter((sale) => sale.paymentCondition === "credito").reduce((sum, sale) => sum + (sale.creditGeneratedAmount ?? sale.total), 0);
  const courtesyCost = sales.filter((sale) => sale.paymentCondition === "cortesia").reduce((sum, sale) => sum + sale.totalCost, 0);
  const totalCost = sales.reduce((sum, sale) => sum + sale.totalCost, 0);
  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const creditPayments = cashSessions.flatMap((cash) => cash.movements).filter((movement) => movement.type === "abono" && movement.createdAt >= start && movement.createdAt <= end).reduce((sum, movement) => sum + movement.amount, 0);
  const discounts = sales.reduce((sum, sale) => sum + sale.discountAmount, 0);
  const grossProfitAccrued = sales.reduce((sum, sale) => sum + sale.grossProfit, 0);
  const cashResult = cashSales + creditPayments - totalExpenses;
  return { range: { start, end }, counts: { sales: sales.length, courtesy: sales.filter((sale) => sale.paymentCondition === "cortesia").length, credits: sales.filter((sale) => sale.paymentCondition === "credito").length, expenses: expenses.length }, cashSales, creditPayments, creditGenerated, discounts, totalCost, courtesyCost, totalExpenses, grossProfitAccrued, cashResult };
}

router.get("/daily-summary", permit("reportes.ver"), asyncRoute(async (req, res) => res.json(await buildSummary(req.query))));

router.get("/daily-summary.pdf", permit("reportes.descargar"), asyncRoute(async (req, res) => {
  const summary = await buildSummary(req.query);
  const doc = new PDFDocument({ size: "LETTER", margin: 46, bufferPages: true });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve) => doc.on("end", resolve));
  doc.fillColor("#173a32").fontSize(23).text("NAYRAFOOD RESTAURANTE").fontSize(10).fillColor("#6e7774").text("Reporte diario de operación");
  doc.moveDown(1.5).fillColor("#17211f").fontSize(13).text(`Periodo: ${summary.range.start.toLocaleDateString("es-MX")} — ${summary.range.end.toLocaleDateString("es-MX")}`);
  doc.moveDown();
  const rows = [
    ["Ventas cobradas", summary.cashSales], ["Abonos recibidos", summary.creditPayments], ["Crédito generado (no caja)", summary.creditGenerated],
    ["Costo de productos", -summary.totalCost], ["Gastos operativos", -summary.totalExpenses], ["Descuentos aplicados", summary.discounts],
    ["Utilidad devengada", summary.grossProfitAccrued], ["Resultado de caja", summary.cashResult],
  ];
  rows.forEach(([label, value], index) => {
    const y = doc.y; if (index % 2 === 0) doc.rect(46, y - 5, 520, 24).fill("#f4f6f5");
    doc.fillColor("#39433f").fontSize(10).text(label, 54, y, { width: 330 });
    doc.fillColor(Number(value) < 0 ? "#b6382b" : "#173a32").fontSize(10).text(Number(value).toLocaleString("es-MX", { style: "currency", currency: "MXN" }), 390, y, { width: 165, align: "right" });
    doc.y = y + 25;
  });
  doc.moveDown().fontSize(9).fillColor("#6e7774").text("Los créditos generados no ingresan a caja. Sólo los abonos recibidos incrementan los ingresos del corte.");
  doc.end(); await completed;
  const buffer = Buffer.concat(chunks);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="reporte-nayrafood-${summary.range.start.toISOString().slice(0,10)}.pdf"`, "Content-Length": buffer.length, "Cache-Control": "no-store" });
  res.end(buffer);
}));

export default router;
