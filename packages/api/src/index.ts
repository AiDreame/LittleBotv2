import express, { type Express } from "express";
import cors from "cors";
import type { HealthCheck } from "@salesrecon/types";
import { actualsRouter } from "./routes/actuals.js";
import { reconciliationRouter } from "./routes/reconciliation.js";
import { reportsRouter } from "./routes/reports.js";
import { analyticsRouter } from "./routes/analytics.js";

const app: Express = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(cors());
app.use(express.json());

// ── Health Check ──
app.get("/health", (_req, res) => {
  const body: HealthCheck = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
  res.json(body);
});

// ── Actuals Routes ──
app.use("/api/actuals", actualsRouter);

// ── Reconciliation Routes ──
app.use("/api/reconciliation", reconciliationRouter);

// ── Reports Routes ──
app.use("/api/reports", reportsRouter);
app.use("/api/analytics", analyticsRouter);

// ── Start ──
app.listen(PORT, "0.0.0.0", () => {
  console.log(`LittleBot API listening on http://0.0.0.0:${PORT}`);
});

export default app;
