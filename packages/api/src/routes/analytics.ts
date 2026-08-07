import express, { type Router } from "express";
import { getDb } from "@salesrecon/shared";
export const analyticsRouter: Router = express.Router();

// Aggregate-safe analytics; raw message content is never returned.
analyticsRouter.get("/summary", (_req, res) => {
  const db = getDb();
  const sales = db.prepare(`SELECT COALESCE(SUM(reported_sales),0) sales, COALESCE(SUM(reported_tips),0) tips,
    COUNT(*) reports, COUNT(DISTINCT chatter_id) chatters, AVG(reported_sales) average_sale,
    SUM(CASE WHEN reported_sales = 0 AND reported_tips = 0 THEN 1 ELSE 0 END) zero_earnings_reports,
    SUM(CASE WHEN earnings_source = 'inferred_zero' THEN 1 ELSE 0 END) event_only_zero,
    COALESCE(SUM((julianday(shift_end)-julianday(shift_start))*24),0) shift_hours FROM reports`).get();
  const daily = db.prepare(`SELECT date(shift_start) date, SUM(reported_sales) sales, SUM(reported_tips) tips, COUNT(*) reports
    FROM reports GROUP BY date(shift_start) ORDER BY date DESC LIMIT 365`).all();
  const monthly = db.prepare(`SELECT strftime('%Y-%m', shift_start) month, SUM(reported_sales) sales, SUM(reported_tips) tips, COUNT(*) reports
    FROM reports GROUP BY month ORDER BY month DESC`).all();
  const byChatter = db.prepare(`SELECT c.discord_id, c.name, COUNT(r.id) reports, SUM(r.reported_sales) sales,
    SUM(r.reported_tips) tips, AVG(r.reported_sales) average_sale,
    SUM((julianday(r.shift_end)-julianday(r.shift_start))*24) shift_hours
    FROM reports r JOIN chatters c ON c.id=r.chatter_id GROUP BY c.id ORDER BY sales DESC`).all();
  const events = db.prepare(`SELECT event_type, COUNT(*) count FROM chatter_events GROUP BY event_type`).all();
  const incomplete = db.prepare(`SELECT c.discord_id, c.name, e.occurred_at login_at FROM chatter_events e JOIN chatters c ON c.id=e.chatter_id
    WHERE e.event_type='login' AND NOT EXISTS (SELECT 1 FROM chatter_events x WHERE x.chatter_id=e.chatter_id AND x.event_type='logout' AND x.occurred_at>e.occurred_at)`).all();
  res.json({ summary: sales, events, daily, monthly, by_chatter: byChatter, incomplete_shifts: incomplete });
});

// Per-chatter owner view. This intentionally returns aggregates only: message content and
// source payloads stay private in raw_messages.
analyticsRouter.get("/chatters", (_req, res) => {
  const db = getDb();
  const chatters = db.prepare(`
    SELECT c.id, c.discord_id, c.name,
      COUNT(DISTINCT r.id) reports,
      COALESCE(SUM(r.reported_sales), 0) sales,
      COALESCE(SUM(r.reported_tips), 0) tips,
      AVG(r.reported_sales) average_sale,
      COALESCE(SUM((julianday(r.shift_end)-julianday(r.shift_start))*24), 0) shift_hours,
      (SELECT COUNT(*) FROM chatter_events e WHERE e.chatter_id=c.id AND e.event_type='login') login_events,
      (SELECT COUNT(*) FROM chatter_events e WHERE e.chatter_id=c.id AND e.event_type='logout') logout_events,
      (SELECT COUNT(*) FROM chatter_events e WHERE e.chatter_id=c.id AND e.event_type='login'
        AND NOT EXISTS (SELECT 1 FROM chatter_events x WHERE x.chatter_id=e.chatter_id AND x.event_type='logout' AND x.occurred_at>e.occurred_at)) incomplete_shifts
    FROM chatters c LEFT JOIN reports r ON r.chatter_id=c.id
    GROUP BY c.id ORDER BY sales DESC, c.name ASC
  `).all();
  const daily = db.prepare(`SELECT c.discord_id, date(r.shift_start) date, COUNT(*) reports,
      SUM(r.reported_sales) sales, SUM(r.reported_tips) tips
    FROM reports r JOIN chatters c ON c.id=r.chatter_id
    GROUP BY c.id, date(r.shift_start) ORDER BY date DESC`).all();
  const monthly = db.prepare(`SELECT c.discord_id, strftime('%Y-%m', r.shift_start) month, COUNT(*) reports,
      SUM(r.reported_sales) sales, SUM(r.reported_tips) tips
    FROM reports r JOIN chatters c ON c.id=r.chatter_id
    GROUP BY c.id, month ORDER BY month DESC`).all();
  res.json({ chatters, daily, monthly });
});

analyticsRouter.get("/chatter/:discordId", (req, res) => {
  const db = getDb();
  const chatter = db.prepare(`SELECT id, discord_id, name FROM chatters WHERE discord_id = ?`).get(req.params.discordId) as {id:number; discord_id:string; name:string} | undefined;
  if (!chatter) return res.status(404).json({ error: "Chatter not found" });
  const summary = db.prepare(`SELECT COUNT(*) reports, COALESCE(SUM(reported_sales),0) sales, COALESCE(SUM(reported_tips),0) tips, AVG(reported_sales) average_sale, COALESCE(SUM((julianday(shift_end)-julianday(shift_start))*24),0) shift_hours FROM reports WHERE chatter_id=?`).get(chatter.id);
  const models = db.prepare(`SELECT COALESCE(NULLIF(TRIM(model_name),''),'Unknown model') model_name, COUNT(*) reports, SUM(reported_sales) sales, SUM(reported_tips) tips, AVG(reported_sales) average_sale FROM reports WHERE chatter_id=? GROUP BY COALESCE(NULLIF(TRIM(model_name),''),'Unknown model') ORDER BY sales DESC`).all(chatter.id);
  const daily = db.prepare(`SELECT date(shift_start) date, COUNT(*) reports, SUM(reported_sales) sales, SUM(reported_tips) tips FROM reports WHERE chatter_id=? GROUP BY date(shift_start) ORDER BY date DESC`).all(chatter.id);
  const monthly = db.prepare(`SELECT strftime('%Y-%m',shift_start) month, COUNT(*) reports, SUM(reported_sales) sales, SUM(reported_tips) tips FROM reports WHERE chatter_id=? GROUP BY month ORDER BY month DESC`).all(chatter.id);
  return res.json({ chatter, summary, models, daily, monthly });
});

analyticsRouter.get("/raw-status", (_req, res) => {
  const db = getDb();
  res.json({ statuses: db.prepare(`SELECT parse_status status, COALESCE(parse_reason,'') reason, COUNT(*) count FROM raw_messages GROUP BY parse_status, parse_reason ORDER BY count DESC`).all(), total_retained: (db.prepare("SELECT COUNT(*) count FROM raw_messages").get() as {count:number}).count });
});
