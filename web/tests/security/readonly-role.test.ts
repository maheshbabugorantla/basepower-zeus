import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The public app must only ever read. Two guards:
//  1. Live: the web app's login (POSTGRES_URL_READONLY, role zeus_web_ro)
//     cannot write, even inside an explicit read-write transaction.
//  2. Static: no web source file contains a write/DDL statement.

const WRITE_SQL = /\b(insert\s+into|update\s+[a-z_."]+\s+set|delete\s+from|truncate\s|drop\s+(table|view|function|schema|materialized)|alter\s+(table|role|view)|create\s+(table|view|function|role|index|policy)|refresh\s+materialized|grant\s|revoke\s)/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("web app is read-only against Postgres", () => {
  it("no write or DDL SQL in app/, components/, lib/", () => {
    const root = join(__dirname, "..", "..");
    const offenders = ["app", "components", "lib"]
      .flatMap((d) => sourceFiles(join(root, d)))
      .filter((f) => WRITE_SQL.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it.skipIf(!process.env.POSTGRES_URL_READONLY)(
    "the web login is zeus_web_ro and every write is refused",
    async () => {
      const { query, getPool } = await import("../../lib/db");
      const [who] = await query<{ u: string }>("select current_user as u");
      expect(who.u).toBe("zeus_web_ro");

      const client = await getPool().connect();
      try {
        for (const stmt of [
          "insert into core.utility_crosswalk default values",
          "delete from ops.source_manifest where false",
          "refresh materialized view core.mv_gate_counts",
        ]) {
          await client.query("begin");
          await client.query("set transaction read write");
          await expect(client.query(stmt)).rejects.toThrow(/permission denied/);
          await client.query("rollback");
        }
        // And the default session is read-only.
        await expect(client.query("insert into core.utility_crosswalk default values")).rejects.toThrow(
          /read-only transaction/
        );
      } finally {
        client.release();
      }
    },
    20000
  );
});
