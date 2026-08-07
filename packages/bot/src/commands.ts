import type { ChatInputCommandInteraction, TextChannel } from "discord.js";
import { REST, Routes, SlashCommandBuilder as Builder, PermissionFlagsBits, MessageFlags } from "discord.js";
import { parseLogoutMessage, looksLikeLogoutReport } from "./parser.js";
import {
  setReportChannel,
  removeReportChannel,
  getReportChannels,
  getOrCreateChatter,
  insertReport,
  getReportByMessageId,
} from "./db.js";

// ── Command Definitions ──

export const commands = [
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
        .setDescription("Maximum number of messages to scan (default 100, max 500)")
        .setMinValue(1)
        .setMaxValue(500)
        .setRequired(false),
    ),
];

// ── Command Handlers ──

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
    await interaction.editReply({
      content: "❌ The selected channel must be a text channel.",
    });
    return;
  }

  // ── Fetch messages ──
  const textChannel = channel as TextChannel;
  let messages;
  try {
    messages = await textChannel.messages.fetch({
      limit: Math.min(limit, 500),
    });
  } catch (err) {
    console.error("Backfill message fetch failed:", err);
    await interaction.editReply({
      content:
        "❌ Could not read message history in that channel. Make sure LittleBot has **Read Message History** permission there, then try again.",
    });
    return;
  }

  let scanned = 0;
  let imported = 0;
  let skipped = 0;

  for (const [, message] of messages) {
    scanned++;

    // Skip bot messages
    if (message.author.bot) {
      skipped++;
      continue;
    }

    // Quick pre-filter
    if (!looksLikeLogoutReport(message.content)) {
      skipped++;
      continue;
    }

    // Parse
    const parsed = parseLogoutMessage(message.content, message.createdAt);
    if (!parsed) {
      skipped++;
      continue;
    }

    // Check for duplicate
    const existing = getReportByMessageId(message.id);
    if (existing) {
      skipped++;
      continue;
    }

    // Get or create chatter and insert
    try {
      const chatter = getOrCreateChatter(
        message.author.id,
        message.author.displayName ?? message.author.username,
        interaction.guildId,
      );
      insertReport(chatter.id, parsed, message.id);
      imported++;

      // React with ✅ on the imported message (cap at 50 to avoid rate limits)
      if (imported <= 50) {
        await message.react("✅").catch(() => {});
      }
    } catch (err) {
      console.error(
        `Error importing message ${message.id}:`,
        err,
      );
      skipped++;
    }
  }

  const lines = [
    "📊 **Backfill Complete**",
    "",
    `**Channel:** <#${channel.id}>`,
    `**Scanned:** ${scanned} messages`,
    `**Imported:** ${imported} reports`,
    `**Skipped:** ${skipped} messages`,
  ];

  if (imported > 50) {
    lines.push(
      "",
      `_✅ reactions were only applied to the first 50 imported messages to avoid rate limits._`,
    );
  }

  await interaction.editReply({ content: lines.join("\n") });
}

// ── Command Router ──

const handlerMap: Record<
  string,
  (interaction: ChatInputCommandInteraction) => Promise<void>
> = {
  ping: handlePing,
  "set-channel": handleSetChannel,
  "remove-channel": handleRemoveChannel,
  report: handleReport,
  status: handleStatus,
  backfill: handleBackfill,
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
