import type { ParsedReport } from "@salesrecon/types";

// ── Patterns ──

/**
 * Matches dollar amounts like "$1,240", "$80", "$1,240.50".
 * Group 1 = whole dollar part (before optional decimal).
 */
const DOLLAR_RE = /\$([\d,]+)(?:\.(\d{2}))?/g;

/**
 * Matches a number preceded by a keyword like "sales", "tips", etc.
 * Case-insensitive. Examples: "sales 1240", "Sales: 1,240", "tips: 80"
 */
function keywordAmountRe(keyword: string): RegExp {
  return new RegExp(
    `${keyword}\\s*[:\\s]\\s*\\$?([\\d,]+(?:\\.\\d{2})?)`,
    "i",
  );
}

/**
 * Matches "X in sales" or "X sales" patterns.
 * Examples: "$1,240 in sales", "80 tips", "1240 sales"
 */
function amountKeywordRe(keyword: string): RegExp {
  return new RegExp(
    `\\$?([\\d,]+(?:\\.\\d{2})?)\\s*(?:in\\s+)?${keyword}`,
    "i",
  );
}

// Time-range patterns
const TIME_RANGE_DASH_RE =
  /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–—to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i;
const SHIFT_KEYWORD_RE =
  /(?:shift|worked|hours?)[:\s]+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[-–—to]+\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i;

// !logout format: message starts with !logout (clear logout marker).
const LOGOUT_CMD_RE = /^!logout\b/im;

/**
 * !logout earnings amount — explicit "Earnings" (optionally "Total Earnings")
 * label with an amount attached. Observed real formats (aggregate analysis of
 * report channels, 2026-08-07):
 *   "Earnings- 52,99" / "Earnings: 52.99" / "Earnings 52,99"
 *   "Earnings: € 52,99" / "Earnings - € 52,99" / "Earnings: - € 52,99"
 *   "TOTAL EARNINGS: € 52,99" / "Total Earnings € 52,99"
 *   "TOTAL EARNINGS:$ 52,99" / "Total Earnings:(52.99$)"
 * Conservative: requires the explicit label and an immediately following
 * amount (separator runs, one optional €/$ symbol, optional wrapping parens).
 * Never guesses an amount from unlabeled lines (per-performer breakdowns).
 */
const EARNINGS_RE =
  /\b(?:total\s+)?earnings?\s*(?:[-:–—]+\s*){0,2}(?:[€$]\s*)?\(?\s*([\d,.]+)\s*\)?\s*(?:[€$])?/i;
// Conservative model extraction: only accept an explicit Model/Model name label.
const MODEL_RE = /(?:model(?:\s+name)?|performer)\s*[:=-]\s*([^\n|,]+)/i;

function extractModelName(text: string): string | null {
  const value = text.match(MODEL_RE)?.[1]?.trim();
  return value ? value.slice(0, 120) : null;
}

/**
 * Parse a number string that may use European comma-as-decimal.
 * "52,99" (2 digits after comma) → 52.99
 * "1,240" (3 digits after comma) → 1240
 * "15" → 15
 * "7,99" → 7.99
 */
function parseNumber(raw: string): number {
  const trimmed = raw.trim();
  // If there's a comma followed by exactly 2 digits, treat as decimal
  const euroMatch = trimmed.match(/^([\d,]*)\.?(\d{0,2}),(\d{2})$/);
  if (euroMatch) {
    const beforeDecimal = (euroMatch[1] || "").replace(/,/g, "") + (euroMatch[2] || "");
    const afterDecimal = euroMatch[3]!;
    return parseFloat(`${beforeDecimal}.${afterDecimal}`);
  }
  // Otherwise strip commas (thousands separators) and parse
  return parseFloat(trimmed.replace(/,/g, ""));
}

/**
 * Parse a dollar string like "1,240" or "1,240.50" into a float.
 * Kept for backward compat with the dollar-based parser.
 */
function parseDollars(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

/**
 * Extract an earnings amount from !logout format.
 * Looks for "Earnings- X" or "Earnings: X" pattern.
 */
function extractEarnings(text: string): number | null {
  const match = text.match(EARNINGS_RE);
  if (match?.[1]) {
    return parseNumber(match[1]);
  }
  return null;
}

/**
 * Extract a dollar amount from text.
 * Tries keyword-prefix patterns first, then suffix patterns, then any $ amount.
 */
function extractAmount(text: string, keyword: string): number | null {
  // Try "keyword: $X" or "keyword X"
  const prefixMatch = text.match(keywordAmountRe(keyword));
  if (prefixMatch?.[1]) {
    return parseDollars(prefixMatch[1]);
  }

  // Try "$X in keyword" or "X keyword"
  const suffixMatch = text.match(amountKeywordRe(keyword));
  if (suffixMatch?.[1]) {
    return parseDollars(suffixMatch[1]);
  }

  return null;
}

/**
 * Extract a time range from text.
 * Returns [start, end] strings or null.
 */
function extractTimeRange(text: string): [string, string] | null {
  // Try shift/work keyword pattern first (more specific)
  const shiftMatch = text.match(SHIFT_KEYWORD_RE);
  if (shiftMatch?.[1] && shiftMatch?.[2]) {
    return [shiftMatch[1].trim(), shiftMatch[2].trim()];
  }

  // Try generic time range (e.g., "2pm-10pm", "14:00 - 22:00")
  const rangeMatch = text.match(TIME_RANGE_DASH_RE);
  if (rangeMatch?.[1] && rangeMatch?.[2]) {
    return [rangeMatch[1].trim(), rangeMatch[2].trim()];
  }

  return null;
}

/**
 * Normalize a time string to a consistent format (HH:MM 24h).
 * Accepts: "2pm", "2:00pm", "14:00", "2", "10pm", etc.
 */
function normalizeTime(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  // Already 24h format like "14:00"
  if (/^\d{1,2}:\d{2}$/.test(trimmed) && parseInt(trimmed) >= 0 && parseInt(trimmed) <= 23) {
    const [h, m] = trimmed.split(":").map(Number);
    return `${String(h!).padStart(2, "0")}:${String(m!).padStart(2, "0")}`;
  }

  // "2pm", "2:00pm", "10:30am", "12pm"
  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return trimmed; // fallback: return as-is

  let hour = parseInt(match[1]!);
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const meridiem = match[3];

  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  return `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Format a Date as "YYYY-MM-DD HH:MM" for shift fields.
 */
function formatShiftDate(date: Date, time: string): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${time}`;
}

/**
 * Outcome of classifying a message against the !logout format.
 * Event extraction is deliberately separated from sales-report parsing:
 * a clear !logout marker always yields a chatter logout event (timestamp +
 * author), while a sales report is only produced when a supported earnings
 * amount is present.
 */
export type LogoutClassification =
  | { kind: "report"; report: ParsedReport }
  | { kind: "event_only"; reason: "no_supported_earnings" }
  | { kind: "not_logout" };

/**
 * Classify a message for the !logout format.
 *
 * - Every clear logout marker (message starts with !logout) becomes at least
 *   a chatter logout event, even when no supported earnings/model fields exist.
 * - A sales report is only returned when an explicit, supported Earnings
 *   amount is present (see EARNINGS_RE). Unlabeled amounts (per-performer
 *   breakdown lines like "Name - € 52,99") are never guessed as the report
 *   earnings.
 */
export function classifyLogoutMessage(
  content: string,
  messageDate?: Date,
): LogoutClassification {
  if (!LOGOUT_CMD_RE.test(content)) return { kind: "not_logout" };

  const earnings = extractEarnings(content);
  const date = messageDate ?? new Date();
  if (earnings === null) {
    return {
      kind: "report",
      report: {
        reported_sales: 0,
        reported_tips: 0,
        shift_start: formatShiftDate(date, "00:00"),
        shift_end: formatShiftDate(date, "23:59"),
        model_name: null,
        earnings_source: "inferred_zero",
      },
    };
  }


  return {
    kind: "report",
    report: {
      reported_sales: earnings,
      reported_tips: 0,
      shift_start: formatShiftDate(date, "00:00"),
      shift_end: formatShiftDate(date, "23:59"),
      model_name: extractModelName(content),
    },
  };
}

/**
 * Parse a logout message and extract structured data.
 *
 * Supports two formats:
 *   1. Standard keyword format:
 *      "Shift: 2pm-10pm | Sales: $1,240 | Tips: $80"
 *      "sales 1240 tips 80 shift 2pm-10pm"
 *      "$1,240 in sales, $80 tips, worked 2pm to 10pm"
 *
 *   2. !logout format (European decimals, no explicit shift):
 *      "!logout\nAdded sales from Model- 15,99\nEarnings- 52,99"
 *      "!logout\nTotal Earnings - € 52,99"
 *      Uses messageDate for shift times. Returns null when the message has a
 *      logout marker but no supported earnings amount — callers that need the
 *      event-only outcome should use {@link classifyLogoutMessage} instead.
 *
 * @param content - The raw message text
 * @param messageDate - Optional Date of the message (used for !logout shift)
 * @returns ParsedReport on success, or null if the message doesn't yield a report.
 */
export function parseLogoutMessage(
  content: string,
  messageDate?: Date,
): ParsedReport | null {
  const cls = classifyLogoutMessage(content, messageDate);
  if (cls.kind === "report") return cls.report;
  if (cls.kind === "event_only") return null;

  // ── Standard keyword format ──
  const sales = extractAmount(content, "sales");
  const tips = extractAmount(content, "tips");
  const timeRange = extractTimeRange(content);

  // Must have at least sales and a time range to be considered valid
  if (sales === null || timeRange === null) {
    return null;
  }

  return {
    reported_sales: sales,
    reported_tips: tips ?? 0,
    shift_start: normalizeTime(timeRange[0]),
    shift_end: normalizeTime(timeRange[1]),
    model_name: extractModelName(content),
  };
}

/**
 * Quick check: does this message look like a logout report?
 * Used as a fast pre-filter before running the full parser.
 */
export function looksLikeLogoutReport(content: string): boolean {
  // !logout format
  if (LOGOUT_CMD_RE.test(content)) return true;

  // Standard keyword format
  const lower = content.toLowerCase();
  const hasKeyword = lower.includes("sales") || lower.includes("tips") || lower.includes("shift");
  const hasDollar = /\$[\d,]+/.test(content);
  const hasTime = /\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(content) ||
    /\d{1,2}:\d{2}/.test(content);
  return hasKeyword && (hasDollar || hasTime);
}
