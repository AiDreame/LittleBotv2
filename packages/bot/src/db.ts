import Database from "better-sqlite3";
import { getDb } from "@salesrecon/shared";
import type { ParsedReport, GuildConfig, ReportWriteResult } from "@salesrecon/types";

// Re-export for convenience
export { getDb, closeDb } from "@salesrecon/shared";

export type RawMessageInput = {
  message_id: string; guild_id: string; channel_id: string; author_id: string;
  author_name: string; message_created_at: string; content: string;
};

/** Retain every fetched Discord message; updates parse state without duplicating source rows. */
export function recordRawMessage(input: RawMessageInput, status = "unparsed", reason: string | null = null): void {
  const db = getDb();
  db.prepare(`INSERT INTO raw_messages
    (message_id,guild_id,channel_id,author_id,author_name,message_created_at,content,parse_status,parse_reason)
    VALUES (@message_id,@guild_id,@channel_id,@author_id,@author_name,@message_created_at,@content,@status,@reason)
    ON CONFLICT(message_id) DO UPDATE SET parse_status=@status, parse_reason=@reason`).run({...input, status, reason});
}

export function recordChatterEvent(input: {messageId: string; chatterId: number; guildId: string; channelId: string; type: "login"|"logout"; occurredAt: string}): void {
  getDb().prepare(`INSERT OR IGNORE INTO chatter_events
    (message_id,chatter_id,guild_id,channel_id,event_type,occurred_at) VALUES (?,?,?,?,?,?)`)
    .run(input.messageId,input.chatterId,input.guildId,input.channelId,input.type,input.occurredAt);
}

// ── Guild Config ──

/**
 * Get or create guild config.
 */
export function getGuildConfig(guildId: string): GuildConfig {
  const database = getDb();
  let row = database
    .prepare("SELECT * FROM guild_config WHERE guild_id = ?")
    .get(guildId) as GuildConfig | undefined;

  if (!row) {
    database
      .prepare("INSERT INTO guild_config (guild_id) VALUES (?)")
      .run(guildId);
    row = database
      .prepare("SELECT * FROM guild_config WHERE guild_id = ?")
      .get(guildId) as GuildConfig;
  }

  return row!;
}

/**
 * Add a report channel for a guild (additive — does not remove existing channels).
 * Also updates the legacy `report_channel_id` column for backward compat.
 */
export function setReportChannel(guildId: string, channelId: string): void {
  const database = getDb();

  // Ensure guild_config row exists
  getGuildConfig(guildId);

  // Insert into the new multi-channel table
  database
    .prepare(
      `INSERT OR IGNORE INTO report_channels (guild_id, channel_id)
       VALUES (?, ?)`,
    )
    .run(guildId, channelId);

  // Backward compat: also update the legacy column with the most recently set channel
  database
    .prepare(
      `UPDATE guild_config
       SET report_channel_id = ?, updated_at = datetime('now')
       WHERE guild_id = ?`,
    )
    .run(channelId, guildId);
}

/**
 * Remove a report channel from a guild.
 * Returns true if the channel was removed, false if it wasn't found.
 */
export function removeReportChannel(
  guildId: string,
  channelId: string,
): boolean {
  const database = getDb();
  const result = database
    .prepare("DELETE FROM report_channels WHERE guild_id = ? AND channel_id = ?")
    .run(guildId, channelId);
  return result.changes > 0;
}

/**
 * Get all report channels for a guild.
 * Returns an array of channel IDs (strings).
 */
export function getReportChannels(guildId: string): string[] {
  const database = getDb();
  const rows = database
    .prepare("SELECT channel_id FROM report_channels WHERE guild_id = ?")
    .all(guildId) as { channel_id: string }[];
  return rows.map((r) => r.channel_id);
}

// ── Chatters ──

/**
 * Get or create a chatter by Discord user ID.
 * Auto-creates a team for the guild if one doesn't exist.
 */
export function getOrCreateChatter(
  discordId: string,
  name: string,
  guildId: string,
): { id: number } {
  const database = getDb();

  let chatter = database
    .prepare("SELECT id FROM chatters WHERE discord_id = ?")
    .get(discordId) as { id: number } | undefined;

  if (chatter) return chatter;

  // Ensure team exists
  let team = database
    .prepare("SELECT id FROM teams WHERE discord_guild_id = ?")
    .get(guildId) as { id: number } | undefined;

  if (!team) {
    const result = database
      .prepare("INSERT INTO teams (name, discord_guild_id) VALUES (?, ?)")
      .run(guildId, guildId);
    team = { id: Number(result.lastInsertRowid) };
  }

  const result = database
    .prepare(
      "INSERT INTO chatters (discord_id, name, team_id) VALUES (?, ?, ?)",
    )
    .run(discordId, name, team.id);

  return { id: Number(result.lastInsertRowid) };
}

// ── Reports ──

/**
 * Look up a report by its Discord message ID.
 * Returns the report if it exists, or undefined.
 */
export function getReportByMessageId(
  messageId: string,
): ReportWriteResult | undefined {
  const database = getDb();
  return database
    .prepare("SELECT * FROM reports WHERE message_id = ?")
    .get(messageId) as ReportWriteResult | undefined;
}

/** Return the number of reports already present, for import summaries. */
export function getReportCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM reports").get() as { count: number };
  return Number(row.count);
}

/**
 * Insert a parsed report into the database.
 */
export function insertReport(
  chatterId: number,
  report: ParsedReport,
  messageId: string,
): ReportWriteResult {
  const database = getDb();

  const result = database
    .prepare(
      `INSERT INTO reports (chatter_id, reported_sales, reported_tips, shift_start, shift_end, message_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chatterId,
      report.reported_sales,
      report.reported_tips,
      report.shift_start,
      report.shift_end,
      messageId,
    );

  const inserted = database
    .prepare("SELECT * FROM reports WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as ReportWriteResult;

  return inserted!;
}
