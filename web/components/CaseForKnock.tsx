"use client";

/**
 * CaseForKnock — the rep-facing "case for a knock": a plain-English
 * sentence built from a home's real top score terms, plus up to 3 meters
 * (the real score terms behind the sentence — value ÷ anchor, capped at
 * 1). Fetches POST /ranking/breakdown once (no LLM, no synthetic data —
 * see web/lib/caseSentence.ts for the sentence rules).
 *
 * Shared by app/ranking/RankingBoard.tsx's in-row expansion (both
 * PredictedHomesTable and TopHomesTable rows) and the home record's
 * Summary tab, so "why this home ranks" reads identically everywhere.
 */

import { useEffect, useRef, useState } from "react";
import { MissingState, plainReason } from "./ui/MissingState";
import { buildCaseSentenceParts, meterCaption, splitBoldMarkers, type CaseSignalInput } from "../lib/caseSentence";
import { REASON_META } from "./TopHomesTable";
import { signalSource } from "../lib/homeRowFormat";
import type { SignalKey } from "../app/api/top-homes/route";

const DEBOUNCE_MS = 200;

interface BreakdownResponse {
  signals: CaseSignalInput[];
}

function useBreakdown(propId: string, weights: Record<SignalKey, number>) {
  const [signals, setSignals] = useState<CaseSignalInput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/ranking/breakdown", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ propId, weights }),
        });
        if (!response.ok) throw new Error(`Breakdown request failed (HTTP ${response.status})`);
        const data: BreakdownResponse = await response.json();
        if (mySeq !== seq.current) return;
        setSignals(data.signals);
        setError(null);
      } catch (err) {
        if (mySeq !== seq.current) return;
        setError(err instanceof Error ? err.message : "Failed to load this home's score breakdown");
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [propId, weights]);

  return { signals, error };
}

function CaseSentenceText({ text }: { text: string }) {
  return (
    <>
      {splitBoldMarkers(text).map((part, i) =>
        part.bold ? (
          <b key={i} className="case-sentence__figure">
            {part.text}
          </b>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}{" "}
    </>
  );
}

/** Up to 3 meters: the home's top-3 by term, real value / anchor capped
 * at 1 — never a synthetic 0-100 vibe number. */
function Meters({ signals, max = 3, includeMissing = false }: { signals: CaseSignalInput[]; max?: number; includeMissing?: boolean }) {
  // Flood is a penalty-only signal (it can lower a score, never raise it),
  // so it is never shown as one of a home's strongest terms.
  const withTerms = signals
    .filter((s) => s.available && s.term !== null && s.key !== "flood")
    .sort((a, b) => (b.term ?? 0) - (a.term ?? 0))
    .slice(0, max);

  // Summary tab (Mock B): "up to six meters, including the not-available
  // hatch meter for a missing signal" -- one real missing/unavailable
  // signal fills a remaining slot, shown as a hatch track, never a fake
  // fill. Never invented: only ever a signal this home's own breakdown
  // actually marked unavailable, with its own real null_reason.
  const missing = includeMissing && withTerms.length < max ? signals.find((s) => !s.available) : undefined;

  if (withTerms.length === 0 && !missing) {
    return <MissingState variant="not-loaded" reason="No score terms available for this home yet" />;
  }

  return (
    <div className="case-meters">
      {withTerms.map((s) => {
        const meta = REASON_META[s.key];
        const pct = Math.max(0, Math.min(1, s.term ?? 0)) * 100;
        return (
          <div key={s.key} className="case-meter">
            <div className="case-meter__label">
              <span>{REASON_META[s.key]?.label ?? s.label}</span>
            </div>
            <div className="case-meter__track">
              <span
                className="case-meter__fill"
                style={{ width: `${pct}%`, backgroundColor: meta ? `var(--color-signal-${meta.signal})` : undefined }}
              />
            </div>
            <div className="case-meter__value">{meterCaption(s.key, s.rawValue) ?? meta?.label ?? s.label}</div>
          </div>
        );
      })}
      {missing ? (
        <div key={missing.key} className="case-meter case-meter--na">
          <div className="case-meter__label">
            <span>{REASON_META[missing.key]?.label ?? missing.label}</span>
            <span>not scored</span>
          </div>
          <div className="case-meter__track case-meter__track--hatch" />
          <div className="case-meter__value">
            <span className="case-meter__unit">{missing.nullReason ? plainReason(missing.nullReason) : "Not available"}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface CaseForKnockProps {
  propId: string;
  /** Predicted mode has no team weights; pass equalWeights() there —
   * term/anchor/rawValue never depend on the weight, only `contribution`
   * does, so the sentence and meters are identical either way. */
  weights: Record<SignalKey, number>;
  /** Real sources actually behind this home's signals, for the one-line
   * "N sources" note under the sentence — passed by the caller so this
   * component never invents a dataset list. */
  sourceNames?: string[];
  /** Short appraisal-district name for the home's county (e.g. "Travis
   * CAD", "HCAD"). When given and `sourceNames` is not, the sources note is
   * built from the datasets behind the signals this component actually
   * shows (sentence + meters), so a Harris home never cites Austin data. */
  cadShort?: string;
  compact?: boolean;
  /** Summary tab (Mock B) wants up to 6 meters (incl. one "not scored"
   * hatch meter); the row expansion (Mock A) wants 3. */
  maxMeters?: number;
  includeMissingMeter?: boolean;
}

export function CaseForKnock({
  propId,
  weights,
  sourceNames,
  cadShort,
  compact = false,
  maxMeters = 3,
  includeMissingMeter = false,
}: CaseForKnockProps) {
  const { signals, error } = useBreakdown(propId, weights);

  if (error) return <MissingState variant="not-loaded" reason={error} />;
  if (!signals) return <p style={{ margin: 0, color: "var(--theme-ink-muted)" }}>Loading the case for a knock…</p>;

  const parts = buildCaseSentenceParts(signals as CaseSignalInput[], compact ? 3 : 4, { cadShort });

  // Sources behind what is on screen: the sentence's signals plus the
  // meters' (top terms), each mapped to its dataset, de-duplicated in order.
  let sources: string[] = sourceNames ?? [];
  if (!sourceNames && cadShort) {
    const meterKeys = (signals as CaseSignalInput[])
      .filter((sig) => sig.available && sig.term !== null && sig.key !== "flood")
      .sort((a, b) => (b.term ?? 0) - (a.term ?? 0))
      .slice(0, maxMeters)
      .map((sig) => sig.key);
    const keys = [...parts.map((p) => p.key), ...meterKeys];
    sources = Array.from(new Set(keys.map((k) => signalSource(k, cadShort)).filter((x): x is string => x !== null)));
  }

  return (
    <div className="case-for-knock">
      {parts.length === 0 ? (
        <MissingState
          variant="not-loaded"
          reason="No signal has usable data for this home yet — every score input is currently marked not loaded or not available"
        />
      ) : (
        <p className={compact ? "case-for-knock__sentence case-for-knock__sentence--compact" : "case-for-knock__sentence"}>
          {parts.map((part) => (
            <CaseSentenceText key={part.key} text={part.text} />
          ))}
        </p>
      )}
      {sources.length > 0 ? (
        <p className="case-for-knock__sources">
          {sources.length} source{sources.length === 1 ? "" : "s"} · {sources.join(", ")} · each figure's file is under All 12 signals
        </p>
      ) : null}
      <Meters signals={signals as CaseSignalInput[]} max={maxMeters} includeMissing={includeMissingMeter} />
    </div>
  );
}
