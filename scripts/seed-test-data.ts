/**
 * Seed script: populate the DB with test reports and actuals
 * so we can verify reconciliation.
 *
 * Usage: npx tsx scripts/seed-test-data.ts
 */

import { getDb } from "../packages/shared/src/db.js";

const db = getDb();

// ── Insert test teams if not exist ──
db.prepare(
  "INSERT OR IGNORE INTO teams (name, discord_guild_id) VALUES (?, ?)",
).run("Test Team", "guild-001");

const teamId = (
  db.prepare("SELECT id FROM teams WHERE discord_guild_id = ?").get("guild-001") as { id: number }
).id;

// ── Insert test chatters ──
const chatters = [
  { discord_id: "123456789012345678", name: "Alice" },
  { discord_id: "987654321098765432", name: "Bob" },
  { discord_id: "111222333444555666", name: "Charlie" },
];

const chatterIds: Record<string, number> = {};

for (const c of chatters) {
  db.prepare(
    "INSERT OR IGNORE INTO chatters (discord_id, name, team_id) VALUES (?, ?, ?)",
  ).run(c.discord_id, c.name, teamId);
  const row = db
    .prepare("SELECT id FROM chatters WHERE discord_id = ?")
    .get(c.discord_id) as { id: number };
  chatterIds[c.discord_id] = row.id;
}

// ── Insert test reports (self-reported by chatters) ──
// Report date is embedded in shift_start
const reports = [
  // Alice: overreports by $60 sales on 2026-07-21
  {
    chatter_id: chatterIds["123456789012345678"]!,
    reported_sales: 1300.0,
    reported_tips: 80.0,
    shift_start: "2026-07-21T09:00:00Z",
    shift_end: "2026-07-21T17:00:00Z",
    message_id: "msg-001",
  },
  // Alice: underreports by $19.50 sales on 2026-07-22
  {
    chatter_id: chatterIds["123456789012345678"]!,
    reported_sales: 961.0,
    reported_tips: 45.0,
    shift_start: "2026-07-22T09:00:00Z",
    shift_end: "2026-07-22T17:00:00Z",
    message_id: "msg-002",
  },
  // Bob: overreports by $500 sales and $50 tips on 2026-07-21
  {
    chatter_id: chatterIds["987654321098765432"]!,
    reported_sales: 4000.0,
    reported_tips: 250.0,
    shift_start: "2026-07-21T10:00:00Z",
    shift_end: "2026-07-21T18:00:00Z",
    message_id: "msg-003",
  },
  // Bob: exact match on 2026-07-22 (within $1 threshold — no discrepancy)
  {
    chatter_id: chatterIds["987654321098765432"]!,
    reported_sales: 4201.0,
    reported_tips: 310.5,
    shift_start: "2026-07-22T10:00:00Z",
    shift_end: "2026-07-22T18:00:00Z",
    message_id: "msg-004",
  },
  // Charlie: underreports by $50 sales on 2026-07-21
  {
    chatter_id: chatterIds["111222333444555666"]!,
    reported_sales: 700.0,
    reported_tips: 25.0,
    shift_start: "2026-07-21T08:00:00Z",
    shift_end: "2026-07-21T16:00:00Z",
    message_id: "msg-005",
  },
];

for (const r of reports) {
  db.prepare(
    `INSERT INTO reports (chatter_id, reported_sales, reported_tips, shift_start, shift_end, message_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    r.chatter_id,
    r.reported_sales,
    r.reported_tips,
    r.shift_start,
    r.shift_end,
    r.message_id,
  );
}

// ── Insert test actuals (platform data) ──
// These match what's in sample-actuals.csv
const actuals = [
  { discord_id: "123456789012345678", date: "2026-07-21", actual_sales: 1240.0, actual_tips: 80.0, source: "onlyfans" },
  { discord_id: "123456789012345678", date: "2026-07-22", actual_sales: 980.5, actual_tips: 45.0, source: "onlyfans" },
  { discord_id: "987654321098765432", date: "2026-07-21", actual_sales: 3500.0, actual_tips: 200.0, source: "affiliate" },
  { discord_id: "987654321098765432", date: "2026-07-22", actual_sales: 4200.75, actual_tips: 310.5, source: "affiliate" },
  { discord_id: "111222333444555666", date: "2026-07-21", actual_sales: 750.0, actual_tips: 25.0, source: "onlyfans" },
  { discord_id: "111222333444555666", date: "2026-07-22", actual_sales: 625.0, actual_tips: 15.0, source: "onlyfans" },
];

for (const a of actuals) {
  // Find chatter_id by discord_id
  const chatter = db
    .prepare("SELECT id FROM chatters WHERE discord_id = ?")
    .get(a.discord_id) as { id: number } | undefined;

  if (chatter) {
    db.prepare(
      `INSERT OR REPLACE INTO actuals (chatter_id, actual_sales, actual_tips, date, source)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(chatter.id, a.actual_sales, a.actual_tips, a.date, a.source);
  }
}

// ── Summary ──
const reportCount = (db.prepare("SELECT COUNT(*) as cnt FROM reports").get() as { cnt: number }).cnt;
const actualCount = (db.prepare("SELECT COUNT(*) as cnt FROM actuals").get() as { cnt: number }).cnt;

console.log(`Seeded ${reportCount} reports and ${actualCount} actuals.`);
console.log("Reports should produce discrepancies:");
console.log("  - Alice 2026-07-21: reported $1300, actual $1240 → +$60 (overreported)");
console.log("  - Alice 2026-07-22: reported $961, actual $980.50 → -$19.50 (underreported)");
console.log("  - Bob 2026-07-21: reported $4000, actual $3500 → +$500 (overreported)");
console.log("  - Bob 2026-07-22: reported $4201, actual $4200.75 → +$0.25 (within $1, flagged but tiny)");
console.log("  - Charlie 2026-07-21: reported $700, actual $750 → -$50 (underreported)");
