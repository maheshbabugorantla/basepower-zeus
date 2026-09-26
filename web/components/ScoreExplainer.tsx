"use client";

/**
 * ScoreExplainer — the score breakdown + "why this home" summary for one
 * home, at a given set of slider weights (M2-W5, github #65).
 *
 * PUBLIC PROPS CONTRACT (do not change without updating every caller):
 *
 *   <ScoreExplainer propId={propId} weights={weights} />
 *
 *   propId  — a home's prop_id, the same id every other page uses.
 *   weights — the same Record<SignalKey, number> shape WeightSliders
 *             produces/consumes elsewhere (web/app/api/top-homes/route.ts's
 *             SignalKey union). Pass live slider state to follow the
 *             sliders, or a fixed object (e.g. equalWeights()) to pin it.
 *
 * Mounted from /ranking (this ticket — see app/ranking/RankingBoard.tsx).
 * The home detail page (web/app/home/[prop_id]/page.tsx) is owned by a
 * different agent and may mount this same component with its own props —
 * this file is the single source of truth for the props shape above.
 *
 * Renders: a stacked contribution bar, a compact per-signal table, one
 * plain sentence on the formula, and — fetched separately, AFTER first
 * paint, so this component never blocks rendering on it — the
 * pre-generated "why this home" summary, or a deterministic template
 * sentence computed here (client-side, no LLM) when none is stored yet.
 *
 * No code path in this file calls Gemini. It only ever calls:
 *   - POST /ranking/breakdown  — the live, weights-following SQL
 *     breakdown (a primary-key lookup; recomputes as the sliders move).
 *   - GET  /api/home-summary   — a primary-key read of a summary
 *     pre-generated offline by pipelines/sources/home_summaries.py.
 */

import { useEffect, useRef, useState } from "react";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "./ui/DataTable";
import { MissingState } from "./ui/MissingState";
import { REASON_META } from "./TopHomesTable";
import { SignalsUsed, type SignalUsedEntry } from "./SignalsUsed";
import type { SignalKey } from "../app/api/top-homes/route";

const DEBOUNCE_MS = 250;
const SUMMARY_FETCH_TIMEOUT_MS = 8000;

export interface ScoreExplainerProps {
  propId: string;
  weights: Record<SignalKey, number>;
}

export interface BreakdownSignal {
  key: string;
  label: string;
  rawValue: number | null;
  rawUnit: string;
  percentile: number | null;
  weight: number;
  contribution: number | null;
  available: boolean;
  nullReason: string | null;
  /** M2-P8: the 0–1 anchored term itself (real value / anchor, capped at
   * 1) and its anchor's real value + plain-language basis — replaces the
   * discarded percentile as the score's actual input. */
  term: number | null;
  anchorValue: number | null;
  anchorBasis: string | null;
}

type SummaryStatus = "loading" | "loaded" | "template";

interface SummaryState {
  status: SummaryStatus;
  summary: string | null;
  model: string | null;
  generatedAt: string | null;
}

function formatNumber(value: number, decimals = 1): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Deterministic fallback — no LLM, built only from the top 2 available
 * contributions. Mirrors pipelines/sources/home_summaries.py's
 * build_template_sentence() (same idea: the two strongest signals by
 * contribution) but is implemented independently here — this client
 * component never imports pipeline code. Exported for
 * web/tests/m2-explain (real-breakdown-data tests), not used outside
 * this file otherwise. */
export function buildTemplateSentence(signals: BreakdownSignal[]): string {
  const available = signals.filter((s) => s.available && s.contribution !== null);
  const top2 = [...available].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0)).slice(0, 2);
  if (top2.length === 0) {
    return "No signal has usable data for this home yet — every score input is currently marked not loaded or not available.";
  }
  const describe = (s: BreakdownSignal) =>
    `${s.label.replace(/\s*\(.*\)$/, "")} (${formatNumber(s.rawValue ?? 0, s.key === "backup_intent" ? 2 : 1)} ${s.rawUnit})`;
  if (top2.length === 1) return `This home's strongest scored signal is ${describe(top2[0])}.`;
  return `This home's two strongest scored signals are ${describe(top2[0])} and ${describe(top2[1])}.`;
}

export function ScoreExplainer({ propId, weights }: ScoreExplainerProps) {
  const [signals, setSignals] = useState<BreakdownSignal[] | null>(null);
  const [outageBasis, setOutageBasis] = useState<string | null>(null);
  const [outageDistributorName, setOutageDistributorName] = useState<string | null>(null);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryState>({
    status: "loading",
    summary: null,
    model: null,
    generatedAt: null,
  });
  const requestSeq = useRef(0);

  // Live breakdown — debounced like the ranking table's own re-rank fetch,
  // so a slider drag doesn't fire one request per tick.
  useEffect(() => {
    const mySeq = ++requestSeq.current;
    const debounceTimer = setTimeout(async () => {
      try {
        const response = await fetch("/ranking/breakdown", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ propId, weights }),
        });
        if (!response.ok) throw new Error(`Breakdown request failed (HTTP ${response.status})`);
        const data: {
          signals: BreakdownSignal[];
          outageBasis?: string | null;
          outageDistributorName?: string | null;
        } = await response.json();
        if (mySeq !== requestSeq.current) return;
        setSignals(data.signals);
        setOutageBasis(data.outageBasis ?? null);
        setOutageDistributorName(data.outageDistributorName ?? null);
        setBreakdownError(null);
      } catch (err) {
        if (mySeq !== requestSeq.current) return;
        setBreakdownError(err instanceof Error ? err.message : "Failed to load the score breakdown");
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propId, weights]);

  // Stored summary — fetched once per propId, independently of weights,
  // strictly AFTER this component has already rendered. A slow or failed
  // fetch (8s timeout) never blocks the breakdown above; it only falls
  // back to the template sentence.
  useEffect(() => {
    let cancelled = false;
    setSummary({ status: "loading", summary: null, model: null, generatedAt: null });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SUMMARY_FETCH_TIMEOUT_MS);

    (async () => {
      try {
        const response = await fetch(`/api/home-summary?propId=${encodeURIComponent(propId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`home-summary request failed (HTTP ${response.status})`);
        const data: { summary: string | null; model?: string | null; generatedAt?: string | null } =
          await response.json();
        if (cancelled) return;
        if (data.summary) {
          setSummary({
            status: "loaded",
            summary: data.summary,
            model: data.model ?? null,
            generatedAt: data.generatedAt ?? null,
          });
        } else {
          setSummary({ status: "template", summary: null, model: null, generatedAt: null });
        }
      } catch {
        if (!cancelled) setSummary({ status: "template", summary: null, model: null, generatedAt: null });
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, [propId]);

  if (breakdownError) {
    return <MissingState variant="not-loaded" reason={breakdownError} />;
  }
  if (!signals) {
    return <p style={{ color: "var(--theme-ink-muted)", margin: 0 }}>Loading score breakdown…</p>;
  }

  const totalScore = signals.reduce((sum, s) => sum + (s.contribution ?? 0), 0);
  const contributingSignals = signals.filter(
    (s) => s.available && s.contribution !== null && s.contribution > 0
  );
  const templateSentence = summary.status === "template" ? buildTemplateSentence(signals) : null;

  // M3-W1: signals-used chips — every non-null term this home was
  // actually scored on (not just the top-3 contributors), derived from
  // this same live breakdown response, no new SQL.
  const signalsUsed: SignalUsedEntry[] = signals
    .filter((s) => s.available)
    .map((s) => {
      const meta = REASON_META[s.key];
      return { key: s.key, label: meta?.label ?? s.label, signal: meta?.signal ?? "install" };
    });

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <p style={{ margin: 0, color: "var(--theme-ink-muted)", maxWidth: "70ch" }}>
        Score = a weighted average of this home&apos;s term on each signal below (its real value divided by a fixed
        anchor, capped at 1); signals with no
        data are left out of the average, not counted as zero.
      </p>
      <div>
        <p
          style={{
            margin: "0 0 var(--space-2) 0",
            fontFamily: "var(--type-label-font-family)",
            fontSize: "var(--type-label-font-size)",
            color: "var(--theme-ink-muted)",
          }}
        >
          Signals this home was scored on
        </p>
        <SignalsUsed signals={signalsUsed} />
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--space-1)" }}>
          <span style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            Overall score
          </span>
          <span className="top-homes-score">
            <span className="top-homes-score__bar-track">
              <span
                className="top-homes-score__bar-fill"
                style={{ width: `${Math.max(0, Math.min(1, totalScore)) * 100}%` }}
              />
            </span>
            <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
              {totalScore.toFixed(3)}
            </span>
          </span>
        </div>

        {/* Stacked contribution bar: each segment is one signal's share of
            the total score, in the same 4 named DESIGN.md signal colors
            (validated color-blind distinct) the rest of the app uses for
            these signals — never the green score ramp, which is reserved
            for the score itself (above), per DESIGN.md's "Green Means
            Score" rule. */}
        <div
          role="img"
          aria-label={`Score breakdown: ${
            contributingSignals.map((s) => `${s.label}, contribution ${(s.contribution ?? 0).toFixed(3)}`).join("; ") ||
            "no signal currently contributes"
          }`}
          style={{
            display: "flex",
            height: "14px",
            borderRadius: "var(--rounded-sm)",
            overflow: "hidden",
            backgroundColor: "var(--theme-divider)",
          }}
        >
          {contributingSignals.map((s) => {
            const meta = REASON_META[s.key];
            const widthPct = Math.max(0, Math.min(100, (s.contribution ?? 0) * 100));
            return (
              <span
                key={s.key}
                title={`${s.label}: ${(s.contribution ?? 0).toFixed(3)}`}
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: meta ? `var(--color-signal-${meta.signal})` : "var(--theme-ink-muted)",
                }}
              />
            );
          })}
        </div>
      </div>

      <DataTable style={{ tableLayout: "fixed" }}>
        <DataTableHead>
          <DataTableRow>
            <DataTableHeaderCell>Signal</DataTableHeaderCell>
            <DataTableHeaderCell>This home</DataTableHeaderCell>
            <DataTableHeaderCell>Score term (real value ÷ anchor, capped at 1)</DataTableHeaderCell>
            <DataTableHeaderCell>Adds to score</DataTableHeaderCell>
          </DataTableRow>
        </DataTableHead>
        <DataTableBody>
          {signals.map((s) => (
            <DataTableRow key={s.key}>
              <DataTableCell>{s.label}</DataTableCell>
              <DataTableCell>
                {s.available && s.rawValue !== null ? (
                  s.key === "flood" ? (
                    <span>{s.rawValue > 0 ? "Inside a FEMA high-risk flood zone" : "Outside FEMA high-risk flood zones"}</span>
                  ) : (
                    <span>
                      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                        {formatNumber(s.rawValue, s.key === "backup_intent" ? 2 : 1)}
                      </span>{" "}
                      {s.rawUnit}
                    </span>
                  )
                ) : (
                  <MissingState variant="not-loaded" reason={s.nullReason ?? "Not loaded"} />
                )}
                {s.key === "outage" && s.available ? (
                  <div style={{ marginTop: "var(--space-1)", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                    {outageBasis === "county_eaglei_proxy"
                      ? `Travis County average (EAGLE-I), used because ${outageDistributorName ?? "this home's utility"} doesn't report to EIA`
                      : outageBasis === "distributor_saidi"
                        ? `${outageDistributorName ?? "This distributor"}'s own reported SAIDI (EIA-861)`
                        : null}
                  </div>
                ) : null}
              </DataTableCell>
              <DataTableCell>
                {s.available && s.term !== null ? (
                  <span>
                    <span style={{ fontFamily: "var(--type-data-font-family)" }}>{s.term.toFixed(3)}</span>
                    {s.anchorValue !== null ? (
                      <span style={{ display: "block", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                        of anchor {formatNumber(s.anchorValue, 1)}
                        {s.anchorBasis ? ` (${s.anchorBasis})` : ""}
                      </span>
                    ) : s.anchorBasis ? (
                      <span style={{ display: "block", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                        {s.anchorBasis}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span style={{ color: "var(--theme-ink-muted)" }}>No data</span>
                )}
              </DataTableCell>
              <DataTableCell>
                {s.available && s.contribution !== null ? (
                  <span style={{ fontFamily: "var(--type-data-font-family)" }}>{s.contribution.toFixed(3)}</span>
                ) : (
                  <span style={{ color: "var(--theme-ink-muted)" }}>Dropped, not counted</span>
                )}
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>

      <div>
        <div
          style={{
            fontSize: "var(--type-label-font-size)",
            color: "var(--theme-ink-muted)",
            marginBottom: "var(--space-1)",
          }}
        >
          {summary.status === "loaded"
            ? `AI summary (Gemini ${summary.model ?? "model"}) at equal weights${
                summary.generatedAt ? `, generated ${new Date(summary.generatedAt).toLocaleDateString()}` : ""
              }`
            : "Summary (built from the numbers above — no stored AI summary yet for this home)"}
        </div>
        <p style={{ margin: 0 }}>
          {summary.status === "loading" ? "Loading summary…" : summary.status === "loaded" ? summary.summary : templateSentence}
        </p>
        {summary.status === "loaded" ? (
          <p
            style={{
              margin: "var(--space-1) 0 0 0",
              fontSize: "var(--type-label-font-size)",
              color: "var(--theme-ink-muted)",
            }}
          >
            This summary reflects equal weights across every signal, not the sliders above.
          </p>
        ) : null}
      </div>
    </div>
  );
}
