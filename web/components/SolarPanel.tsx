"use client";

import { useEffect, useState } from "react";
import { Panel } from "./ui/Panel";
import { Figure } from "./ui/Figure";
import { MissingState } from "./ui/MissingState";

// M2-W2: on-demand Google Solar facts for one home, fetched client-side
// from /api/solar/[prop_id] on mount. This panel never stores anything —
// no localStorage, no swr/react-query cache layer, nothing persisted —
// it re-fetches live every time it mounts, matching the route's own
// `Cache-Control: no-store` and Google's API terms (never store a Solar
// API response).

interface SolarPanelData {
  available: true;
  imageryDate: string | null;
  imageryQuality: "HIGH" | "MEDIUM" | "LOW" | null;
  maxPanelCount: number | null;
  maxArrayAreaMeters2: number | null;
  roofSegmentCount: number | null;
  carbonOffsetFactorKgPerMwh: number | null;
  wholeRoofAreaMeters2: number | null;
  center: { lat: number; lng: number } | null;
}

interface SolarPanelUnavailable {
  available: false;
  reason: string;
}

type SolarResponse = SolarPanelData | SolarPanelUnavailable;

type LoadState =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "ready"; data: SolarPanelData };

export interface SolarPanelProps {
  propId: string;
}

export function SolarPanel({ propId }: SolarPanelProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetch(`/api/solar/${encodeURIComponent(propId)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as SolarResponse;
        if (cancelled) return;
        if (!body.available) {
          setState({ status: "unavailable", reason: body.reason });
        } else {
          setState({ status: "ready", data: body });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          reason: err instanceof Error ? err.message : "Failed to load Solar API data",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [propId]);

  return (
    <Panel>
      <h2
        style={{
          fontFamily: "var(--type-heading-font-family)",
          fontSize: "var(--type-heading-font-size)",
          fontWeight: "var(--type-heading-font-weight)",
          marginTop: 0,
        }}
      >
        Solar
      </h2>

      {state.status === "loading" ? (
        <div aria-busy="true" data-testid="solar-panel-skeleton" style={{ display: "grid", gap: "var(--space-2)" }}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                height: "1.1em",
                width: `${70 - i * 10}%`,
                borderRadius: "var(--rounded-sm)",
                backgroundColor: "var(--theme-divider)",
              }}
            />
          ))}
        </div>
      ) : state.status === "unavailable" ? (
        <MissingState variant="not-available" reason={state.reason} />
      ) : state.status === "error" ? (
        <MissingState variant="not-available" reason={state.reason} />
      ) : (
        <>
          <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "var(--space-2) var(--space-4)" }}>
            <dt style={{ color: "var(--theme-ink-muted)" }}>Imagery date</dt>
            <dd style={{ margin: 0 }}>
              {state.data.imageryDate === null ? (
                <MissingState variant="not-available" reason="Google Solar API did not return an imagery date" />
              ) : (
                <span style={{ fontFamily: "var(--type-data-font-family)" }}>{state.data.imageryDate}</span>
              )}
            </dd>

            <dt style={{ color: "var(--theme-ink-muted)" }}>Max panel count</dt>
            <dd style={{ margin: 0 }}>
              {state.data.maxPanelCount === null ? (
                <MissingState variant="not-available" reason="Google Solar API did not return a max panel count" />
              ) : (
                <Figure value={state.data.maxPanelCount} unit="panels" />
              )}
            </dd>

            <dt style={{ color: "var(--theme-ink-muted)" }}>Max array area</dt>
            <dd style={{ margin: 0 }}>
              {state.data.maxArrayAreaMeters2 === null ? (
                <MissingState variant="not-available" reason="Google Solar API did not return a max array area" />
              ) : (
                <Figure value={state.data.maxArrayAreaMeters2.toFixed(1)} unit="m²" />
              )}
            </dd>

            <dt style={{ color: "var(--theme-ink-muted)" }}>Roof segments</dt>
            <dd style={{ margin: 0 }}>
              {state.data.roofSegmentCount === null ? (
                <MissingState variant="not-available" reason="Google Solar API did not return roof segment stats" />
              ) : (
                <Figure value={state.data.roofSegmentCount} unit="segments" />
              )}
            </dd>

            <dt style={{ color: "var(--theme-ink-muted)" }}>Carbon offset factor</dt>
            <dd style={{ margin: 0 }}>
              {state.data.carbonOffsetFactorKgPerMwh === null ? (
                <MissingState variant="not-available" reason="Google Solar API did not return a carbon offset factor" />
              ) : (
                <Figure value={state.data.carbonOffsetFactorKgPerMwh.toFixed(1)} unit="kg CO2/MWh" />
              )}
            </dd>

            <dt style={{ color: "var(--theme-ink-muted)" }}>Whole-roof area</dt>
            <dd style={{ margin: 0 }}>
              {state.data.wholeRoofAreaMeters2 === null ? (
                <MissingState variant="not-available" reason="Google Solar API did not return whole-roof stats" />
              ) : (
                <Figure value={state.data.wholeRoofAreaMeters2.toFixed(1)} unit="m²" />
              )}
            </dd>
          </dl>
          <p
            style={{
              fontFamily: "var(--type-label-font-family)",
              fontSize: "var(--type-label-font-size)",
              color: "var(--theme-ink-muted)",
              marginBottom: 0,
            }}
          >
            Source: Google Solar API (live, not stored)
          </p>
        </>
      )}
    </Panel>
  );
}
