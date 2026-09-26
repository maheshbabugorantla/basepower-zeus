import { Panel } from "../../components/ui/Panel";
import { Chip } from "../../components/ui/Chip";
import { MissingState } from "../../components/ui/MissingState";
import { DecisionHeader } from "../../components/DecisionHeader";
import { getCountiesWithScoredHomes } from "../../lib/counties.server";
import { resolveCounty } from "../../lib/counties";
import { getAudienceSummary, formatExpected } from "../../lib/audiences.server";
import { SEGMENTS, HOLDOUT_SHARE, type SegmentKey } from "../../lib/segments";

// GTM P0: Audiences. Splits the county's rankable homes into outreach
// segments by the model's strongest raising reason (lib/segments.ts), and
// sizes each by homes and the model's expected adopters. Messages and
// channels are team copy, labelled as suggestions. Each segment exports
// straight to CSV with its message and a stable holdout flag.

export const dynamic = "force-dynamic";

export default async function AudiencesPage({
  searchParams,
}: {
  searchParams: Promise<{ county?: string }>;
}) {
  const [{ county: requestedCounty }, availableCounties] = await Promise.all([
    searchParams,
    getCountiesWithScoredHomes(),
  ]);
  const county = resolveCounty(requestedCounty, availableCounties);
  const summary = await getAudienceSummary(county.fips);

  const largest = summary?.segments
    .filter((s) => s.key !== "no_clear_driver")
    .reduce<typeof summary.segments[number] | null>(
      (best, s) => (best === null || s.expectedAdopters > best.expectedAdopters ? s : best),
      null
    );

  const answer =
    summary === null ? (
      "Segment sizes are not loaded yet."
    ) : (
      <>
        {summary.totalHomes.toLocaleString("en-US")} {county.name} homes Base can serve and that don&rsquo;t already
        have backup. The model expects {formatExpected(summary.totalExpectedAdopters)} of them to add backup in the
        next 12 months.
        {largest ? (
          <>
            {" "}
            The biggest opportunity is <strong>{SEGMENTS[largest.key as SegmentKey].name}</strong> (
            {formatExpected(largest.expectedAdopters)} expected).
          </>
        ) : null}
      </>
    );

  return (
    <div style={{ display: "grid", gap: "var(--space-6)", maxWidth: "1000px" }}>
      <DecisionHeader
        question="Who do we contact, and what do we say?"
        answer={answer}
        evidence={{ href: `/ranking?county=${county.fips}`, label: "every home and its top 3 reasons" }}
      />

      <p className="team-copy-note" style={{ margin: 0 }}>
        A home&rsquo;s segment is the strongest reason the model gives for it, among reasons that raise its
        likelihood. Messages and channels are the team&rsquo;s suggestions, not data. Expected adopters are a
        model estimate: the sum of each home&rsquo;s calibrated 12-month likelihood. Every export holds out a fixed{" "}
        {Math.round(HOLDOUT_SHARE * 100)}% of homes as a no-contact group, so lift can be measured.
      </p>

      {summary === null ? (
        <MissingState variant="not-loaded" reason="Model likelihoods for this county are not loaded yet" />
      ) : (
        summary.segments.map((size) => {
          if (size.key === "no_clear_driver") {
            return (
              <Panel key={size.key} className="segment-card">
                <h2 style={{ margin: 0, fontSize: "var(--type-heading-font-size)" }}>No clear driver</h2>
                <p className="segment-card__copy">
                  {size.homes.toLocaleString("en-US")} homes where none of the model&rsquo;s top 3 reasons raises the
                  likelihood. Leave them out of targeted campaigns.
                </p>
              </Panel>
            );
          }
          const segment = SEGMENTS[size.key];
          const exportHref = `/export/homes?county=${county.fips}&segment=${segment.key}`;
          return (
            <Panel key={size.key} className="segment-card" data-segment={segment.key}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
                <h2 style={{ margin: 0, fontSize: "var(--type-heading-font-size)" }}>{segment.name}</h2>
                {segment.areaLevelOnly ? <Chip signal={segment.signal} label="Area-level signal" /> : null}
              </div>
              <p className="segment-card__copy">Why they&rsquo;re here: {segment.drivenBy}.</p>
              <div className="segment-card__stats">
                <span>
                  <strong style={{ fontFamily: "var(--type-data-font-family)" }}>
                    {size.homes.toLocaleString("en-US")}
                  </strong>{" "}
                  homes
                </span>
                <span>
                  <strong style={{ fontFamily: "var(--type-data-font-family)" }}>
                    {formatExpected(size.expectedAdopters)}
                  </strong>{" "}
                  expected to add backup in 12 months (model estimate)
                </span>
              </div>
              <p className="segment-card__message">&ldquo;{segment.message}&rdquo;</p>
              <p className="segment-card__copy">Suggested channel: {segment.channel}</p>
              <div>
                <a href={exportHref} download className="btn btn--secondary" data-testid={`export-segment-${segment.key}`}>
                  Export {segment.name} list (CSV)
                </a>
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}
