/**
 * Reclassify every report's model from its retained raw message.
 *
 * Reads the canonical roster (packages/shared/src/model-roster.json), classifies
 * each report from its raw message content with the SAME conservative rules the
 * parser uses (explicit label > single roster match > ambiguous > none), and
 * updates `model_name` + `model_match`. Sales/tips/shift/message data are never
 * touched; no models are invented; ambiguous or evidence-free reports stay
 * `null` (Unknown) with an explanatory `model_match`.
 *
 * Idempotent — safe to re-run after editing the roster.
 *
 * Run:
 *   SALESRECON_DB_PATH=/home/team/shared/LittleBotv2/data/salesrecon.db \
 *   packages/bot/node_modules/.bin/tsx scripts/reprocess-models.ts
 *
 * This does NOT require /update-reports (it works from retained raw_messages).
 * /update-reports is only needed when raw messages are missing for a report
 * (e.g. channels fetched before raw retention was added).
 */
import { getDb, closeDb } from "../packages/shared/src/db.js";
import { buildModelMatcher, classifyModelEvidence } from "../packages/shared/src/models.js";
import roster from "../packages/shared/src/model-roster.json";

const db = getDb();
const matcher = buildModelMatcher(roster);

const count = (sql: string): number =>
  Number((db.prepare(sql).get() as { c: number }).c);

const before = {
  total: count("SELECT COUNT(*) c FROM reports"),
  known: count("SELECT COUNT(*) c FROM reports WHERE model_name IS NOT NULL AND TRIM(model_name) <> ''"),
  match: Object.fromEntries(
    (db.prepare("SELECT COALESCE(model_match,'unclassified') m, COUNT(*) c FROM reports GROUP BY m").all() as {m:string;c:number}[])
      .map((r) => [r.m, r.c]),
  ),
};

const rows = db
  .prepare(
    `SELECT r.id, r.message_id FROM reports r ORDER BY r.id`,
  )
  .all() as { id: number; message_id: string }[];
const contentStmt = db.prepare("SELECT content FROM raw_messages WHERE message_id = ?");
const update = db.prepare("UPDATE reports SET model_name = ?, model_match = ? WHERE id = ?");

const out = { matched: 0, explicit: 0, ambiguous: 0, none: 0, noRaw: 0 };
for (const row of rows) {
  const raw = contentStmt.get(row.message_id) as { content: string } | undefined;
  if (!raw) {
    if (db.prepare("SELECT model_name FROM reports WHERE id=?").get(row.id) === undefined) continue;
    out.noRaw++;
    continue;
  }
  const res = classifyModelEvidence(matcher, raw.content);
  update.run(res.modelName, res.status, row.id);
  out[res.status]++;
}

const after = {
  total: count("SELECT COUNT(*) c FROM reports"),
  known: count("SELECT COUNT(*) c FROM reports WHERE model_name IS NOT NULL AND TRIM(model_name) <> ''"),
  match: Object.fromEntries(
    (db.prepare("SELECT COALESCE(model_match,'unclassified') m, COUNT(*) c FROM reports GROUP BY m").all() as {m:string;c:number}[])
      .map((r) => [r.m, r.c]),
  ),
};

console.log(JSON.stringify({ roster_entries: roster.length, before, after, updated: out }, null, 2));
closeDb();
