/**
 * Payout-page classifier — pure function, no I/O.
 *
 * Conservative by design: it only distinguishes
 *   - "ok"              the payout page rendered while logged in
 *   - "login_required"  the profile session is logged out / needs login
 *   - "error"           anything else (navigation failed, block page, unknown)
 *
 * It never claims sales figures: payout amounts are NOT parsed. The hardest
 * line — a non-sensitive payout hint — is only produced when the page text
 * contains an unambiguous, clearly-labeled keyword (e.g. "payout", "balance",
 * "earnings"); otherwise the summary stays at login health only.
 */

export type PayoutVerdict = "ok" | "login_required" | "error";

export type PayoutClassification = {
  verdict: PayoutVerdict;
  /** Why this verdict was chosen — safe to post in Discord. */
  reason: string;
  /** Conservative non-sensitive payout hint, or null when none was found. */
  payoutHint: string | null;
};

export type PayoutSignals = {
  finalUrl: string;
  title: string;
  bodyText: string;
};

const LOGIN_URL_HINTS = [
  "login",
  "signin",
  "sign-in",
  "auth",
  "sso",
  "verify",
  "challenge",
  "captcha",
];

const LOGIN_TEXT_HINTS = [
  "log in to continue",
  "login to continue",
  "sign in to continue",
  "please log in",
  "please login",
  "please sign in",
  "session expired",
  "log in again",
  "login again",
  "sign in again",
  "enter your password",
  "forgot password",
  "create an account",
];

// Clearly-labeled, non-sensitive keywords that may justify a short payout hint.
const PAYOUT_LABEL_HINTS = [
  "payout",
  "payouts",
  "balance",
  "earnings",
  "available for payout",
  "next payout",
];

// Error/block pages: never report "ok", never leak internals beyond one line.
const ERROR_TEXT_HINTS = [
  "access denied",
  "forbidden",
  "page not found",
  "something went wrong",
  "service unavailable",
  "err_connection",
  "net::",
  "this site can’t be reached",
  "this site can't be reached",
];

const LOGIN_INPUT_RE = /<[^>]*(type\s*=\s*["']password["']|name\s*=\s*["'](email|password)[^"']*["'])[^>]*>/i;

function firstMatchingLine(
  bodyText: string,
  hints: string[],
): string | null {
  const lines = bodyText.split(/\r?\n/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const hint of hints) {
      if (lower.includes(hint)) {
        const trimmed = line.trim().replace(/\s+/g, " ").slice(0, 160);
        if (trimmed) return trimmed;
      }
    }
  }
  return null;
}

/**
 * Classify a settled payout-page snapshot.
 * Pure: safe to unit test exhaustively, no network, no secrets.
 */
export function classifyPayoutPage(signals: PayoutSignals): PayoutClassification {
  const url = (signals.finalUrl ?? "").toLowerCase();
  const title = (signals.title ?? "").toLowerCase();
  const text = signals.bodyText ?? "";
  const lowerText = text.toLowerCase();

  // 1) URL says login/auth — strongest signal, no guessing.
  if (url && LOGIN_URL_HINTS.some((hint) => url.includes(hint))) {
    return {
      verdict: "login_required",
      reason: `final URL points at a login/auth page (${signals.finalUrl.slice(0, 120)})`,
      payoutHint: null,
    };
  }
  if (/login|sign ?in/.test(title) && !url.includes("maloum")) {
    return {
      verdict: "login_required",
      reason: `page title indicates a login screen ("${signals.title.slice(0, 80)}")`,
      payoutHint: null,
    };
  }

  // 2) Page carries a password/login form or explicit login wording.
  if (LOGIN_INPUT_RE.test(text)) {
    return {
      verdict: "login_required",
      reason: "page contains a login form (credential entry is out of scope — log in manually in DICloak)",
      payoutHint: null,
    };
  }
  if (LOGIN_TEXT_HINTS.some((hint) => lowerText.includes(hint))) {
    return {
      verdict: "login_required",
      reason: "page text asks for login (session expired or logged out)",
      payoutHint: null,
    };
  }

  // 3) Error / block / unreachable signals.
  if (ERROR_TEXT_HINTS.some((hint) => lowerText.includes(hint))) {
    return {
      verdict: "error",
      reason: "page shows an error or access-denied message",
      payoutHint: null,
    };
  }

  // 4) Still on the payout host with payout-labeled text → ok + short hint.
  if (url.includes("maloum")) {
    const hint = firstMatchingLine(text, PAYOUT_LABEL_HINTS);
    if (hint) {
      return { verdict: "ok", reason: "payout page rendered while logged in", payoutHint: hint };
    }
    return {
      verdict: "ok",
      reason: "reached the payout page; no clearly-labeled payout text found",
      payoutHint: null,
    };
  }

  // 5) Unknown landing spot: conservative error, never "ok".
  return {
    verdict: "error",
    reason: `unexpected final URL (${signals.finalUrl.slice(0, 120) || "empty"} — expected app.maloum.com/payout)`,
    payoutHint: null,
  };
}

/** One-line Discord-safe status line for a classification. */
export function verdictEmoji(verdict: PayoutVerdict): string {
  return verdict === "ok" ? "✅" : verdict === "login_required" ? "🔑" : "❌";
}
