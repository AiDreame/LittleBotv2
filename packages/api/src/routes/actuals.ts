import express, { type Request, type Response } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import {
  listActuals,
  createActual,
  deleteActual,
  upsertActual,
  type ActualInput,
  type ImportResult,
} from "../db.js";
import { reconcileAll } from "../reconciliation.js";

export const actualsRouter: express.Router = express.Router();

// ── Multer setup (memory storage for CSV uploads) ──

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "text/csv" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.endsWith(".csv")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"));
    }
  },
});

// ── GET /api/actuals ──

actualsRouter.get("/", (req: Request, res: Response) => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const chatter_id =
    typeof req.query.chatter_id === "string" ? req.query.chatter_id : undefined;

  const rows = listActuals({ date, chatterId: chatter_id });
  res.json({ count: rows.length, data: rows });
});

// ── POST /api/actuals ──

actualsRouter.post("/", (req: Request, res: Response) => {
  const { discord_id, date, actual_sales, actual_tips, source } = req.body;

  // Validation
  const errors: string[] = [];
  if (!discord_id) errors.push("discord_id is required");
  if (!date) errors.push("date is required (YYYY-MM-DD)");
  if (actual_sales === undefined || actual_sales === null)
    errors.push("actual_sales is required");
  if (!source) errors.push("source is required");

  if (errors.length > 0) {
    res.status(400).json({ error: "Validation failed", details: errors });
    return;
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD format" });
    return;
  }

  const input: ActualInput = {
    discord_id: String(discord_id),
    date,
    actual_sales: Number(actual_sales),
    actual_tips: Number(actual_tips ?? 0),
    source: String(source),
  };

  const row = createActual(input);

  // Auto-reconciliation: reconcile any unmatched reports that now have matching actuals
  const reconResult = reconcileAll({ date: input.date });

  res.status(201).json({ ...row, discrepancies_found: reconResult.discrepancies_found });
});

// ── DELETE /api/actuals/:id ──

actualsRouter.delete("/:id", (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id!), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const deleted = deleteActual(id);
  if (deleted) {
    res.json({ deleted: true, id });
  } else {
    res.status(404).json({ error: "Actual record not found" });
  }
});

// ── POST /api/actuals/upload (CSV upload) ──

actualsRouter.post(
  "/upload",
  upload.single("file"),
  (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
      return;
    }

    const csvText = req.file.buffer.toString("utf-8");
    let records: Record<string, string>[];

    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      }) as Record<string, string>[];
    } catch (err) {
      res.status(400).json({
        error: "Failed to parse CSV",
        details: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
    const datesSeen = new Set<string>();

    for (let i = 0; i < records.length; i++) {
      const row = records[i]!;
      const lineNum = i + 2; // +1 for 0-index, +1 for header

      const discord_id = row["discord_id"]?.trim();
      const date = row["date"]?.trim();
      const actual_sales = row["actual_sales"]?.trim();
      const actual_tips = row["actual_tips"]?.trim();
      const source = row["source"]?.trim();

      // Validate required fields
      if (!discord_id || !date || actual_sales === undefined || actual_sales === "") {
        result.errors.push(
          `Line ${lineNum}: missing required field(s). Need: discord_id, date, actual_sales`,
        );
        result.skipped++;
        continue;
      }

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        result.errors.push(
          `Line ${lineNum}: invalid date "${date}" — must be YYYY-MM-DD`,
        );
        result.skipped++;
        continue;
      }

      const salesNum = Number(actual_sales);
      if (isNaN(salesNum) || salesNum < 0) {
        result.errors.push(
          `Line ${lineNum}: invalid actual_sales "${actual_sales}"`,
        );
        result.skipped++;
        continue;
      }

      const tipsNum = actual_tips ? Number(actual_tips) : 0;
      if (isNaN(tipsNum) || tipsNum < 0) {
        result.errors.push(
          `Line ${lineNum}: invalid actual_tips "${actual_tips}"`,
        );
        result.skipped++;
        continue;
      }

      const input: ActualInput = {
        discord_id,
        date,
        actual_sales: salesNum,
        actual_tips: tipsNum,
        source: source || "csv",
      };

      try {
        upsertActual(input);
        result.imported++;
        datesSeen.add(date);
      } catch (err) {
        result.errors.push(
          `Line ${lineNum}: DB error — ${err instanceof Error ? err.message : String(err)}`,
        );
        result.skipped++;
      }
    }

    // Auto-reconciliation: run reconciliation for each date that had records imported
    let totalDiscrepancies = 0;
    for (const d of datesSeen) {
      const reconResult = reconcileAll({ date: d });
      totalDiscrepancies += reconResult.discrepancies_found;
    }

    res.json({ ...result, discrepancies_found: totalDiscrepancies });
  },
);

// ── POST /api/actuals/fetch (platform integration placeholder) ──

actualsRouter.post("/fetch", (_req: Request, res: Response) => {
  res.json({
    status: "not_configured",
    message:
      "Platform integration coming soon. Use CSV upload for now.",
  });
});
