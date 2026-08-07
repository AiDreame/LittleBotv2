import type { ChatInputCommandInteraction, Message, TextChannel, Channel } from "discord.js";
import { REST, Routes, SlashCommandBuilder as Builder, PermissionFlagsBits, MessageFlags } from "discord.js";
import { parseLogoutMessage, looksLikeLogoutReport } from "./parser.js";
import {
  setReportChannel,
  removeReportChannel,
  getReportChannels,
  getOrCreateChatter,
  insertReport,
  getReportByMessageId,
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
        .setDescription("Maximum messages to scan per channel (default 100, max 5000)")
        .setMinValue(1)
        .setMaxValue(5000)
        .setRequired(false),
    ),
];

// ── Command Handlers ──

// Shared by /backfill and /update-reports so both scan with identical rules:
// raw source retention, bot-message skip, pre-filter, parse, dedupe, insert,
// chatter event, and ✅ reaction (capped to avoid rate limits).

type ImportCounters = {
  scanned: number;
  imported: number;
  skipped: number;
  skipReasons: {
    botMessages: number;
    preFilter: number;
    parseFailed: number;
    alreadyImported: number;
    insertError: number;
  };
};

function newImportCounters(): ImportCounters {
  return {
    scanned: 0,
    imported: 0,
    skipped: 0,
    skipReasons: {
      botMessages: 0,
      preFilter: 0,
      parseFailed: 0,
      alreadyImported: 0,
      insertError: 0,
    },
  };
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
 */
async function importMessage(
  message: Message,
  counters: ImportCounters,
  maxReactions: number,
): Promise<void> {
  counters.scanned++;
  recordRawMessage(rawInputFor(message), "fetched", null);

  // Skip bot messages
  if (message.author.bot) {
    recordRawMessage(rawInputFor(message), "skipped", "bot_message");
    counters.skipped++;
    counters.skipReasons.botMessages++;
    return;
  }

  // Quick pre-filter
  if (!looksLikeLogoutReport(message.content)) {
    recordRawMessage(rawInputFor(message), "skipped", "does_not_look_like_report");
    counters.skipped++;
    counters.skipReasons.preFilter++;
    return;
  }

  // Parse
  const parsed = parseLogoutMessage(message.content, message.createdAt);
  if (!parsed) {
    recordRawMessage(rawInputFor(message), "failed", "report_shape_not_supported");
    counters.skipped++;
    counters.skipReasons.parseFailed++;
    return;
  }

  // Check for duplicate
  const existing = getReportByMessageId(message.id);
  if (existing) {
    counters.skipped++;
    counters.skipReasons.alreadyImported++;
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
    recordRawMessage(rawInputFor(message), "parsed", null);
    recordChatterEvent({messageId: message.id, chatterId: chatter.id, guildId: message.guildId ?? "",
      channelId: message.channelId, type: "logout", occurredAt: message.createdAt.toISOString()});
    counters.imported++;

    // React with ✅ on the imported message (cap to avoid rate limits)
    if (counters.imported <= maxReactions) {
      await message.react("✅").catch(() => {});
    }
  } catch (err) {
    console.error(
      `Error importing message ${message.id}:`,
      err,
    );
    counters.skipped++;
    counters.skipReasons.insertError++;
  }
}

/**
 * Fetch up to `limit` messages from a text channel.
 * Discord's history endpoint returns at most 100 messages per request. A
 * single fetch({ limit }) therefore silently stops at the API page size;
 * walk backwards with `before` until the requested scan limit is reached.
 */
async function fetchChannelHistory(
  channel: TextChannel,
  limit: number,
): Promise<Map<string, Message>> {
  const messages = new Map<string, Message>();
  let before: string | undefined;
  while (messages.size < limit) {
    const page = await channel.messages.fetch({
      limit: Math.min(100, limit - messages.size),
      ...(before ? { before } : {}),
    });
    if (page.size === 0) break;
    for (const [id, message] of page) messages.set(id, message);
    const oldest = page.last();
    if (!oldest || page.size < Math.min(100, limit - (messages.size - page.size))) break;
    before = oldest.id;
  }
  return messages;
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

  // ── Fetch messages ──
  // Paginate backwards with `before` up to the requested scan limit (the
  // history endpoint only returns 100 messages per request).
  const textChannel = channel as TextChannel;
  let messages: Map<string, Message>;
  try {
    messages = await fetchChannelHistory(textChannel, limit);
  } catch (err) {
    console.error("Backfill message fetch failed:", err);
    await interaction.editReply({
      content:
        "❌ Could not read message history in that channel. Make sure LittleBot has **Read Message History** permission there, then try again.",
    });
    return;
  }
  console.log(
    `[backfill] guild=${interaction.guildId} channel=${channel.id} fetched=${messages.size} messages`,
  );

  // Process each message with the shared raw-retention/parse/dedupe rules.
  const counters = newImportCounters();
  for (const [, message] of messages) {
    await importMessage(message, counters, 50);
  }

  console.log(
    `[backfill] guild=${interaction.guildId} channel=${channel.id} ` +
      `scanned=${counters.scanned} imported=${counters.imported} skipped=${counters.skipped} ` +
      `byReason=${JSON.stringify(counters.skipReasons)}`,
  );

  const lines = [
    "📊 **Backfill Complete**",
    "",
    `**Channel:** <#${channel.id}>`,
    `**Scanned:** ${counters.scanned} messages`,
    `**Imported:** ${counters.imported} reports`,
    `**Skipped:** ${counters.skipped} messages`,
  ];

  if (counters.imported > 50) {
    lines.push(
      "",
      `_✅ reactions were only applied to the first 50 imported messages to avoid rate limits._`,
    );
  }

  await interaction.editReply({ content: lines.join("\n") });
}

export async function handleUpdateReports(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Defer immediately to buy time for the scans (same pattern as /backfill).
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

  const limit =
    interaction.options.getInteger("limit", false) ?? 100;

  // ── Discover all configured report channels ──
  const channelIds = getReportChannels(interaction.guildId);
  console.log(
    `[update-reports] guild=${interaction.guildId} configuredChannels=${channelIds.length} limit=${limit}`,
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

  const perChannelLines: string[] = [];
  let channelsOk = 0;
  let channelsFailed = 0;
  const totals = { scanned: 0, imported: 0, skipped: 0 };
  let anyImportedOver50 = false;

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
        `[update-reports] guild=${interaction.guildId} channel=${channelId} failed=channel_unavailable`,
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
      `[update-reports] guild=${interaction.guildId} channel=${channel.id} ` +
        `name="${textChannel.name}" type=${textChannel.type} limit=${limit} ` +
        `perms=${JSON.stringify(permFlags)}`,
    );

    // ── Fetch messages (same safe pagination as /backfill) ──
    let messages: Map<string, Message>;
    try {
      messages = await fetchChannelHistory(textChannel, limit);
    } catch (err) {
      console.error(
        `[update-reports] guild=${interaction.guildId} channel=${channel.id} fetch failed:`,
        err,
      );
      channelsFailed++;
      perChannelLines.push(
        `❌ <#${channel.id}> — could not read message history (check LittleBot's **Read Message History** permission there)`,
      );
      continue;
    }
    console.log(
      `[update-reports] guild=${interaction.guildId} channel=${channel.id} fetched=${messages.size} messages`,
    );

    // ── Import with the same raw-retention/parse/dedupe rules as /backfill ──
    const counters = newImportCounters();
    for (const [, message] of messages) {
      await importMessage(message, counters, 50);
    }

    totals.scanned += counters.scanned;
    totals.imported += counters.imported;
    totals.skipped += counters.skipped;
    channelsOk++;
    if (counters.imported > 50) anyImportedOver50 = true;

    console.log(
      `[update-reports] guild=${interaction.guildId} channel=${channel.id} ` +
        `scanned=${counters.scanned} imported=${counters.imported} skipped=${counters.skipped} ` +
        `byReason=${JSON.stringify(counters.skipReasons)}`,
    );

    perChannelLines.push(
      `✅ <#${channel.id}> — scanned ${counters.scanned}, imported ${counters.imported}, skipped ${counters.skipped}`,
    );
  }

  const lines = [
    "📊 **Report Update Complete**",
    "",
    ...perChannelLines,
    "",
    `**Totals:** ${channelsOk} channel(s) updated, ${channelsFailed} failed — ` +
      `scanned ${totals.scanned}, imported ${totals.imported}, skipped ${totals.skipped}`,
  ];
  if (anyImportedOver50) {
    lines.push(
      "",
      `_✅ reactions were only applied to the first 50 imported messages per channel to avoid rate limits._`,
    );
  }

  await interaction.editReply({ content: lines.join("\n") });
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
