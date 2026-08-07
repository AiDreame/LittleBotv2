import type { ChatInputCommandInteraction, Message, TextChannel, Channel, Collection } from "discord.js";
import { REST, Routes, SlashCommandBuilder as Builder, PermissionFlagsBits, MessageFlags } from "discord.js";
import { parseLogoutMessage, looksLikeLogoutReport, classifyLogoutMessage } from "./parser.js";
import {
  setReportChannel,
  removeReportChannel,
  getReportChannels,
  getOrCreateChatter,
  insertReport,
  getReportByMessageId,
  getReportCount,
  recordRawMessage,
  recordChatterEvent,
} from "./db.js";
import type { RawMessageInput } from "./db.js";

// ── Command Definitions ──

export const commands = [
  new Builder()
    .setName("help")
    .setDescription("List available commands and usage"),

  new Builder()
    .setName("ping")
    .setDescription("Check if the bot is online"),

  new Builder()
    .setName("set-channel")
    .setDescription("Set the channel where logout reports are monitored")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("The channel to watch for logout reports")
        .setRequired(true),
    ),

  new Builder()
    .setName("remove-channel")
    .setDescription("Remove a channel from the report watch list")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("The channel to stop watching")
        .setRequired(true),
    ),

  new Builder()
    .setName("report")
    .setDescription("Manually submit a logout report")
    .addNumberOption((opt) =>
      opt
        .setName("sales")
        .setDescription("Total sales amount in dollars")
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("shift")
        .setDescription("Shift time range (e.g., '2pm-10pm' or '14:00-22:00')")
        .setRequired(true),
    )
    .addNumberOption((opt) =>
      opt.setName("tips").setDescription("Total tips amount in dollars").setRequired(false),
    ),

  new Builder()
    .setName("status")
    .setDescription("Show bot configuration for this server"),

  new Builder()
    .setName("backfill")
    .setDescription("Scan historical messages and import any that look like logout reports")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("The channel to scan for logout reports")
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("limit")
        .setDescription("Maximum number of messages to scan (default 100, max 5000)")
        .setMinValue(1)
        .setMaxValue(5000)
        .setRequired(false),
    ),

  new Builder()
    .setName("update-reports")
    .setDescription("Scan all configured report channels and import any new logout reports")
    .addIntegerOption((opt) =>
      opt
        .setName("limit")
        .setDescription("Optional bound per channel; omit to scan all available history")
        .setMinValue(1)
        .setMaxValue(5000)
        .setRequired(false),
    ),
];

// ── Command Handlers ──

// Shared by /backfill and /update-reports so both scan with identical rules:
// raw source retention, bot-message skip, pre-filter, parse, dedupe, insert,
// chatter event, and ✅ reaction (capped to avoid rate limits).

export type ImportCounters = {
  fetched: number;
  scanned: number;
  imported: number;
  rawRetained: number;
  parsedReports: number;
  unsupported: number;
  duplicates: number;
  botMessages: number;
  errors: number;
  /** Chatter logout events recorded (reports + event-only messages). */
  logoutEvents: number;
  /** Reports with zero sales, including explicit and inferred zero earnings. */
  zeroEarningsReports: number;
  /** Clear logout events converted to an inferred $0 report. */
  eventOnlyZero: number;
};

export function newImportCounters(): ImportCounters {
  return { fetched: 0, scanned: 0, imported: 0, rawRetained: 0, parsedReports: 0, unsupported: 0, duplicates: 0, botMessages: 0, errors: 0, logoutEvents: 0, zeroEarningsReports: 0, eventOnlyZero: 0 };
}

export function counterSummary(c: ImportCounters): string {
  return `fetched=${c.fetched} scanned=${c.scanned} rawRetained=${c.rawRetained} newlyImported=${c.imported} unsupported=${c.unsupported} duplicates=${c.duplicates} botMessages=${c.botMessages} errors=${c.errors} logoutEvents=${c.logoutEvents} zeroEarningsReports=${c.zeroEarningsReports} eventOnlyZero=${c.eventOnlyZero}`;
}

function rawInputFor(message: Message): RawMessageInput {
  return {
    message_id: message.id,
    guild_id: message.guildId ?? "",
    channel_id: message.channelId,
    author_id: message.author.id,
    author_name: message.author.displayName ?? message.author.username,
    message_created_at: message.createdAt.toISOString(),
    content: message.content,
  };
}

/**
 * Run one fetched message through the full import pipeline.
 * Raw source retention happens before all filters; content is stored only in
 * the private DB. Aggregate counters are never logged per-message.
 *
 * Event extraction is separate from sales-report parsing: every message with
 * a clear !logout marker records a chatter logout event (timestamp + author)
 * even when no supported earnings/model fields exist. A sales report is only
 * inserted when an explicit supported Earnings amount is present; messages
 * with a logout marker but no supported amount stay raw and are classified
 * `logout_event_only_no_earnings`.
 */
export async function importMessage(
  message: Message,
  counters: ImportCounters,
  maxReactions: number,
): Promise<void> {
  counters.fetched++;
  counters.scanned++;
  const raw = rawInputFor(message);
  recordRawMessage(raw, "unparsed", "fetched");
  counters.rawRetained++;

  // Bot messages are retained but never interpreted as sales.
  if (message.author.bot) {
    recordRawMessage(raw, "unparsed", "bot_message");
    counters.botMessages++;
    return;
  }

  // ── Clear !logout marker → always at least a chatter logout event ──
  const cls = classifyLogoutMessage(message.content, message.createdAt);
  if (cls.kind !== "not_logout") {
    try {
      const chatter = getOrCreateChatter(
        message.author.id,
        message.author.displayName ?? message.author.username,
        message.guildId ?? "",
      );
      recordChatterEvent({messageId: message.id, chatterId: chatter.id, guildId: message.guildId ?? "",
        channelId: message.channelId, type: "logout", occurredAt: message.createdAt.toISOString()});
      counters.logoutEvents++;
    } catch (err) {
      console.error(`Error recording logout event for message ${message.id}:`, err);
      recordRawMessage(raw, "unparsed", "logout_event_error");
      counters.errors++;
    }

    // Supported earnings amount, or a conservative inferred $0 for a clear logout → report.
    if (cls.kind === "report") {
      const existing = getReportByMessageId(message.id);
      if (existing) {
        recordRawMessage(raw, "parsed", "duplicate_report");
        counters.duplicates++;
        return;
      }
      try {
        const chatter = getOrCreateChatter(
          message.author.id,
          message.author.displayName ?? message.author.username,
          message.guildId ?? "",
        );
        insertReport(chatter.id, cls.report, message.id);
        recordRawMessage(raw, "parsed", "imported");
        counters.parsedReports++;
        counters.imported++;
        if (cls.report.reported_sales === 0 && cls.report.reported_tips === 0) {
          counters.zeroEarningsReports++;
          if (cls.report.earnings_source === "inferred_zero") counters.eventOnlyZero++;
        }

        // React with ✅ on the imported message (cap to avoid rate limits)
        if (counters.imported <= maxReactions) {
          await message.react("✅").catch(() => {});
          await sleep(100);
        }
      } catch (err) {
        console.error(`Error importing message ${message.id}:`, err);
        recordRawMessage(raw, "unparsed", "import_error");
        counters.errors++;
      }
      return;
    }

    // Defensive fallback; classifyLogoutMessage currently converts every clear marker to a report.
    recordRawMessage(raw, "unparsed", "logout_event_only_no_earnings");
    counters.unsupported++;
    return;
  }

  // ── No logout marker: standard keyword report format ──
  // Quick pre-filter. Keep the source row even when unsupported.
  if (!looksLikeLogoutReport(message.content)) {
    recordRawMessage(raw, "unparsed", "unsupported_format");
    counters.unsupported++;
    return;
  }

  const parsed = parseLogoutMessage(message.content, message.createdAt);
  if (!parsed) {
    recordRawMessage(raw, "unparsed", "unsupported_report_shape");
    counters.unsupported++;
    return;
  }

  // Check for duplicate
  const existing = getReportByMessageId(message.id);
  if (existing) {
    recordRawMessage(raw, "parsed", "duplicate_report");
    counters.duplicates++;
    return;
  }

  // Get or create chatter and insert
  try {
    const chatter = getOrCreateChatter(
      message.author.id,
      message.author.displayName ?? message.author.username,
      message.guildId ?? "",
    );
    insertReport(chatter.id, parsed, message.id);
    recordRawMessage(raw, "parsed", "imported");
    counters.parsedReports++;
    recordChatterEvent({messageId: message.id, chatterId: chatter.id, guildId: message.guildId ?? "",
      channelId: message.channelId, type: "logout", occurredAt: message.createdAt.toISOString()});
    counters.logoutEvents++;
    counters.imported++;

    // React with ✅ on the imported message (cap to avoid rate limits)
    if (counters.imported <= maxReactions) {
      await message.react("✅").catch(() => {});
      await sleep(100);
    }
  } catch (err) {
    console.error(
      `Error importing message ${message.id}:`,
      err,
    );
    recordRawMessage(raw, "unparsed", "import_error");
    counters.errors++;
  }
}

// ── Scan job plumbing (shared by /backfill and /update-reports) ──

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One active scan per guild so long scans can't pile up on the same DB. */
const activeScanJobs = new Map<string, boolean>();

/** Hard ceiling for any reply/status text (Discord's message limit is 2000). */
const MAX_REPLY_CHARS = 1900;

/**
 * Walk a channel's history one 100-message page at a time, handing each page
 * to `onPage` as it is fetched. Bounded scans stop at `limit`; unbounded scans
 * walk the whole history. Only one page is ever held in memory at a time, and
 * a short pause between pages keeps the messages-fetch rate-limit bucket in
 * headroom (discord.js already backs off and retries on 429s).
 */
async function walkHistoryPages(
  channel: TextChannel,
  limit: number | undefined,
  onPage: (page: Collection<string, Message>) => Promise<void>,
): Promise<void> {
  let before: string | undefined;
  let fetched = 0;
  while (limit === undefined || fetched < limit) {
    const want = limit === undefined ? 100 : Math.min(100, limit - fetched);
    const page = await channel.messages.fetch({
      limit: want,
      ...(before ? { before } : {}),
    });
    if (page.size === 0) break;
    await onPage(page);
    fetched += page.size;
    const oldest = page.last();
    if (!oldest || page.size < want) break;
    before = oldest.id;
    await sleep(250);
  }
}

/** Compact per-channel result line, kept short so 10+ channels fit in 2000 chars. */
function channelResultLine(
  ok: boolean,
  channelId: string,
  scopeLabel: string,
  c: ImportCounters,
): string {
  if (!ok) return `❌ <#${channelId}> — ${scopeLabel} failed`;
  return (
    `✅ <#${channelId}> — ${scopeLabel}; fetched ${c.fetched}, ` +
    `new ${c.imported}, dups ${c.duplicates}, logout ${c.logoutEvents}, ` +
    `unsup ${c.unsupported}, err ${c.errors}`
  );
}

/** Build a ≤2000-char final summary from per-channel lines plus totals. */
function buildScanSummary(opts: {
  title: string;
  perChannel: string[];
  channelsOk: number;
  channelsFailed: number;
  totals: ImportCounters;
  existingReports: number;
  note?: string;
}): string {
  const lines = [
    opts.title,
    "",
    ...opts.perChannel,
    "",
    `**Totals (${opts.channelsOk} updated, ${opts.channelsFailed} failed):** ${counterSummary(opts.totals)}`,
    `**Reports in database before scan:** ${opts.existingReports}. **New reports imported:** ${opts.totals.imported}.`,
  ];
  if (opts.note) lines.push("", opts.note);
  return lines.join("\n").slice(0, MAX_REPLY_CHARS);
}

function commandUsage(command: (typeof commands)[number]): string {
  const data = command.toJSON();
  const options = (data.options ?? [])
    .map((option) => (option.required ? `<${option.name}>` : `[${option.name}]`))
    .join(" ");
  return `/${data.name}${options ? ` ${options}` : ""}`;
}

export async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const lines = ["📖 **LittleBot Commands**", ""];
  for (const command of commands) {
    const data = command.toJSON();
    lines.push(`**${commandUsage(command)}** — ${data.description}`);
  }

  await interaction.reply({
    content: lines.join("\n"),
    ephemeral: true,
  });
}

export async function handlePing(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    content: "🏓 LittleBot is running!",
    ephemeral: true,
  });
}

export async function handleSetChannel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  setReportChannel(interaction.guildId, channel.id);

  await interaction.reply({
    content: `✅ <#${channel.id}> added to the report watch list.`,
    ephemeral: true,
  });
}

export async function handleRemoveChannel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  const removed = removeReportChannel(interaction.guildId, channel.id);

  if (removed) {
    await interaction.reply({
      content: `✅ <#${channel.id}> removed from the report watch list.`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: `⚠️ <#${channel.id}> was not in the report watch list.`,
      ephemeral: true,
    });
  }
}

export async function handleReport(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const sales = interaction.options.getNumber("sales", true);
  const tips = interaction.options.getNumber("tips", false) ?? 0;
  const shiftRaw = interaction.options.getString("shift", true);

  // Parse the shift string like "2pm-10pm"
  const parsed = parseLogoutMessage(
    `sales ${sales} tips ${tips} shift ${shiftRaw}`,
  );

  if (!parsed) {
    await interaction.reply({
      content:
        "❌ Could not parse the shift time. Use formats like '2pm-10pm', '14:00-22:00', or '2pm to 10pm'.",
      ephemeral: true,
    });
    return;
  }

  // Get or create chatter and insert report
  const chatter = getOrCreateChatter(
    interaction.user.id,
    interaction.user.displayName ?? interaction.user.username,
    interaction.guildId,
  );

  const result = insertReport(chatter.id, parsed, interaction.id);

  await interaction.reply({
    content: [
      "✅ Report submitted!",
      "",
      `**Sales:** $${parsed.reported_sales.toLocaleString()}`,
      `**Tips:** $${parsed.reported_tips.toLocaleString()}`,
      `**Shift:** ${parsed.shift_start} – ${parsed.shift_end}`,
      `**DB ID:** #${result.id}`,
    ].join("\n"),
    ephemeral: true,
  });
}

export async function handleStatus(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const channels = getReportChannels(interaction.guildId);

  const lines = ["📊 **LittleBot Status**", ""];

  if (channels.length === 0) {
    lines.push(
      "**Report channels:** None configured (use /set-channel to add one)",
    );
  } else {
    lines.push(`**Report channels (${channels.length}):**`);
    for (const ch of channels) {
      lines.push(`  • <#${ch}>`);
    }
  }

  lines.push("");
  lines.push(`**Guild ID:** ${interaction.guildId}`);

  await interaction.reply({
    content: lines.join("\n"),
    ephemeral: true,
  });
}

export async function handleBackfill(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Defer immediately to buy time for the scan
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // ── Permission check ──
  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.editReply({
      content:
        "❌ You need the **Manage Server** permission to use this command.",
    });
    return;
  }

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  const limit =
    interaction.options.getInteger("limit", false) ?? 100;

  // Must be a text-based channel
  if (!("messages" in channel)) {
    console.log(
      `[backfill] ${interaction.guildId}: requested channel ${channel.id} ` +
        `(name "${channel.name}", type ${channel.type}) is not text-based — aborting.`,
    );
    await interaction.editReply({
      content: "❌ The selected channel must be a text channel.",
    });
    return;
  }

  // ── Diagnostic logging (aggregate only — never message content) ──
  // Records channel identity + the bot's permissions in it + fetch outcome so
  // a "0 imported" result can be diagnosed from .run/bot.log alone.
  const botPerms = channel.permissionsFor?.(interaction.client.user?.id);
  const permFlags = {
    viewChannel: !!botPerms?.has(PermissionFlagsBits.ViewChannel),
    readMessageHistory: !!botPerms?.has(
      PermissionFlagsBits.ReadMessageHistory,
    ),
    addReactions: !!botPerms?.has(PermissionFlagsBits.AddReactions),
    manageGuild: !!interaction.memberPermissions?.has(
      PermissionFlagsBits.ManageGuild,
    ),
  };
  console.log(
    `[backfill] guild=${interaction.guildId} channel=${channel.id} ` +
      `name="${channel.name}" type=${channel.type} limit=${limit} ` +
      `perms=${JSON.stringify(permFlags)}`,
  );

  // ── Scan concurrency guard ──
  // One scan per guild at a time: concurrent scans would pile synchronous DB
  // writes and reaction bursts on the same connection and rate-limit buckets.
  if (activeScanJobs.get(interaction.guildId)) {
    await interaction.editReply({
      content:
        "⏳ A report scan is already running in this server. Wait for it to finish, then try again.",
    });
    return;
  }
  activeScanJobs.set(interaction.guildId, true);

  const existingReports = getReportCount();

  // Acknowledge immediately, then run the scan as a detached job with a live
  // status message — a large scan can outlive the 15-minute interaction
  // window, so the job must not be tied to it (and its failure must never
  // take the gateway down).
  await interaction
    .editReply({
      content:
        `⏳ **Backfill started** — scanning <#${channel.id}> (limit ${limit}). ` +
        `Progress will appear in <#${interaction.channelId}>.`,
    })
    .catch(() => {});

  void runBackfillJob(interaction, channel as TextChannel, limit, existingReports).catch(
    (err) =>
      console.error(
        `[backfill] guild=${interaction.guildId} job failed:`,
        err?.message ?? err,
      ),
  );
}

/**
 * Background backfill job: streams the channel page by page, imports every
 * message with the shared raw-retention/parse/dedupe rules, posts throttled
 * progress, and finishes with a compact final summary. Never rejects.
 */
async function runBackfillJob(
  interaction: ChatInputCommandInteraction,
  channel: TextChannel,
  limit: number,
  existingReports: number,
): Promise<void> {
  const guildId = interaction.guildId!;
  const startedAt = Date.now();
  const statusSender =
    interaction.channel && "send" in interaction.channel
      ? (interaction.channel as unknown as {
          send: (o: { content: string }) => Promise<Message>;
        })
      : null;
  let statusMessage: Message | null = statusSender
    ? await statusSender.send({ content: "⏳ Backfill starting…" }).catch(() => null)
    : null;
  const updateStatus = async (text: string): Promise<void> => {
    const clipped = text.slice(0, MAX_REPLY_CHARS);
    if (statusMessage) {
      await statusMessage.edit({ content: clipped }).catch(() => {});
    } else {
      await interaction.editReply({ content: clipped }).catch(() => {});
    }
  };

  const counters = newImportCounters();
  let lastStatusAt = 0;
  try {
    await walkHistoryPages(channel, limit, async (page) => {
      for (const [, message] of page) await importMessage(message, counters, 50);
      if (Date.now() - lastStatusAt > 15_000) {
        lastStatusAt = Date.now();
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        await updateStatus(
          `⏳ **Backfill in progress** (${elapsed}s) — <#${channel.id}>: ` +
            `fetched ${counters.fetched}, new ${counters.imported}, dups ${counters.duplicates}, err ${counters.errors}…`,
        );
      }
    });
  } catch (err) {
    console.error(
      `[backfill] guild=${interaction.guildId} channel=${channel.id} fetch failed:`,
      err,
    );
    await updateStatus(
      `❌ **Backfill failed** — could not read message history in <#${channel.id}> (check LittleBot's **Read Message History** permission there).`,
    );
    return;
  } finally {
    activeScanJobs.delete(guildId);
  }

  console.log(
    `[backfill] guild=${interaction.guildId} channel=${channel.id} ${counterSummary(counters)}`,
  );

  const lines = [
    "📊 **Backfill Complete**",
    "",
    `**Channel:** <#${channel.id}>`,
    `**Fetched / scanned:** ${counters.fetched} / ${counters.scanned}`,
    `**Raw retained:** ${counters.rawRetained}`,
    `**Parsed / imported:** ${counters.parsedReports} / ${counters.imported}`,
    `**Unsupported:** ${counters.unsupported} · **Duplicates:** ${counters.duplicates} · **Bot messages:** ${counters.botMessages} · **Errors:** ${counters.errors}`,
    `**Reports in database before scan:** ${existingReports}. **New reports imported:** ${counters.imported}.`,
  ];

  if (counters.imported > 50) {
    lines.push(
      "",
      `_✅ reactions were only applied to the first 50 imported messages to avoid rate limits._`,
    );
  }

  const summary = lines.join("\n").slice(0, MAX_REPLY_CHARS);
  await updateStatus(summary);
  // Refresh the invoker's ephemeral reply too (silently ignored once the
  // interaction window expires — the status message carries the result).
  await interaction.editReply({ content: summary }).catch(() => {});
  console.log(
    `[backfill] guild=${interaction.guildId} channel=${channel.id} job complete in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
}

export async function handleUpdateReports(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Defer immediately to acknowledge the command.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // ── Permission check (same as /backfill) ──
  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.editReply({
      content:
        "❌ You need the **Manage Server** permission to use this command.",
    });
    return;
  }

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  const limit = interaction.options.getInteger("limit", false) ?? undefined;

  // ── Discover all configured report channels ──
  const channelIds = getReportChannels(interaction.guildId);
  const existingReports = getReportCount();
  const scope = limit === undefined ? "full_history" : `bounded_per_channel_${limit}`;
  console.log(
    `[update-reports] guild=${interaction.guildId} configuredChannels=${channelIds.length} scan=${scope}`,
  );

  if (channelIds.length === 0) {
    await interaction.editReply({
      content: [
        "ℹ️ **No report channels configured.**",
        "",
        "Add one or more channels to the watch list with `/set-channel`, then run `/update-reports` again.",
      ].join("\n"),
    });
    return;
  }

  // ── Scan concurrency guard (shared with /backfill) ──
  if (activeScanJobs.get(interaction.guildId)) {
    await interaction.editReply({
      content:
        "⏳ A report scan is already running in this server. Watch the channel for progress, then try again once it finishes.",
    });
    return;
  }
  activeScanJobs.set(interaction.guildId, true);

  // Acknowledge immediately, then run the scan as a detached job with a live
  // status message. A full-history scan of large channels takes far longer
  // than the 15-minute interaction window, so the job is deliberately not
  // tied to the interaction — and its failures must never take the gateway
  // down.
  await interaction
    .editReply({
      content:
        `⏳ **Report update started** — scanning ${channelIds.length} channel(s) ` +
        `(${limit === undefined ? "full history" : `bounded to ${limit} per channel`}). ` +
        `Progress and a final summary will appear in <#${interaction.channelId}>.`,
    })
    .catch(() => {});

  void runUpdateReportsJob(interaction, channelIds, limit, existingReports).catch(
    (err) =>
      console.error(
        `[update-reports] guild=${interaction.guildId} job failed:`,
        err?.message ?? err,
      ),
  );
}

/**
 * Background update-reports job: streams every configured channel page by
 * page (bounded memory), isolates per-channel/per-page failures so one bad
 * channel cannot abort the rest, paces fetches/reactions to stay inside
 * Discord rate limits, posts throttled progress, and finishes with a compact
 * ≤2000-char final summary. Never rejects.
 */
async function runUpdateReportsJob(
  interaction: ChatInputCommandInteraction,
  channelIds: string[],
  limit: number | undefined,
  existingReports: number,
): Promise<void> {
  const guildId = interaction.guildId!;
  const startedAt = Date.now();
  const statusSender =
    interaction.channel && "send" in interaction.channel
      ? (interaction.channel as unknown as {
          send: (o: { content: string }) => Promise<Message>;
        })
      : null;
  let statusMessage: Message | null = statusSender
    ? await statusSender.send({ content: "⏳ Report scan starting…" }).catch(() => null)
    : null;
  const updateStatus = async (text: string): Promise<void> => {
    const clipped = text.slice(0, MAX_REPLY_CHARS);
    if (statusMessage) {
      await statusMessage.edit({ content: clipped }).catch(() => {});
    } else {
      await interaction.editReply({ content: clipped }).catch(() => {});
    }
  };

  const perChannelLines: string[] = [];
  const totals = newImportCounters();
  let channelsOk = 0;
  let channelsFailed = 0;
  let lastStatusAt = 0;

  try {
    for (const channelId of channelIds) {
      // Resolve the channel (may be null if deleted or the bot lost access).
      let channel: Channel | null = null;
      try {
        channel = await interaction.client.channels.fetch(channelId);
      } catch {
        channel = null;
      }

      // Must be a text-based channel
      if (!channel || !("messages" in channel)) {
        channelsFailed++;
        perChannelLines.push(
          `❌ <#${channelId}> — not available (deleted, or the bot lost access to it)`,
        );
        console.log(
          `[update-reports] guild=${guildId} channel=${channelId} failed=channel_unavailable`,
        );
        continue;
      }

      const textChannel = channel as TextChannel;
      const botPerms = textChannel.permissionsFor?.(interaction.client.user?.id);
      const permFlags = {
        viewChannel: !!botPerms?.has(PermissionFlagsBits.ViewChannel),
        readMessageHistory: !!botPerms?.has(
          PermissionFlagsBits.ReadMessageHistory,
        ),
        addReactions: !!botPerms?.has(PermissionFlagsBits.AddReactions),
      };
      console.log(
        `[update-reports] guild=${guildId} channel=${channel.id} ` +
          `name="${textChannel.name}" type=${textChannel.type} limit=${limit} ` +
          `perms=${JSON.stringify(permFlags)}`,
      );

      // ── Stream the channel one page at a time (bounded memory) ──
      const counters = newImportCounters();
      let fetchFailed = false;
      try {
        await walkHistoryPages(textChannel, limit, async (page) => {
          for (const [, message] of page) await importMessage(message, counters, 50);
          if (Date.now() - lastStatusAt > 15_000) {
            lastStatusAt = Date.now();
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            await updateStatus(
              `⏳ **Report scan in progress** (${elapsed}s) — channels done: ${channelsOk}/${channelIds.length}; ` +
                `<#${channel.id}> fetched ${counters.fetched}, new ${counters.imported}…`,
            );
          }
        });
      } catch (err) {
        fetchFailed = true;
        console.error(
          `[update-reports] guild=${guildId} channel=${channel.id} fetch failed:`,
          err,
        );
      }

      // Isolated per-channel failure: other channels still update.
      if (fetchFailed) {
        channelsFailed++;
        perChannelLines.push(
          `❌ <#${channel.id}> — could not read message history (check LittleBot's **Read Message History** permission there)`,
        );
        continue;
      }
      console.log(
        `[update-reports] guild=${guildId} channel=${channel.id} fetched=${counters.fetched} messages`,
      );

      for (const key of ["fetched", "scanned", "imported", "rawRetained", "parsedReports", "unsupported", "duplicates", "botMessages", "errors", "logoutEvents", "zeroEarningsReports", "eventOnlyZero"] as const) totals[key] += counters[key];
      channelsOk++;
      perChannelLines.push(
        channelResultLine(
          true,
          channel.id,
          limit === undefined ? "full history" : `bounded to ${limit}`,
          counters,
        ),
      );

      console.log(
        `[update-reports] guild=${guildId} channel=${channel.id} ${counterSummary(counters)}`,
      );
    }

    const summary = buildScanSummary({
      title: "📊 **Report Update Complete**",
      perChannel: perChannelLines,
      channelsOk,
      channelsFailed,
      totals,
      existingReports,
      note:
        totals.imported > 50
          ? "_✅ reactions were only applied to the first 50 imported messages per channel to avoid rate limits._"
          : undefined,
    });
    await updateStatus(summary);
    // Refresh the invoker's ephemeral reply too (silently ignored once the
    // interaction window expires — the status message carries the result).
    await interaction.editReply({ content: summary }).catch(() => {});
    console.log(
      `[update-reports] guild=${guildId} job complete in ${Math.round((Date.now() - startedAt) / 1000)}s — ${counterSummary(totals)} (${channelsOk} ok, ${channelsFailed} failed)`,
    );
  } finally {
    activeScanJobs.delete(guildId);
  }
}

// ── Command Router ──

const handlerMap: Record<
  string,
  (interaction: ChatInputCommandInteraction) => Promise<void>
> = {
  help: handleHelp,
  ping: handlePing,
  "set-channel": handleSetChannel,
  "remove-channel": handleRemoveChannel,
  report: handleReport,
  status: handleStatus,
  backfill: handleBackfill,
  "update-reports": handleUpdateReports,
};

export async function routeCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const handler = handlerMap[interaction.commandName];
  if (handler) {
    await handler(interaction);
  }
}

// ── Command Registration ──

/**
 * Register slash commands with Discord.
 * Called once on bot startup.
 */
export async function registerCommands(
  rest: REST,
  clientId: string,
): Promise<void> {
  const body = commands.map((cmd) => cmd.toJSON());
  try {
    console.log(`Registering ${body.length} global slash commands...`);
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log("Slash commands registered successfully.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
}
