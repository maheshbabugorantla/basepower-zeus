import { afterEach, beforeEach, describe, expect, it } from "vitest";

// These tests exercise lib/db.ts's lazy-connection guard behavior only —
// they never connect to a real database, and they never fabricate rows.
// A real end-to-end query against POSTGRES_URL is exercised by later
// tickets (M0-W1, M0-W2) once api schema views exist, and is skipped here
// whenever POSTGRES_URL/SUPABASE_URL aren't set, exactly as CI runs.

const ENV_KEYS = ["POSTGRES_URL", "POSTGRES_URL_READONLY", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("lib/db.ts", () => {
  it("getPool() throws a clear error when POSTGRES_URL is unset", async () => {
    const { getPool } = await import("../lib/db");
    expect(() => getPool()).toThrow(/POSTGRES_URL/);
  });

  it("getStorageReader() throws a clear error when SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY are unset", async () => {
    const { getStorageReader } = await import("../lib/db");
    expect(() => getStorageReader()).toThrow(/SUPABASE_URL/);
  });

  it("module import never connects or throws at import time", async () => {
    await expect(import("../lib/db")).resolves.toBeDefined();
  });
});
