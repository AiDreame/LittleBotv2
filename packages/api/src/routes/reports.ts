import express, { type Request, type Response } from "express";
import { getDb } from "@salesrecon/shared";
import type { ReportWithChatter } from "../db.js";

export const reportsRouter: express.Router = express.Router();

// ── GET /api/reports ──
// List all self-reported entries with chatter info.
// Optional query params: chatter_id, date (YYYY-MM-DD), status (reconciled|pending)
reportsRouter.get("/", (req: Request, res: Response) => {
  const db = getDb();
  const chatterId =
    typeof req.query.chatter_id === "string"
      ? Number(req.query.chatter_id)
      : undefined;
  const date =
    typeof req.query.date === "string" ? req.query.date : undefined;
  const status =
    typeof req.query.status === "string" ? req.query.status : undefined;

  let sql = `
    SELECT r.*, c.discord_id AS chatter_discord_id, c.name AS chatter_name,
           CASE WHEN d.id IS NOT NULL THEN 'reconciled' ELSE 'pending' END AS status
    FROM reports r
    JOIN chatters c ON c.id = r.chatter_id
    LEFT JOIN discrepancies d ON d.report_id = r.id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (chatterId !== undefined && !isNaN(chatterId)) {
    sql += " AND r.chatter_id = ?";
    params.push(chatterId);
  }

  if (date) {
    sql += " AND date(r.shift_start) = ?";
    params.push(date);
  }

  if (status === "reconciled") {
    sql += " AND d.id IS NOT NULL";
  } else if (status === "pending") {
    sql += " AND d.id IS NULL";
  }

  sql += " ORDER BY r.created_at DESC LIMIT 500";

  const rows = db.prepare(sql).all(...params) as Array<
    ReportWithChatter & { status: string }
  >;

  res.json({ count: rows.length, data: rows });
});
