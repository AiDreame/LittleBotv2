/**
 * Canonical model roster + conservative matching.
 *
 * The roster is the authoritative list of model display names used in report
 * messages. It lives in `model-roster.json` (a maintainable data file) and is
 * consumed here as a pure module — no DB access — so the bot parser, the
 * reprocessing script, and the API analytics can all share identical logic.
 *
 * Matching rules (deliberately conservative):
 *  1. An explicit `Model:` / `Performer:` label wins when present. The label is
 *     canonicalized to a roster name when it unambiguously matches one; an
 *     explicit label that matches nothing in the roster is kept verbatim
 *     (the poster labelled it deliberately).
 *  2. Otherwise the message is scanned for roster names (canonical + aliases)
 *     using boundary-aware, normalization-insensitive phrase matching:
 *       - case-insensitive; punctuation/whitespace/underscores are
 *         interchangeable (`Maren.lipps` == `maren lipps` == `Maren Lipps`)
 *       - a name only counts when it is not embedded inside a longer word
 *         (`Kim` never matches inside `Kimberly`)
 *       - when a phrase and a single token would both match the same span,
 *         the longest form wins (`beachgirl bella` over `bella`)
 *  3. Exactly one distinct canonical match → that model.
 *  4. Two or more distinct canonical matches → ambiguous → Unknown (no model
 *     is invented, nothing is picked "best").
 *  5. No match at all → Unknown (no evidence).
 *
 * `model_match` stores the outcome per report: `explicit` | `roster` |
 * `ambiguous` | `none`, so analytics can expose why a report is Unknown.
 */

export interface ModelRosterEntry {
  /** Canonical display name (preferred form). */
  canonical: string;
  /** Other observed display forms of the same model. */
  aliases?: string[];
}

export type ModelMatchStatus = "explicit" | "roster" | "ambiguous" | "none";

export interface ModelMatchResult {
  status: ModelMatchStatus;
  /** Canonical model name when status is explicit/roster, else null. */
  modelName: string | null;
  /** Distinct canonical candidates when status is ambiguous. */
  candidates: string[];
  /** Raw label text when an explicit label was present (may be non-roster). */
  rawLabel: string | null;
}

export interface ModelMatcher {
  /** normalized form -> roster entry */
  byForm: Map<string, ModelRosterEntry>;
  /** normalized forms, longest first (longest phrase wins on overlap) */
  forms: string[];
}

/**
 * Conservative normalization: lowercase, and every run of non-alphanumeric
 * characters (punctuation, dots, dashes, underscores, whitespace) collapses to
 * a single space. This is the key that makes case/punctuation/whitespace
 * variants of a name interchangeable.
 */
export function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a matcher index from roster entries. Normalization-equivalent display
 * forms collapse onto one canonical entry (first entry wins when two entries
 * normalize identically — they are variants of the same model).
 */
export function buildModelMatcher(entries: ModelRosterEntry[]): ModelMatcher {
  const byForm = new Map<string, ModelRosterEntry>();
  for (const entry of entries) {
    const forms = [entry.canonical, ...(entry.aliases ?? [])];
    for (const form of forms) {
      const key = normalizeModelName(form);
      if (!key) continue;
      if (!byForm.has(key)) byForm.set(key, entry);
    }
  }
  return {
    byForm,
    forms: [...byForm.keys()].sort((a, b) => b.length - a.length),
  };
}

const isWordChar = (ch: string): boolean => /[a-z0-9]/.test(ch);

/**
 * Find all distinct canonical roster names present in normalized content.
 * Boundary-aware: a name only counts when not embedded in a longer word, and
 * overlapping matches keep only the longest form.
 */
export function findRosterMatches(
  matcher: ModelMatcher,
  normalizedContent: string,
): string[] {
  const spans: { start: number; end: number; canonical: string }[] = [];
  for (const form of matcher.forms) {
    const entry = matcher.byForm.get(form)!;
    let idx = 0;
    while (idx < normalizedContent.length) {
      const i = normalizedContent.indexOf(form, idx);
      if (i === -1) break;
      const before = i === 0 ? " " : normalizedContent[i - 1]!;
      const after =
        i + form.length >= normalizedContent.length
          ? " "
          : normalizedContent[i + form.length]!;
      if (!isWordChar(before) && !isWordChar(after)) {
        const overlaps = spans.some(
          (s) => i < s.end && s.start < i + form.length,
        );
        if (!overlaps) {
          spans.push({ start: i, end: i + form.length, canonical: entry.canonical });
        }
        idx = i + form.length;
      } else {
        idx = i + 1;
      }
    }
  }
  return [...new Set(spans.map((s) => s.canonical))];
}

/**
 * Explicit `Model:` / `Performer:` label pattern. Kept as a shared regex so the
 * bot parser and the reprocessor agree on what an explicit label looks like.
 * Never matches `Earnings`/`Sales` lines.
 */
export const MODEL_LABEL_RE = /(?:model(?:\s+name)?|performer)\s*[:=]\s*([^\n|,]+)/i;

/**
 * Classify which canonical model a message provides evidence for.
 * Precedence: explicit label > single roster match > ambiguous > none.
 */
export function classifyModelEvidence(
  matcher: ModelMatcher,
  content: string,
): ModelMatchResult {
  const labelMatch = content.match(MODEL_LABEL_RE);
  if (labelMatch?.[1]) {
    const rawLabel = labelMatch[1].trim().slice(0, 120);
    if (rawLabel) {
      const labelNorm = normalizeModelName(rawLabel);
      const exact = matcher.byForm.get(labelNorm);
      if (exact) {
        return {
          status: "explicit",
          modelName: exact.canonical,
          candidates: [exact.canonical],
          rawLabel,
        };
      }
      const inside = findRosterMatches(matcher, labelNorm);
      if (inside.length === 1) {
        return { status: "explicit", modelName: inside[0]!, candidates: inside, rawLabel };
      }
      if (inside.length > 1) {
        return { status: "ambiguous", modelName: null, candidates: inside, rawLabel };
      }
      // Explicit label that matches nothing in the roster: honour the label.
      return { status: "explicit", modelName: rawLabel, candidates: [], rawLabel };
    }
  }

  const found = findRosterMatches(matcher, normalizeModelName(content));
  if (found.length === 1) {
    return { status: "roster", modelName: found[0]!, candidates: found, rawLabel: null };
  }
  if (found.length > 1) {
    return { status: "ambiguous", modelName: null, candidates: found, rawLabel: null };
  }
  return { status: "none", modelName: null, candidates: [], rawLabel: null };
}
