/**
 * Derive the canonical model roster from retained raw report messages.
 *
 * Report messages carry model names in two observed shapes:
 *   1. Per-line breakdowns:
 *        `Name - 12,99` / `Name-€5` / `Name + 5(Added sales)` / `Name ( 86156 )`
 *   2. Auto "logout" lines:
 *        `🟡 Logout for bibix | leona with € 22 sold.`
 *        `🟡 Logout for Model name: BibiX,Jennychi with sold.`
 *
 * This script extracts the model names, clusters display variants by
 * conservative normalization, and writes `packages/shared/src/model-roster.json`
 * as `{ "canonical": "<most common display form>", "aliases": [...] }` — the
 * maintainable data source the matcher consumes. To use the owner's
 * authoritative roster instead, replace the JSON (same shape).
 *
 * Conservative safeguards:
 *   - only raw messages that actually produced a report are scanned
 *   - headers (`Earnings`, `Total`, `MODEL:`, `!logout`...) are excluded
 *   - `Logout for <names> with ... sold` lines are split on `|`, `,`, `and`
 *   - junk tokens (numbers, keywords, fragments) are filtered
 *   - a candidate must appear in >= MIN_MESSAGES distinct messages
 *   - display forms are deduplicated by normalized key; the most frequent
 *     display form becomes the canonical name
 *
 * Run: SALESRECON_DB_PATH=... packages/bot/node_modules/.bin/tsx scripts/extract-model-roster.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../packages/shared/src/db.js";
import { normalizeModelName } from "../packages/shared/src/models.js";

const MIN_MESSAGES = 2;

const HEADER_RE = /^(earnings?|total|model|performer|sales|shift|tips|logout|from|for|date|note)/i;
const JUNK_WORD_RE =
  /\b(earnings?|logout|sold|performer|shift|total|added|models?|names?|of|the|for|and|with|recipients|updated|lists)\b/i;

function isJunkToken(token: string): boolean {
  const key = normalizeModelName(token);
  if (!key) return true;
  if (/^[0-9]+$/.test(key) && key.length <= 4) return true; // "10", "25", "99"
  if (/^[0-9]+\.[0-9]+$/.test(key)) return true; // "3.99"
  if (/^[0-9\s]+$/.test(key)) return true; // residue like "576 23", "067 0"
  if (key.length < 2) return true; // "OF" -> "of" caught below too
  // keywords glued to tokens (no \b): "103752earning", "NOLOGINPASSWORD", ...
  if (
    /(earning|logout|sold|performer|shift|total|added|login|password|email|vault|content|sent|keeps|loading|recipients|updated|lists|name|model|tip|cover)/.test(
      key,
    )
  ) {
    return true;
  }
  if (JUNK_WORD_RE.test(key)) return true;
  if (key.split(" ").length >= 4) return true; // prose, not a name
  return false;
}

function stripTrailingNoise(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\s*\([^)]*\)/g, " "); // ( 86156 ), (Added sales), (52.99$)
    s = s.replace(/\s*\+\s*[€$]?\s*[\d][\d,.]*\s*$/, ""); // + 6.99, +10
    s = s.replace(/\s*[€$]?\s*[\d][\d,.]*\s*$/, ""); // €43.50, €10, 15,99, 5
    s = s.replace(/\s*[€$]\s*$/, ""); // lone currency symbol
    s = s.replace(/=\s*[€$]?\s*$/, ""); // trailing "=" with optional currency
    s = s.replace(/\s*[*]+$/, ""); // trailing markdown asterisks
    s = s.replace(/[:=\s]+$/, ""); // trailing label separators
  } while (s !== prev);
  return s.trim();
}

function cleanName(t: string): string {
  return t
    .replace(/^[(\s>*–—-]+/, "")
    .replace(/[:=\s€$*–—()/-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Apply the full noise/clean/junk pipeline to raw name tokens. */
function cleanTokens(tokens: string[]): string[] {
  return tokens
    .map(stripTrailingNoise)
    .map(cleanName)
    .filter((t) => t && !isJunkToken(t) && t.length <= 60);
}

/** Extract model names from a single line. Never throws. */
export function extractNamesFromLine(line: string): string[] {
  let l = line.trim();
  if (!l) return [];
  if (/^!/i.test(l)) return []; // !logout markers
  if (/^[*_>\-–—:\s]+$/.test(l)) return []; // separator/quote-only lines

  // Auto format: "… Logout for <names> with <amount> sold."
  const forMatch =
    l.match(/\blogout\s+for\b(.+?)\bwith\s+[€$]?\s*[\d.,]*\s*sold\.?\s*$/i) ??
    l.match(/\blogout\s+for\b(.+?)\s*$/i);
  if (forMatch?.[1]) {
    const inner = forMatch[1]
      .trim()
      .replace(/^(?:(?:model\s+names?|cover)\s*[:=]?\s*)/i, "")
      .trim();
    return cleanTokens(inner.split(/[,|/]|\band\b/i));
  }

  if (HEADER_RE.test(l)) return []; // Earnings / Total / MODEL: / etc.

  // "Added sales from Kamila-" / "Added €10 sales Mila" → final token
  if (/^added\b/i.test(l)) {
    const tail = l.match(/([A-Za-z0-9_.\-]+)\s*$/)?.slice(1)[0];
    if (!tail) return [];
    return cleanTokens([tail]);
  }

  l = l.replace(/^[-–—:=\s>]+/, "");

  // Comma/pipe/slash lists of names ("franzziska, emalie.amelia", "Cover: Bibix/Jenny")
  if (/[,|/]/.test(l)) {
    return cleanTokens(
      l.replace(/^(?:(?:model\s+names?|cover)\s*[:=]?\s*)/i, "").split(/[,|/]|\band\b/i),
    );
  }

  return cleanTokens([l]);
}

const db = getDb();
const rows = db
  .prepare(
    `SELECT rm.message_id, rm.content FROM raw_messages rm
     JOIN reports r ON r.message_id = rm.message_id`,
  )
  .all() as { message_id: string; content: string }[];

/** normalized key → { displayFreq: Map<form, count>, messages: Set<message_id> } */
const cluster = new Map<
  string,
  { displayFreq: Map<string, number>; messages: Set<string> }
>();

let totalLines = 0;
let acceptedLines = 0;
for (const row of rows) {
  const seenInMessage = new Set<string>();
  for (const rawLine of row.content.split("\n")) {
    const names = extractNamesFromLine(rawLine);
    for (const name of names) {
      totalLines++;
      const key = normalizeModelName(name);
      if (!key) continue;
      acceptedLines++;
      if (seenInMessage.has(key)) continue; // same message, one vote
      seenInMessage.add(key);
      let c = cluster.get(key);
      if (!c) {
        c = { displayFreq: new Map(), messages: new Set() };
        cluster.set(key, c);
      }
      c.messages.add(row.message_id);
      c.displayFreq.set(name, (c.displayFreq.get(name) ?? 0) + 1);
    }
  }
}

const entries: { canonical: string; aliases: string[] }[] = [];
let dropped = 0;
for (const [key, c] of cluster) {
  if (c.messages.size < MIN_MESSAGES) {
    dropped++;
    continue;
  }
  const sortedForms = [...c.displayFreq.entries()].sort((a, b) => b[1] - a[1]);
  const canonical = sortedForms[0]![0];
  const aliases = sortedForms
    .slice(1)
    .filter(([form]) => normalizeModelName(form) !== normalizeModelName(canonical))
    .map(([form]) => form)
    .slice(0, 20);
  entries.push({ canonical, aliases });
}
entries.sort((a, b) => a.canonical.localeCompare(b.canonical));

const outPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "shared",
  "src",
  "model-roster.json",
);
writeFileSync(outPath, JSON.stringify(entries, null, 2) + "\n");

console.log(
  JSON.stringify(
    {
      report_messages_scanned: rows.length,
      name_occurrences: totalLines,
      occurrences_with_clean_name: acceptedLines,
      distinct_candidates: cluster.size,
      dropped_below_min_messages: dropped,
      roster_entries: entries.length,
      output: outPath,
    },
    null,
    2,
  ),
);
closeDb();
