import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Message,
} from "discord.js";
import { parseLogoutMessage, looksLikeLogoutReport, classifyLogoutMessage } from "./parser.js";
import { getOrCreateChatter, insertReport, getReportChannels, recordRawMessage, recordChatterEvent } from "./db.js";
import { routeCommand, registerCommands } from "./commands.js";

// ── Client Setup ──

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Gateway Readiness & Health Logging (never logs the token) ──

client.on(Events.ShardReady, (shardId) => {
  console.log(`[gateway] shard ${shardId} ready`);
});

client.on(Events.ShardResume, (shardId, replayed) => {
  console.log(
    `[gateway] shard ${shardId} resumed — replayed ${replayed} events`,
  );
});

client.on(Events.ShardReconnecting, (shardId) => {
  console.warn(`[gateway] shard ${shardId} reconnecting…`);
});

client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
  const reason = closeEvent?.reason ? ` — "${closeEvent.reason}"` : "";
  console.warn(
    `[gateway] shard ${shardId} DISCONNECTED (code ${closeEvent?.code ?? "?"}${reason})`,
  );
});

client.on(Events.ShardError, (error, shardId) => {
  console.error(
    `[gateway] shard ${shardId} error: ${error?.message ?? error}`,
  );
});

client.on(Events.Invalidated, () => {
  console.error(
    "[gateway] Session INVALIDATED — Discord closed this session. The bot token may have been reset in the Developer Portal; the bot cannot come back online with this token.",
  );
});

client.on(Events.Warn, (info) => {
  console.warn(`[discord.js] warning: ${info}`);
});

client.on(Events.Error, (err) => {
  console.error(`[discord.js] error: ${err?.message ?? err}`);
});

// ── Process-level guards ──
// A single failed message/job/DB write must never take the gateway down. Log
// aggregate details only — never message content.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[process] unhandled promise rejection (gateway kept alive):",
    reason instanceof Error ? `${reason.name}: ${reason.message}` : reason,
  );
});
process.on("uncaughtException", (err) => {
  console.error(
    "[process] uncaught exception (gateway kept alive):",
    `${err?.name ?? "Error"}: ${err?.message ?? err}`,
  );
});

// ── Ready ──

client.once(Events.ClientReady, async (readyClient) => {
  console.log(
    `LittleBot online — logged in as ${readyClient.user.tag} ` +
      `(bot id ${readyClient.user.id}, app id ${readyClient.application?.id ?? "?"}) ` +
      `in ${readyClient.guilds.cache.size} guild(s), ws ping ${readyClient.ws.ping}ms`,
  );

  // Register slash commands with Discord
  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_TOKEN!,
  );
  await registerCommands(rest, readyClient.user.id);
});

// ── Slash Commands ──

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await routeCommand(interaction);
  } catch (err) {
    console.error("Error handling command:", err);
    // Always surface the failure. Commands that defer first (e.g. /backfill)
    // must get an editReply, otherwise Discord reports "The application did
    // not respond" and the user is left hanging for 15 minutes.
    const message = "❌ An internal error occurred. Please try again.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message }).catch(() => {});
    } else {
      await interaction
        .reply({ content: message, ephemeral: true })
        .catch(() => {});
    }
  }
});

// ── Message Listener (Logout Report Detection) ──

client.on(Events.MessageCreate, async (message: Message) => {
  // Any failure while handling a live message must be contained — an
  // unhandled rejection here would take the whole gateway down.
  try {
  // Ignore bot messages and DMs
  if (message.author.bot || !message.guildId) return;

  // Check if this guild has any report channels configured
  const reportChannels = getReportChannels(message.guildId);
  if (reportChannels.length === 0) return;

  // Only process messages in one of the configured report channels
  if (!reportChannels.includes(message.channelId)) return;

  // Retain every watched-channel message privately before parsing.
  recordRawMessage({message_id: message.id, guild_id: message.guildId, channel_id: message.channelId,
    author_id: message.author.id, author_name: message.author.displayName ?? message.author.username,
    message_created_at: message.createdAt.toISOString(), content: message.content}, "fetched", null);

  // Quick pre-filter: does this look like a logout report?
  if (!looksLikeLogoutReport(message.content)) {
    recordRawMessage({message_id: message.id, guild_id: message.guildId, channel_id: message.channelId,
      author_id: message.author.id, author_name: message.author.displayName ?? message.author.username,
      message_created_at: message.createdAt.toISOString(), content: message.content}, "skipped", "does_not_look_like_report");
    return;
  }

  // ── Event extraction (separate from sales-report parsing) ──
  // Every clear !logout marker records a chatter logout event (timestamp +
  // author) even when no supported earnings/model fields exist. A sales report
  // is only created when an explicit supported Earnings amount is present;
  // otherwise the raw message stays retained and explicitly classified.
  const cls = classifyLogoutMessage(message.content, message.createdAt);
  if (cls.kind !== "not_logout") {
    const raw = {message_id: message.id, guild_id: message.guildId, channel_id: message.channelId,
      author_id: message.author.id, author_name: message.author.displayName ?? message.author.username,
      message_created_at: message.createdAt.toISOString(), content: message.content};

    if (cls.kind === "report") {
      try {
        // Get or create chatter
        const chatter = getOrCreateChatter(
          message.author.id,
          message.author.displayName ?? message.author.username,
          message.guildId,
        );

        // Save to database
        const result = insertReport(chatter.id, cls.report, message.id);
        recordRawMessage(raw, "parsed", null);
        recordChatterEvent({messageId: message.id, chatterId: chatter.id, guildId: message.guildId,
          channelId: message.channelId, type: "logout", occurredAt: message.createdAt.toISOString()});

        console.log(
          `✅ Parsed report from ${message.author.tag}: sales=$${cls.report.reported_sales}, tips=$${cls.report.reported_tips}, shift=${cls.report.shift_start}–${cls.report.shift_end} (DB #${result.id})`,
        );

        // Acknowledge with ✅ reaction
        await message.react("✅").catch(() => {});
      } catch (err) {
        console.error("Error saving report:", err);
        await message.react("❌").catch(() => {});
      }
      return;
    }

    // Logout marker without a supported earnings amount: the event is recorded
    // below and the raw message stays with an explicit classification. No ❌ —
    // the logout event itself was captured.
    try {
      const chatter = getOrCreateChatter(
        message.author.id,
        message.author.displayName ?? message.author.username,
        message.guildId,
      );
      recordChatterEvent({messageId: message.id, chatterId: chatter.id, guildId: message.guildId,
        channelId: message.channelId, type: "logout", occurredAt: message.createdAt.toISOString()});
      recordRawMessage(raw, "unparsed", "logout_event_only_no_earnings");
      console.log(
        `ℹ️ Logout event recorded from ${message.author.tag} (no supported earnings amount — no report created)`,
      );
    } catch (err) {
      console.error("Error recording logout event:", err);
    }
    return;
  }

  // ── No logout marker: standard keyword report format ──
  // Parse the message
  const parsed = parseLogoutMessage(message.content, message.createdAt);

  if (parsed) {
    try {
      // Get or create chatter
      const chatter = getOrCreateChatter(
        message.author.id,
        message.author.displayName ?? message.author.username,
        message.guildId,
      );

      // Save to database
      const result = insertReport(chatter.id, parsed, message.id);
      recordRawMessage({message_id: message.id, guild_id: message.guildId, channel_id: message.channelId,
        author_id: message.author.id, author_name: message.author.displayName ?? message.author.username,
        message_created_at: message.createdAt.toISOString(), content: message.content}, "parsed", null);
      recordChatterEvent({messageId: message.id, chatterId: chatter.id, guildId: message.guildId,
        channelId: message.channelId, type: "logout", occurredAt: message.createdAt.toISOString()});

      console.log(
        `✅ Parsed report from ${message.author.tag}: sales=$${parsed.reported_sales}, tips=$${parsed.reported_tips}, shift=${parsed.shift_start}–${parsed.shift_end} (DB #${result.id})`,
      );

      // Acknowledge with ✅ reaction
      await message.react("✅").catch(() => {});
    } catch (err) {
      console.error("Error saving report:", err);
      await message.react("❌").catch(() => {});
    }
  } else {
    recordRawMessage({message_id: message.id, guild_id: message.guildId, channel_id: message.channelId,
      author_id: message.author.id, author_name: message.author.displayName ?? message.author.username,
      message_created_at: message.createdAt.toISOString(), content: message.content}, "failed", "report_shape_not_supported");
    // Message looked like a report but couldn't be parsed — never log its content.
    console.log(
      `⚠️ Unparseable report-shaped message from ${message.author.tag} (no message content logged)`,
    );
    await message.react("❌").catch(() => {});
  }
  } catch (err) {
    console.error(
      "Error processing message (contained, gateway stays up):",
      err instanceof Error ? err.message : err,
    );
  }
});

// ── Start ──

const token = process.env.DISCORD_TOKEN;

// Non-secret preflight: ask Discord whether this token is even valid, and
// which bot it belongs to. Never logs the token itself.
async function verifyToken(tok: string): Promise<boolean> {
  const rest = new REST({ version: "10" }).setToken(tok);
  try {
    const me = (await rest.get("/users/@me")) as {
      id: string;
      username: string;
      discriminator?: string;
    };
    const tag =
      me.discriminator && me.discriminator !== "0"
        ? `${me.username}#${me.discriminator}`
        : me.username;
    console.log(`[token] DISCORD_TOKEN accepted — bot user ${tag} (id ${me.id})`);
    return true;
  } catch (err: any) {
    console.error(
      `[token] DISCORD_TOKEN REJECTED by Discord (HTTP ${err?.status ?? err?.code ?? "?"}${err?.message ? `: ${err.message}` : ""}). ` +
        "The bot cannot go online with this token — reset the bot token in the Discord Developer Portal and restart with the new one.",
    );
    return false;
  }
}

if (!token) {
  console.error(
    "No DISCORD_TOKEN in environment — the bot will NOT connect to Discord. Set DISCORD_TOKEN and restart.",
  );
  process.exit(1);
} else {
  await verifyToken(token);
  try {
    await client.login(token);
  } catch (err: any) {
    console.error(
      `Discord login failed: ${err?.message ?? err} — the bot is offline.`,
    );
    process.exit(1);
  }
}
