import "server-only";

// Server-only data access. Never import this module from a client
// component, and never expose a NEXT_PUBLIC_ variable for data — the app
// reads Supabase only through this module, using the service-role key or a
// direct Postgres connection to the `api` schema views.
//
// Two supported paths, chosen lazily (nothing connects at import time, so
// this module can be imported freely in code paths that never run in CI
// without secrets):
//   1. POSTGRES_URL_READONLY set: a pg Pool against the Supabase transaction
//      pooler (port 6543) as role zeus_web_ro (migration 0210): SELECT/
//      EXECUTE grants only, every session read-only. The web app never holds
//      a write-capable Postgres login. No named/prepared statements are
//      issued, so it is compatible with pgbouncer transaction mode.
//   2. Storage: getStorageReader() signs raw-file download links with the
//      publishable key (read-only bucket policy, migration 0211).
//
// Later tickets query only the `api` schema (views), never `ops`/`core`
// directly, so provenance (source_id on every row) stays enforced in one
// place — the database.

import { Pool } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let pool: Pool | undefined;
let supabase: SupabaseClient | undefined;

/**
 * Lazily-created pg Pool against POSTGRES_URL_READONLY (the Supabase transaction
 * pooler). Throws only when actually used without the env var set — never
 * at import time.
 */
export function getPool(): Pool {
  if (pool) return pool;

  // Read-only login only — deliberately no fallback to the owner URL.
  const connectionString = process.env.POSTGRES_URL_READONLY;
  if (!connectionString) {
    throw new Error("getPool() called but POSTGRES_URL_READONLY is not set.");
  }

  // Serverless-safe limits: every Vercel instance gets its own pool, and the
  // Supabase pooler has a small shared slot budget. Keep few connections per
  // instance, release idle ones quickly, and cap waits and queries so one
  // slow statement can never pin the pooler for everyone.
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    allowExitOnIdle: true,
  });
  return pool;
}

/**
 * Lazily-created supabase-js client for Storage reads only, using the
 * publishable key. Its only use is signing short-lived download links for
 * raw source files; migration 0211 grants anon SELECT on bucket `raw` and
 * nothing else, so this client cannot write or delete. The web app holds no
 * service-role key.
 */
export function getStorageReader(): SupabaseClient {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "getStorageReader() called but SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set."
    );
  }

  supabase = createClient(url, key, {
    auth: { persistSession: false },
  });
  return supabase;
}

/**
 * Run a read query against the `api` schema via the pg Pool. Prefer this
 * for server components / route handlers that already know POSTGRES_URL_READONLY is
 * configured; use getStorageReader() only for raw-file download links
 */
export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const client = getPool();
  const result = await client.query(text, params);
  return result.rows as T[];
}
