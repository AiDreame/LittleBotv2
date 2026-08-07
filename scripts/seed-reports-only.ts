import { getDb } from "../packages/shared/src/db.js";

const db = getDb();

db.prepare("INSERT OR IGNORE INTO teams (name, discord_guild_id) VALUES (?,?)").run("Test","guild-001");
const tid = (db.prepare("SELECT id FROM teams WHERE discord_guild_id=?").get("guild-001") as { id: number }).id;

db.prepare("INSERT OR IGNORE INTO chatters (discord_id,name,team_id) VALUES (?,?,?)").run("111111111111111111","Dave",tid);
const cid = (db.prepare("SELECT id FROM chatters WHERE discord_id=?").get("111111111111111111") as { id: number }).id;

// Insert 2 reports for Dave — no actuals yet
db.prepare(
  "INSERT INTO reports (chatter_id,reported_sales,reported_tips,shift_start,shift_end,message_id) VALUES (?,?,?,?,?,?)"
).run(cid, 500, 30, "2026-07-23T09:00:00Z", "2026-07-23T17:00:00Z", "msg-dave");
db.prepare(
  "INSERT INTO reports (chatter_id,reported_sales,reported_tips,shift_start,shift_end,message_id) VALUES (?,?,?,?,?,?)"
).run(cid, 200, 10, "2026-07-24T09:00:00Z", "2026-07-24T17:00:00Z", "msg-dave2");

console.log("Inserted 2 reports for Dave (no actuals yet)");
console.log("Reports:", (db.prepare("SELECT COUNT(*) as c FROM reports").get() as { c: number }).c);
