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

      // Privileges come from the catalog (takes no table locks), so this stays
      // deterministic while a score refresh holds locks on the same tables.
      const [priv] = await query<{ ins: boolean; del: boolean; owns_mv: boolean; create_core: boolean }>(
        `select has_table_privilege('zeus_web_ro', 'core.utility_crosswalk', 'INSERT') as ins,
                has_table_privilege('zeus_web_ro', 'ops.source_manifest', 'DELETE') as del,
                pg_has_role('zeus_web_ro', (select relowner from pg_class where oid = 'core.mv_gate_counts'::regclass), 'MEMBER') as owns_mv,
                has_schema_privilege('zeus_web_ro', 'core', 'CREATE') as create_core`
      );
      expect(priv).toEqual({ ins: false, del: false, owns_mv: false, create_core: false });

      const client = await getPool().connect();
      try {
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

describe("no database object names in visible copy", () => {
  it("JSX text and string props in app/ and components/ never show schema.table names", () => {
    const root = join(__dirname, "..", "..");
    // Strip comments, template literals and quoted select/with strings (SQL), and console.* calls, then look for api./core./ops. names.
    const offenders: string[] = [];
    for (const f of ["app", "components"].flatMap((d) => sourceFiles(join(root, d)))) {
      if (!f.endsWith(".tsx")) continue;
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/`[\s\S]*?`/g, "``")
        .replace(/(["'])\s*(select|with)\b[^"']*\1/gi, '""')
        .replace(/console\.\w+\([^)]*\)/g, "");
      const m = src.match(/\b(api|core|ops)\.[a-z_]{3,}\b/g);
      if (m) offenders.push(`${f}: ${[...new Set(m)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
