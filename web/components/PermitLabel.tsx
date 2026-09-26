// M1-W3 fix: DESIGN.md "The Missing Is Grey Rule" distinguishes "not
// loaded" (pipeline hasn't run) from a real, checked-and-negative result.
// core.permit_labels only ever gets a row for a permit the rules
// classifier *matched* to a category (battery/ev/generator/panel/solar) —
// a permit it checked and found no match for gets no row at all, so
// `label` is null in both the "classifier hasn't run yet" case and the
// "checked, no match" case. The two must render differently:
//   - classifierHasRun === false -> MissingState (not-loaded)
//   - classifierHasRun === true, label === null -> plain muted "No backup
//     label" (a real, checked negative — never the not-loaded chip)
// `classifierHasRun` is computed once per page load as
// `exists(select 1 from core.permit_labels where labeller = 'rules')` —
// never per-permit, since the classifier runs over every permit in one
// pass.

import { MissingState } from "./ui/MissingState";

export interface PermitLabelProps {
  label: string | null;
  labeller: string | null;
  classifierHasRun: boolean;
}

export function PermitLabel({ label, labeller, classifierHasRun }: PermitLabelProps) {
  if (label !== null) {
    return (
      <span>
        {label} ({labeller})
      </span>
    );
  }

  if (!classifierHasRun) {
    return (
      <MissingState
        variant="not-loaded"
        reason="The rules classifier has not labelled any permits yet"
      />
    );
  }

  return <span style={{ color: "var(--theme-ink-muted)" }}>No backup label</span>;
}
