// ── SalesRecon Shared Types ──

/** A chatter (sales team member tracked by the bot) */
export interface Chatter {
  id: string;
  discord_id: string;
  name: string;
  team_id: string;
}

/** A team (group of chatters in a Discord guild/server) */
export interface Team {
  id: string;
  name: string;
  discord_guild_id: string;
}

/** A self-reported logout report from a chatter */
export interface Report {
  id: string;
  chatter_id: string;
  reported_sales: number;
  reported_tips: number;
  shift_start: string; // ISO 8601
  shift_end: string; // ISO 8601
  message_id: string;
  created_at: string; // ISO 8601
  model_name?: string | null;
}

/** Actual sales data pulled from the platform */
export interface Actuals {
  id: string;
  chatter_id: string;
  actual_sales: number;
  actual_tips: number;
  date: string; // ISO 8601 date
  source: string;
}

/** A discrepancy between a report and actuals */
export interface Discrepancy {
  id: string;
  report_id: string;
  actual_id: string;
  sales_diff: number;
  tips_diff: number;
  flagged_at: string; // ISO 8601
}

/** Discord bot configuration per guild */
export interface GuildConfig {
  guild_id: string;
  report_channel_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Health-check response */
export interface HealthCheck {
  status: "ok";
  timestamp: string;
  uptime: number;
}

/** Parsed result from a logout message */
export interface ParsedReport {
  reported_sales: number;
  reported_tips: number;
  shift_start: string;
  shift_end: string;
  /** Only populated when the source explicitly labels a model; otherwise null. */
  model_name?: string | null;
}

/** Result of writing a parsed report to the database */
export interface ReportWriteResult {
  id: number;
  chatter_id: number;
  reported_sales: number;
  reported_tips: number;
  shift_start: string;
  shift_end: string;
  message_id: string;
  created_at: string;
}
