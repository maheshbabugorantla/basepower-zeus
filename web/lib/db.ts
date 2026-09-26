import "server-only";

// Server-only data access. Never import this module from a client
// component, and never expose a NEXT_PUBLIC_ variable for data — the app
// reads Supabase only through this module, using the service-role key or a
// direct Postgres connection to the `api` schema views.
//
// Two supported paths, chosen lazily (nothing connects at import time, so
// this module can be imported freely in code paths that never run in CI
// without secrets):
//   1. POSTGRES_URL set: a pg Pool against the Supabase transaction pooler
//      (port 6543). No named/prepared statements are issued anywhere in
//      this module, so it is compatible with pgbouncer transaction mode.
//   2. POSTGRES_URL unset, SUPABASE_URL + SUPABASE_SECRET_KEY set: a
//      supabase-js client using the service-role key.
//
// Later tickets query only the `api` schema (views), never `ops`/`core`
// directly, so provenance (source_id on every row) stays enforced in one
// place — the database.

import { Pool } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let pool: Pool | undefined;
let supabase: SupabaseClient | undefined;

/**
 * Lazily-created pg Pool against POSTGRES_URL (the Supabase transaction
 * pooler). Throws only when actually used without the env var set — never
 * at import time.
 */
export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      "getPool() called but POSTGRES_URL is not set. Use getSupabase() " +
        "instead, or set POSTGRES_URL in the environment."
    );
  }

  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

/**
 * Lazily-created supabase-js client using the service-role key. Never use
 * SUPABASE_PUBLISHABLE_KEY (or any NEXT_PUBLIC_ key) here — this client
 * bypasses RLS, so it must never run in browser code.
 */
export function getSupabase(): SupabaseClient {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "getSupabase() called but SUPABASE_URL / SUPABASE_SECRET_KEY are not " +
        "set. Use getPool() instead, or set both env vars."
    );
  }

  supabase = createClient(url, key, {
    auth: { persistSession: false },
  });
  return supabase;
}

/**
 * Run a read query against the `api` schema via the pg Pool. Prefer this
 * for server components / route handlers that already know POSTGRES_URL is
 * configured; fall back to getSupabase() where a Supabase-specific feature
 * (e.g. Storage) is needed instead.
 */
export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const client = getPool();
  const result = await client.query(text, params);
  return result.rows as T[];
}
