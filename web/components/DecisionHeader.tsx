import Link from "next/link";
import type { ReactNode } from "react";

// GTM P0: every page opens with the decision it supports -- the question
// a Base growth team is asking, the answer this page gives, and a link to
// the evidence underneath. The page's own h1 stays the question so the
// page still reads top-down for screen readers.

export interface DecisionHeaderProps {
  /** The question this page answers, in the team's words. Rendered as the h1. */
  question: string;
  /** The answer, one or two sentences, built only from loaded data. */
  answer: ReactNode;
  /** Where the evidence behind the answer lives. */
  evidence?: { href: string; label: string };
  /** Optional next step (e.g. "Pick audiences"). */
  next?: { href: string; label: string };
}

export function DecisionHeader({ question, answer, evidence, next }: DecisionHeaderProps) {
  return (
    <header className="decision-header">
      <span className="decision-header__eyebrow">Decision</span>
      <h1 className="decision-header__question">{question}</h1>
      <p className="decision-header__answer">{answer}</p>
      {evidence || next ? (
        <div className="decision-header__links">
          {evidence ? (
            <Link href={evidence.href} className="decision-header__evidence">
              Evidence: {evidence.label}
            </Link>
          ) : null}
          {next ? (
            <Link href={next.href} className="btn btn--primary decision-header__next">
              {next.label} →
            </Link>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
