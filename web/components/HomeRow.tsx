"use client";

import Link from "next/link";
import type { ReactNode } from "react";

// One ranked-home row in the ranking rail (Mock A), shared by the
// "Likely to add backup" list (PredictedHomesTable) and the "Team
// priorities" list (TopHomesTable) so both modes read the same:
//
//   (1)  3901 Watersedge                         ● Top priority
//        Austin 78731 · built 2024 · Austin Energy   Base serves this utility
//        ● High-value home  ● Neighbors recently added backup
//        [expanded: the case for a knock, sources, meters, links]
//
// The rank chip is a 22 px forest circle on the first text line; the
// selected (expanded) row's chip gains a lime ring. Clicking anywhere but
// a link toggles the in-place expansion.

export interface HomeRowProps {
  propId: string;
  rank: number;
  street: string;
  meta: string;
  /** right column: tier (or team score) over the utility status */
  side: ReactNode;
  chips?: ReactNode;
  /** small line under the meta line, e.g. "Already has backup" */
  note?: ReactNode;
  /** ↑3 / ↓2 after a re-rank (team priorities mode) */
  rankDelta?: number;
  expanded: boolean;
  hovered: boolean;
  expandContent?: ReactNode;
  testId: string;
  onToggle: () => void;
  onHover: (on: boolean) => void;
}

export function HomeRow({
  propId,
  rank,
  street,
  meta,
  side,
  chips,
  note,
  rankDelta,
  expanded,
  hovered,
  expandContent,
  testId,
  onToggle,
  onHover,
}: HomeRowProps) {
  return (
    <div
      role="row"
      tabIndex={-1}
      aria-selected={expanded}
      className={"home-row" + (expanded ? " home-row--expanded" : "")}
      data-hovered={hovered || undefined}
      data-testid={testId}
      data-prop-id={propId}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button")) return;
        onToggle();
      }}
    >
      <span role="cell" className="home-row__rankcell">
        <span className="home-row__rank" aria-label={`Rank ${rank}`}>
          {rank}
        </span>
        {rankDelta ? (
          <span
            className={rankDelta > 0 ? "rank-delta rank-delta--up" : "rank-delta rank-delta--down"}
            aria-label={rankDelta > 0 ? `Moved up ${rankDelta}` : `Moved down ${Math.abs(rankDelta)}`}
          >
            {rankDelta > 0 ? "↑" : "↓"}
            {Math.abs(rankDelta)}
          </span>
        ) : null}
      </span>
      <span role="cell" className="home-row__main">
        <Link href={`/home/${propId}`} className="home-row__address" title={[street, meta].filter(Boolean).join(" · ")}>
          {street || propId}
        </Link>
        {meta ? <span className="home-row__meta">{meta}</span> : null}
        {note ? <span className="home-row__note">{note}</span> : null}
      </span>
      <span role="cell" className="home-row__side">
        {side}
      </span>
      {chips ? <span className="home-row__chips">{chips}</span> : null}
      {expanded && expandContent ? (
        <div className="home-row__expand" onClick={(e) => e.stopPropagation()}>
          {expandContent}
        </div>
      ) : null}
    </div>
  );
}
