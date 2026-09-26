import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { ProvenancePopover } from "../../components/ui/ProvenancePopover";
import { getPool, query } from "../../lib/db";

// DESIGN.md §5 Signature component + M0-W0 acceptance criteria: the
// provenance popover uses the native popover API (never clipped, by
// construction — it renders in the top layer) and is keyboard-operable
// (a real <button popovertarget> gets Enter/Space-to-open and Esc-to-close
// for free from the browser, with no custom JS required for that part).
//
// Where possible this is exercised against a *real* row from
// api.sources — never a fabricated dataset/URL/SHA. When POSTGRES_URL
// isn't set (as in CI without secrets), that describe block is skipped
// entirely rather than substituting fake values, and the structural test
// below still runs using only prop *names*, not fabricated values.

describe("ProvenancePopover", () => {
  it("is a real popover element wired to a real trigger button", () => {
    // The literal strings below are structural test fixtures for prop
    // wiring/markup shape only (id plumbing, attribute presence) — never
    // presented in the UI as if they were real provenance data.
    const html = renderToStaticMarkup(
      <ProvenancePopover
        id="test-fixture"
        dataset="test-dataset"
        url="https://example.invalid/test"
        retrievedAt="test-retrieved-at"
        sha256={"0".repeat(64)}
        runId="test-run-id"
        runner="cli"
        rowsIn={null}
        rowsLoaded={null}
        rawFileHref="https://example.invalid/raw"
      >
        trigger text
      </ProvenancePopover>
    );

    // Trigger: a real <button>, styled as text, pointing at the popover.
    // (React 19.2's SSR renderer serializes the popoverTarget prop with
    // its camelCase JSX name rather than lowercasing it to the HTML
    // attribute spelling; real HTML parsers lowercase attribute names on
    // parse regardless of source casing, so this is not a bug in the
    // component — matched case-insensitively here for that reason.)
    expect(html).toMatch(/<button[^>]*id="test-fixture-trigger"[^>]*popovertarget="test-fixture-popover"[^>]*>/i);
    expect(html).toContain("trigger text");

    // Popover: `popover` attribute present (top layer -> never clipped).
    expect(html).toMatch(/<span[^>]*id="test-fixture-popover"[^>]*popover="auto"[^>]*>/i);

    // Content present: dataset/url, retrievedAt, truncated sha + copy
    // button, run id/runner, rows in/loaded, raw file link.
    expect(html).toContain("test-dataset");
    expect(html).toContain("https://example.invalid/test");
    expect(html).toContain("test-retrieved-at");
    expect(html).toContain("0000000000"); // truncated sha prefix
    expect(html).toContain("Copy full");
    expect(html).toContain("test-run-id");
    expect(html).toContain("cli");
    expect(html).toContain("not recorded"); // rowsIn/rowsLoaded null -> reason, never blank/dash
    expect(html).toContain("View raw file");
    expect(html).toContain('href="https://example.invalid/raw"');
  });

  it("truncates the SHA-256 but keeps the full value available (title attr) for copy", () => {
    const fullSha = "abcd1234ef567890" + "0".repeat(48);
    const html = renderToStaticMarkup(
      <ProvenancePopover
        id="test-fixture-2"
        dataset="test-dataset"
        url="https://example.invalid/test"
        retrievedAt="test-retrieved-at"
        sha256={fullSha}
        runId="test-run-id"
        runner="cron"
        rowsIn={null}
        rowsLoaded={null}
        rawFileHref="https://example.invalid/raw"
      >
        trigger text
      </ProvenancePopover>
    );
    expect(html).toContain(`title="${fullSha}"`); // full hash available for the copy button / a11y
    const codeMatch = html.match(/<code>([^<]*)<\/code>/);
    expect(codeMatch, "expected a <code> element with the visible truncated hash").not.toBeNull();
    const visibleCode = codeMatch![1];
    expect(visibleCode.length).toBeLessThan(fullSha.length);
    expect(fullSha.startsWith(visibleCode.replace(/…$/, ""))).toBe(true);
  });

  it("requires a caller-supplied id, so two rows citing the same source don't collide", () => {
    // `id` is required precisely because a dataset+sha256-derived default
    // would collide across every row in a ranked list that cites the same
    // source file. Assert two instances given different ids produce
    // different element ids (and, as a corollary, that omitting `id`
    // fails typecheck below).
    const propsExceptId = {
      dataset: "test-dataset",
      url: "https://example.invalid/test",
      retrievedAt: "test-retrieved-at",
      sha256: "0".repeat(64),
      runId: "test-run-id",
      runner: "cli" as const,
      rowsIn: null,
      rowsLoaded: null,
      rawFileHref: "https://example.invalid/raw",
    };
    const htmlA = renderToStaticMarkup(
      <ProvenancePopover id="row-a" {...propsExceptId}>
        trigger text
      </ProvenancePopover>
    );
    const htmlB = renderToStaticMarkup(
      <ProvenancePopover id="row-b" {...propsExceptId}>
        trigger text
      </ProvenancePopover>
    );
    expect(htmlA).toContain('id="row-a-trigger"');
    expect(htmlB).toContain('id="row-b-trigger"');
    expect(htmlA).not.toContain('id="row-b-trigger"');

    // @ts-expect-error — id is a required prop; omitting it must fail typecheck.
    const missingId = <ProvenancePopover {...propsExceptId}>trigger text</ProvenancePopover>;
    expect(missingId).toBeDefined();
  });
});

describe.skipIf(!process.env.POSTGRES_URL)(
  "ProvenancePopover against a real api.sources row",
  () => {
    afterAll(async () => {
      await getPool().end();
    });

    it("renders a real source_manifest-backed row without fabricating any value", async (ctx) => {
      const rows = await query<{
        source: string;
        url: string;
        retrieved_at: string;
        sha256: string;
        latest_run_id: string | null;
        runner: "cron" | "cli";
        latest_run_rows_in: number | null;
        latest_run_rows_loaded: number | null;
        storage_key: string;
      }>(
        "select source, url, retrieved_at, sha256, latest_run_id, runner, latest_run_rows_in, latest_run_rows_loaded, storage_key from api.sources limit 1"
      );

      if (rows.length === 0) {
        // Real rule: an empty table is a valid state, not a failure — no
        // pipeline has loaded a source yet in this environment. Skip
        // (not pass-silently) so the report distinguishes "ran against 0
        // real rows" from "asserted against a real row".
        ctx.skip();
        return;
      }
      const row = rows[0];
      const html = renderToStaticMarkup(
        <ProvenancePopover
          id={`real-row-${row.sha256.slice(0, 12)}`}
          dataset={row.source}
          url={row.url}
          retrievedAt={String(row.retrieved_at)}
          sha256={row.sha256}
          runId={String(row.latest_run_id ?? "none")}
          runner={row.runner}
          rowsIn={row.latest_run_rows_in}
          rowsLoaded={row.latest_run_rows_loaded}
          rawFileHref={`/storage/${row.storage_key}`}
        >
          trigger text
        </ProvenancePopover>
      );
      expect(html).toContain(row.source);
    });
  }
);
