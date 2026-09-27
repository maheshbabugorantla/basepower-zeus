// The rep-facing "case for a knock" sentence -- built only from a home's
// real top score terms (api.home_score_breakdown / app/ranking/breakdown
// route.ts's BreakdownSignal shape), never invented. Rules (set by the
// user, 2026-09-27):
//   - Strongest signal first, one fact per sentence.
//   - Figures rounded to units a rep actually uses ("about 9 in 100
//     nearby homes" from a raw 87.08-per-1,000 rate; "about 3 hours"
//     from 181.98 minutes; "83 %" from a raw 83.0).
//   - No Census/model vocabulary in the sentence -- "block group",
//     "36 months", "decile", "per 1,000", "percentile", "AUC" are banned
//     from the rendered text (the label-size sources line below the
//     sentence is the only place a dataset name appears).
//   - A missing signal is left out of the prose entirely -- its meter
//     shows the hatch instead (see components/ui/Chip.tsx's signal
//     colors / the "not scored" meter pattern already used elsewhere).
//
// This module is pure (no React, no fetch) so it can be unit-tested with
// real, already-quoted app values (87.08, 181.98, 83.0 -- the exact
// figures the critique/mock cite from the live app on 2026-09-27), never
// synthetic ones.

export interface CaseSignalInput {
  key: string;
  label: string;
  rawValue: number | null;
  rawUnit: string;
  term: number | null;
  anchorValue: number | null;
  anchorBasis: string | null;
  available: boolean;
  /** Optional -- present on the real /ranking/breakdown response shape;
   * used only by the "not scored" hatch meter (components/CaseForKnock.tsx),
   * never by the sentence builder itself. */
  nullReason?: string | null;
}

export interface CaseSentencePart {
  key: string;
  /** Plain sentence with the one figure to highlight wrapped in **bold**
   * markers -- see splitBoldMarkers() for the renderer-side parser. */
  text: string;
}

/** Words/phrases that must never appear in the rendered case sentence
 * (they may still appear in the label-size sources line, or in the
 * Signals tab's own table headers -- this check is scoped to the
 * sentence text only). */
export const BANNED_SENTENCE_PHRASES = [
  "block group",
  "36 months",
  "decile",
  "per 1,000",
  "percentile",
  "auc",
];

export function containsBannedVocabulary(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED_SENTENCE_PHRASES.some((phrase) => lower.includes(phrase));
}

// ---------------------------------------------------------------------------
// Rounding helpers -- exported individually so the unit test can assert
// each one against the exact real values quoted in the critique/mock.
// ---------------------------------------------------------------------------

/** 87.08 (per-1,000-homes rate) -> 9 ("about 9 in 100 nearby homes"). */
export function roundRatePer1000ToPer100(ratePer1000: number): number {
  return Math.round(ratePer1000 / 10);
}

/** 181.98 (minutes without power) -> 3 ("about 3 hours"). Never rounds
 * down to 0 for a genuinely nonzero figure -- "under an hour" covers that
 * case in the sentence text itself. */
export function roundMinutesToHours(minutes: number): number {
  return Math.round(minutes / 60);
}

/** 83.0 (already a 0-100 percentage point value, per
 * supabase/migrations/0216_scoring_pass.sql's `share * 100`) -> 83. */
export function roundToWholePercent(value: number): number {
  return Math.round(value);
}

export function roundDollars(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

// ---------------------------------------------------------------------------
// Per-signal sentence templates. Only signals with a natural rep-facing
// sentence are templated; everything else (flood, empower, age65,
// electric_heat, owner_65, permit_risk) is left out of the prose (still
// shown as one of the meters/facts elsewhere) -- "missing means empty",
// never a forced, awkward sentence.
// ---------------------------------------------------------------------------

function fmtBackupIntent(rawValue: number): string {
  const per100 = roundRatePer1000ToPer100(rawValue);
  return `About **${per100} in 100 nearby homes** added a battery or generator in the last three years.`;
}

function fmtOutage(rawValue: number): string {
  const hours = roundMinutesToHours(rawValue);
  const phrase = hours <= 0 ? "**under an hour**" : `about **${hours} hour${hours === 1 ? "" : "s"}**`;
  return `This home's utility customers lost ${phrase} of power last year.`;
}

function fmtIncome100k(rawValue: number): string {
  const pct = roundToWholePercent(rawValue);
  return `Most households nearby (**${pct}%**) earn over $100k.`;
}

function fmtAge3564(rawValue: number): string {
  const pct = roundToWholePercent(rawValue);
  return `**${pct}%** of the neighborhood is prime working age (35-64).`;
}

/** Names the home's own county appraisal district; never a default county. */
function fmtHomeValue(rawValue: number, ctx: CaseSentenceContext): string {
  const who = ctx.cadShort ?? "The county appraisal district";
  return `${who} appraises this home at **${roundDollars(rawValue)}**.`;
}

/** The "installability" key's raw_value IS the year built (see
 * 0216_scoring_pass.sql: `s.yr_built::numeric` -- the rawUnit text is a
 * legacy flag description, not the actual value's meaning). */
function fmtInstallability(rawValue: number): string {
  const year = Math.round(rawValue);
  // Only 2000-or-later wiring supports the "straightforward" claim
  // (the scoring pass's own cutoff); an older build year is stated as a fact.
  if (year >= 2000) return `This home was **built in ${year}**, so installation should be straightforward.`;
  return `This home was **built in ${year}**.`;
}

function fmtHomePermits(rawValue: number): string | null {
  if (rawValue < 1) return null; // "no permit on file" is a fact for the checklist, not a knock-case sentence
  return `It already has a panel-upgrade, solar, EV, or generator permit on file.`;
}

export interface CaseSentenceContext {
  /** The home's county appraisal district, short form ("Travis CAD", "HCAD"). */
  cadShort?: string;
}

const TEMPLATES: Record<string, (rawValue: number, ctx: CaseSentenceContext) => string | null> = {
  backup_intent: fmtBackupIntent,
  outage: fmtOutage,
  income_100k: fmtIncome100k,
  age_35_64: fmtAge3564,
  home_value: fmtHomeValue,
  installability: fmtInstallability,
  home_permits: fmtHomePermits,
};

/** Signals with a case-sentence template, in the SAME relative order the
 * reason chips use (REASON_META iteration order in components/TopHomesTable.tsx
 * groups by family: outage, then grid/home_value, then install, then
 * household) -- ties in `term` fall back to this order so the prose and
 * the chips never disagree about which "top signal" comes first. */
const TEMPLATE_KEY_TIEBREAK_ORDER = [
  "outage",
  "home_value",
  "backup_intent",
  "installability",
  "home_permits",
  "income_100k",
  "age_35_64",
];

/**
 * Builds up to `maxParts` sentence fragments from a home's real breakdown
 * signals, strongest term first. Only signals that are available, have a
 * non-null rawValue, and have a template are considered; a signal whose
 * template returns null (e.g. home_permits with no permit on file) is
 * skipped, not forced into an empty sentence.
 */
export function buildCaseSentenceParts(
  signals: CaseSignalInput[],
  maxParts = 4,
  ctx: CaseSentenceContext = {}
): CaseSentencePart[] {
  const candidates = signals.filter(
    (s) => s.available && s.rawValue !== null && Object.prototype.hasOwnProperty.call(TEMPLATES, s.key)
  );

  const sorted = [...candidates].sort((a, b) => {
    const termA = a.term ?? -Infinity;
    const termB = b.term ?? -Infinity;
    if (termB !== termA) return termB - termA;
    return TEMPLATE_KEY_TIEBREAK_ORDER.indexOf(a.key) - TEMPLATE_KEY_TIEBREAK_ORDER.indexOf(b.key);
  });

  const parts: CaseSentencePart[] = [];
  for (const signal of sorted) {
    if (parts.length >= maxParts) break;
    const template = TEMPLATES[signal.key];
    const text = template(signal.rawValue as number, ctx);
    if (text === null) continue;
    parts.push({ key: signal.key, text });
  }
  return parts;
}

/** Splits a sentence containing `**bold**` markers into plain-text and
 * highlighted segments, for a renderer to turn into <b>/provenance-trigger
 * spans without a Markdown dependency. */
export function splitBoldMarkers(text: string): Array<{ bold: boolean; text: string }> {
  const parts: Array<{ bold: boolean; text: string }> = [];
  const re = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push({ bold: false, text: text.slice(lastIndex, match.index) });
    parts.push({ bold: true, text: match[1] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) parts.push({ bold: false, text: text.slice(lastIndex) });
  return parts;
}

// ---------------------------------------------------------------------------
// Meter captions: one rep-facing line per score signal, the real value in
// its own unit. Never "flag", "anchor", "term" or a bare 0/1 -- that detail
// lives in the Signals tab. Keys are the /ranking/breakdown signal keys.
// ---------------------------------------------------------------------------

function roundedPercent(v: number): string {
  return `${roundToWholePercent(v)} %`;
}

export function formatDollarsShort(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return roundDollars(value);
}

export function meterCaption(key: string, rawValue: number | null): string | null {
  if (rawValue === null || !Number.isFinite(rawValue)) return null;
  const v = rawValue;
  switch (key) {
    case "outage": {
      const h = roundMinutesToHours(v);
      return h === 0 ? "Under an hour without power a year" : `About ${h} hour${h === 1 ? "" : "s"} without power a year`;
    }
    case "backup_intent":
      return `About ${roundRatePer1000ToPer100(v)} in 100 nearby homes added backup`;
    case "home_permits":
      return v >= 1 ? "Has its own solar, EV or generator permit" : "No solar, EV or generator permit on file";
    case "installability":
      if (v > 1800) return `Built ${Math.round(v)}`;
      return v >= 1 ? "Built 2000 or later, or panel upgraded" : "Built before 2000";
    case "home_value":
      return `${formatDollarsShort(v)} appraisal`;
    case "owner_65":
      return v >= 1 ? "Homeowner 65+ exemption on file" : "No 65+ exemption on file";
    case "age65":
      return `${roundedPercent(v)} of neighbors are 65+`;
    case "age_35_64":
      return `${roundedPercent(v)} of neighbors are 35 to 64`;
    case "income_100k":
      return `${roundedPercent(v)} of households earn $100k+`;
    case "electric_heat":
      return `${roundedPercent(v)} of neighbors heat with electricity`;
    case "empower":
      return `About ${roundRatePer1000ToPer100(v)} in 100 Medicare users rely on powered devices`;
    case "flood":
      return v >= 1 ? "Inside FEMA high-risk zone" : "Outside FEMA high-risk zone";
    case "permit_risk":
      return `About ${Math.round(v)} days to a battery permit`;
    default:
      return null;
  }
}
