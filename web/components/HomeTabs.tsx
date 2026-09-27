"use client";

/**
 * HomeTabs — the home record's tab shell (Mock B, critique P0/P1: "home
 * detail is a 430-line block with zero <h3>s" / "12-row score table,
 * permits, parcel, solar" all stacked in one column). Summary (default),
 * Signals, Permits, Parcel & solar, Sources — each section's content is
 * passed in as a prop (already server-rendered by app/home/[prop_id]/page.tsx;
 * nothing here re-fetches anything).
 *
 * Only the ACTIVE tab's content is ever mounted (not just CSS-hidden) --
 * ParcelMap/SolarPanel are MapLibre/iframe-heavy and would otherwise
 * initialize at 0x0 while their tab is display:none and never resize
 * when shown later. The small cost is a remount on every tab switch,
 * which is cheap here (server-rendered props, no client fetch).
 *
 * The active tab lives in `?tab=`, via a Context so a plain link deep in
 * server-rendered content (e.g. "All 12 signals", "All 7 permits") can
 * jump to a different tab -- JumpToTab below reads that same context.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type HomeTabId = "summary" | "signals" | "permits" | "parcel" | "sources";

const HomeTabContext = createContext<{ tab: HomeTabId; setTab: (t: HomeTabId) => void } | null>(null);

/** A link that switches the active tab instead of navigating -- used
 * from inside server-rendered content (e.g. "All 12 signals"). Renders
 * as a real <a href="?tab=..."> so it still works with JS disabled /
 * before hydration, but intercepts the click once mounted. */
export function JumpToTab({ tab, children }: { tab: HomeTabId; children: ReactNode }) {
  const ctx = useContext(HomeTabContext);
  return (
    <a
      href={`?tab=${tab}`}
      onClick={(e) => {
        if (!ctx) return; // no JS yet / outside HomeTabs -- let the real navigation happen
        e.preventDefault();
        ctx.setTab(tab);
      }}
    >
      {children}
    </a>
  );
}

export interface HomeTabsProps {
  signalsCount: number;
  permitsCount: number;
  sourcesCount: number;
  summary: ReactNode;
  signals: ReactNode;
  permits: ReactNode;
  parcelSolar: ReactNode;
  sources: ReactNode;
}

const TAB_META: Array<{ id: HomeTabId; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "signals", label: "Signals" },
  { id: "permits", label: "Permits" },
  { id: "parcel", label: "Parcel & solar" },
  { id: "sources", label: "Sources" },
];

// Read straight from window.location, never next/navigation's
// useSearchParams()/usePathname() -- same reasoning RankingBoard.tsx
// already documents for its own URL sync: those hooks need a Suspense
// boundary and re-render every consumer on each change, AND (found by
// this ticket's own test suite) return nothing usable when a page is
// rendered outside Next's own request pipeline (e.g. a test calling
// renderToStaticMarkup(await HomeDetailPage(...)) directly) -- there is
// no App Router context to read from there, so this must degrade to the
// server-rendered default ("summary") instead of throwing/suspending.
function initialTabFromLocation(): HomeTabId {
  if (typeof window === "undefined") return "summary";
  const p = new URLSearchParams(window.location.search).get("tab") as HomeTabId | null;
  return p && TAB_META.some((t) => t.id === p) ? p : "summary";
}

function HomeTabsInner({ signalsCount, permitsCount, sourcesCount, summary, signals, permits, parcelSolar, sources }: HomeTabsProps) {
  const [tab, setTabState] = useState<HomeTabId>("summary");

  // Sync from the real URL once mounted (server-rendered HTML always
  // starts on "summary", exactly like the rest of this app's hydration
  // pattern) -- avoids a hydration mismatch from reading window at
  // useState-initializer time.
  useEffect(() => {
    setTabState(initialTabFromLocation());
  }, []);

  function setTab(next: HomeTabId) {
    setTabState(next);
    const params = new URLSearchParams(window.location.search);
    if (next === "summary") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    window.history.replaceState(window.history.state, "", qs ? `?${qs}` : window.location.pathname);
  }

  // Keep in sync if the browser's own back/forward changes ?tab=.
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(window.location.search).get("tab") as HomeTabId | null;
      setTabState(p && TAB_META.some((t) => t.id === p) ? p : "summary");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const counts: Partial<Record<HomeTabId, number>> = {
    signals: signalsCount,
    permits: permitsCount,
    sources: sourcesCount,
  };

  const content: Record<HomeTabId, ReactNode> = {
    summary,
    signals,
    permits,
    parcel: parcelSolar,
    sources,
  };

  return (
    <HomeTabContext.Provider value={{ tab, setTab }}>
      <div className="home-tabs" role="tablist" aria-label="Home record sections">
        {TAB_META.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={"home-tabs__tab" + (tab === t.id ? " home-tabs__tab--on" : "")}
            onClick={() => setTab(t.id)}
            data-testid={`home-tab-${t.id}`}
          >
            {t.label}
            {counts[t.id] !== undefined ? <small>{counts[t.id]}</small> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-testid={`home-tabpanel-${tab}`}>
        {content[tab]}
      </div>
    </HomeTabContext.Provider>
  );
}

export function HomeTabs(props: HomeTabsProps) {
  return <HomeTabsInner {...props} />;
}
