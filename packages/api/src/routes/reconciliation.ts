import express, { type Request, type Response } from "express";
import {
  reconcileAll,
  getDiscrepancies,
  getSummary,
} from "../reconciliation.js";

export const reconciliationRouter: express.Router = express.Router();

// ── POST /api/reconciliation/run ──
// Trigger reconciliation. Optional body: { date?: string, chatter_id?: number }
reconciliationRouter.post("/run", (req: Request, res: Response) => {
  const { date, chatter_id } = req.body as {
    date?: string;
    chatter_id?: number;
  };

  // Validate date format if provided
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD format" });
    return;
  }

  const result = reconcileAll({
    date,
    chatter_id: chatter_id !== undefined ? Number(chatter_id) : undefined,
  });

  res.json(result);
});

// ── GET /api/reconciliation/discrepancies ──
// List discrepancies with filters: ?date_from=, ?date_to=, ?chatter_id=, ?min_diff=
reconciliationRouter.get("/discrepancies", (req: Request, res: Response) => {
  const date_from =
    typeof req.query.date_from === "string" ? req.query.date_from : undefined;
  const date_to =
    typeof req.query.date_to === "string" ? req.query.date_to : undefined;
  const chatter_id =
    typeof req.query.chatter_id === "string"
      ? Number(req.query.chatter_id)
      : undefined;
  const min_diff =
    typeof req.query.min_diff === "string"
      ? Number(req.query.min_diff)
      : undefined;

  // Validate date formats
  if (date_from && !/^\d{4}-\d{2}-\d{2}$/.test(date_from)) {
    res
      .status(400)
      .json({ error: "date_from must be YYYY-MM-DD format" });
    return;
  }
  if (date_to && !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
    res.status(400).json({ error: "date_to must be YYYY-MM-DD format" });
    return;
  }

  const discrepancies = getDiscrepancies({
    date_from,
    date_to,
    chatter_id: chatter_id && !isNaN(chatter_id) ? chatter_id : undefined,
    min_diff: min_diff && !isNaN(min_diff) ? min_diff : undefined,
  });

  res.json({ count: discrepancies.length, data: discrepancies });
});

// ── GET /api/reconciliation/summary ──
// Aggregate stats: total reports, reconciled, discrepancies, $ off (over/under)
reconciliationRouter.get("/summary", (_req: Request, res: Response) => {
  const summary = getSummary();
  res.json(summary);
});
