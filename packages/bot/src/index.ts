import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Message,
} from "discord.js";
import { parseLogoutMessage, looksLikeLogoutReport } from "./parser.js";
import { getOrCreateChatter, insertReport, getReportChannels } from "./db.js";
import { routeCommand, registerCommands } from "./commands.js";

// ── Client Setup ──

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Ready ──

client.once(Events.ClientReady, async (readyClient) => {
  console.log(
    `LittleBot online — logged in as ${readyClient.user.tag}`,
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
  // Ignore bot messages and DMs
  if (message.author.bot || !message.guildId) return;

  // Check if this guild has any report channels configured
  const reportChannels = getReportChannels(message.guildId);
  if (reportChannels.length === 0) return;

  // Only process messages in one of the configured report channels
  if (!reportChannels.includes(message.channelId)) return;

  // Quick pre-filter: does this look like a logout report?
  if (!looksLikeLogoutReport(message.content)) return;

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
    // Message looked like a report but couldn't be parsed
    console.log(
      `⚠️ Unparseable report from ${message.author.tag}: "${message.content.slice(0, 100)}"`,
    );
    await message.react("❌").catch(() => {});
  }
});

// ── Start ──

const token = process.env.DISCORD_TOKEN;

if (token) {
  await client.login(token);
} else {
  console.log(
    "LittleBot online (no DISCORD_TOKEN — waiting for token)",
  );
  console.log("Set DISCORD_TOKEN and restart to connect to Discord.");
}
