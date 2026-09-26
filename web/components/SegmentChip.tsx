import { Chip } from "./ui/Chip";
import type { Segment } from "../lib/segments";

// GTM P0: the outreach segment a home falls in (lib/segments.ts), shown
// with the existing signal Chip so it uses the same colors as the reason
// it came from. The title carries the driver, so hovering explains it.

export function SegmentChip({ segment }: { segment: Segment | null }) {
  if (!segment) return null;
  return (
    <Chip
      signal={segment.signal}
      label={segment.name}
      title={`Outreach segment. Why: ${segment.drivenBy}`}
      data-segment={segment.key}
      className="segment-chip"
    />
  );
}
