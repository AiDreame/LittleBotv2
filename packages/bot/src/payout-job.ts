/**
 * /payout-check orchestration — detached async job, same shape as
 * /backfill and /update-reports (instant ack, status message, Never reject).
 *
 * Flow for one profile id:
 *   1. (optionally) verify the profile exists via GET /v1/env/list
 *   2. PATCH /v1/env/{id}/open → debug_port
 *   3. GET 127.0.0.1:{port}/json/version → webSocketDebuggerUrl
 *   4. CDP: navigate to https://app.maloum.com/payout, snapshot settled page
 *   5. classify → verdict; record row in payout_checks; post alert on
 *      login_required / error, status report on ok
 *   6. best-effort PATCH /v1/env/{id}/close (leave profile as found)
 *
 * Secrets: DICLOAK_API_KEY is read inside dicloakSend only. This module logs
 * profile ids, status codes, envelope msg strings, URLs and verdicts — never
 * the key, cookies, or page internals.
 *
 * When `DICLOAK_DRY_RUN=1` (or no API key is configured), the job runs the
 * full Discord + DB + classifier path against a stubbed login-required
 * snapshot instead of touching DICloak — safe to run anywhere, including CI.
 */

import type { ChatInputCommandInteraction, Message } from "discord.js";
import { recordPayoutCheck } from "./payout-db.js";
import {
  classifyPayoutPage,
  verdictEmoji,
  type PayoutVerdict,
} from "./payout-classify.js";
import {
  MALOUM_PAYOUT_URL,
  assertDicloakOk,
  buildCloseEnvRequest,
  buildListEnvsRequest,
  buildOpenEnvRequest,
  dicloakSend,
  getCdpWebSocketUrl,
  snapshotPageOverCdp,
  type PageSnapshot,
} from "./dicloak.js";

const MAX_REPLY_CHARS = 1900;

export type PayoutJobDeps = {
  snapshot?: (profileId: string) => Promise<PageSnapshot>;
};

function isDryRun(): boolean {
  return process.env.DICLOAK_DRY_RUN === "1" || !process.env.DICLOAK_API_KEY;
}

/** Stubbed snapshot: exercises classifier + alert + history without DICloak. */
async function dryRunSnapshot(profileId: string): Promise<PageSnapshot> {
  return {
    finalUrl: `https://app.maloum.com/login?next=payout&profile=${encodeURIComponent(profileId)}`,
    title: "Log in — Maloum",
    bodyText: "Please log in to continue.\nEmail\nPassword",
  };
}

type OpenResult =
  | { ok: true; debugPort: string }
  | { ok: false; error: string };

async function openProfile(profileId: string): Promise<OpenResult> {
  try {
    const envelope = await dicloakSend(buildOpenEnvRequest(profileId));
    const data = assertDicloakOk(envelope, "open") as {
      debug_port?: unknown;
      debugPort?: unknown;
    };
    const raw = data?.debug_port ?? data?.debugPort;
    if (raw === undefined || raw === null || String(raw).length === 0) {
      return { ok: false, error: "DICloak open returned no debug_port" };
    }
    return { ok: true, debugPort: String(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function closeProfileBestEffort(profileId: string): Promise<void> {
  try {
    await dicloakSend(buildCloseEnvRequest(profileId));
  } catch (err) {
    console.log(
      `[payout-check] profile=${profileId} close best-effort failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function liveSnapshot(profileId: string): Promise<PageSnapshot> {
  const opened = await openProfile(profileId);
  if (!opened.ok) throw new Error(opened.error);
  const finish = async (): Promise<PageSnapshot> => {
    const wsUrl = await getCdpWebSocketUrl(opened.debugPort);
    return snapshotPageOverCdp(wsUrl, MALOUM_PAYOUT_URL);
  };
  try {
    return await finish();
  } finally {
    await closeProfileBestEffort(profileId);
  }
}

/**
 * Background payout-check job. Never rejects — every failure path ends in a
 * Discord alert plus a history row.
 */
export async function runPayoutCheckJob(
  interaction: ChatInputCommandInteraction,
  profileId: string,
  deps: PayoutJobDeps = {},
): Promise<void> {
  const guildId = interaction.guildId ?? "";
  const channelId = interaction.channelId ?? "";
  const requestedBy = interaction.user.id;
  const startedAt = Date.now();
  const dryRun = isDryRun() && !deps.snapshot;
  const statusSender =
    interaction.channel && "send" in interaction.channel
      ? (interaction.channel as unknown as {
          send: (o: { content: string }) => Promise<Message>;
        })
      : null;
  let statusMessage: Message | null = statusSender
    ? await statusSender.send({ content: "⏳ Payout check starting…" }).catch(() => null)
    : null;
  const updateStatus = async (text: string): Promise<void> => {
    const clipped = text.slice(0, MAX_REPLY_CHARS);
    if (statusMessage) {
      await statusMessage.edit({ content: clipped }).catch(() => {});
    } else {
      await interaction.editReply({ content: clipped }).catch(() => {});
    }
  };

  const finish = async (opts: {
    verdict: PayoutVerdict | "dry_run";
    headline: string;
    reason: string;
    finalUrl: string;
    title: string;
    payoutHint: string | null;
  }): Promise<void> => {
    let rowId = -1;
    try {
      rowId = recordPayoutCheck({
        guild_id: guildId,
        channel_id: channelId,
        requested_by: requestedBy,
        dicloak_profile_id: profileId,
        verdict: opts.verdict,
        reason: opts.reason.slice(0, 500),
        final_url: opts.finalUrl.slice(0, 500),
        page_title: opts.title.slice(0, 200),
        payout_hint: opts.payoutHint?.slice(0, 300) ?? null,
      });
    } catch (err) {
      console.error(
        `[payout-check] profile=${profileId} history write failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const lines = [
      opts.headline,
      "",
      `**Profile:** \`${profileId}\``,
      `**Final URL:** ${opts.finalUrl.slice(0, 120) || "(empty)"}`,
      `**Title:** ${opts.title.slice(0, 120) || "(empty)"}`,
      `**Status:** ${opts.reason}`,
    ];
    if (opts.payoutHint) lines.push(`**Payout hint:** ${opts.payoutHint}`);
    lines.push(`*(check #${rowId}, ${secs}s${dryRun ? ", dry run" : ""})*`);
    await updateStatus(lines.join("\n"));
    await interaction.editReply({ content: lines.join("\n").slice(0, MAX_REPLY_CHARS) }).catch(() => {});
    console.log(
      `[payout-check] profile=${profileId} verdict=${opts.verdict} dry_run=${dryRun} row=${rowId} took=${secs}s`,
    );
  };

  try {
    const snapshot = deps.snapshot
      ? await deps.snapshot(profileId)
      : dryRun
        ? await dryRunSnapshot(profileId)
        : await liveSnapshot(profileId);
    const classification = classifyPayoutPage({
      finalUrl: snapshot.finalUrl,
      title: snapshot.title,
      bodyText: snapshot.bodyText,
    });
    const emoji = verdictEmoji(classification.verdict);
    const headline =
      classification.verdict === "ok"
        ? `${emoji} **Payout check OK** — Maloum session is logged in`
        : classification.verdict === "login_required"
          ? `🔑 **Maloum login required** — profile \`${profileId}\` needs a manual login`
          : `❌ **Payout check failed** — profile \`${profileId}\``;
    await finish({
      verdict: dryRun ? "dry_run" : classification.verdict,
      headline: dryRun ? `${headline}\n(dry run — no DICloak call made)` : headline,
      reason: classification.reason,
      finalUrl: snapshot.finalUrl,
      title: snapshot.title,
      payoutHint: classification.payoutHint,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[payout-check] profile=${profileId} job failed:`, message);
    await finish({
      verdict: "error",
      headline: `❌ **Payout check failed** — profile \`${profileId}\``,
      reason: message.slice(0, 300),
      finalUrl: "",
      title: "",
      payoutHint: null,
    });
  }
}

/**
 * Lightweight pre-flight used by the handler: confirm the profile id exists
 * in GET /v1/env/list before opening it. Returns an error string, or null
 * when the id was found (or the list could not be checked — open() is then
 * authoritative). Skipped entirely in dry-run mode.
 */
export async function preflightProfileExists(profileId: string): Promise<string | null> {
  if (isDryRun()) return null;
  try {
    // One page is enough for the MVP: profile ids are explicit arguments and
    // the open call is authoritative for anything beyond the first page.
    const envelope = await dicloakSend(buildListEnvsRequest("1", "50"));
    const data = assertDicloakOk(envelope, "profile list") as {
      list?: Array<{ id?: unknown; name?: unknown }>;
    };
    const list = Array.isArray(data?.list) ? data.list : [];
    if (list.length === 0) return "DICloak returned an empty profile list";
    const found = list.some((env) => String(env?.id ?? "") === profileId);
    if (!found) {
      const names = list
        .slice(0, 10)
        .map((env) => `\`${String(env?.id ?? "?")}\``)
        .join(", ");
      return (
        `Profile \`${profileId}\` not found in the first ${list.length} DICloak profiles ` +
        `(seen: ${names}). Check the id in DICloak, then retry.`
      );
    }
    return null;
  } catch (err) {
    console.log(
      `[payout-check] preflight list failed (open is authoritative): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
