import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // "server-only" throws unconditionally unless the Next.js bundler's
      // special resolve condition is active, which vitest doesn't set. It
      // is a no-op guard module in production, so aliasing it to an empty
      // module here changes no runtime behavior we test against.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // M1-W3 fix: several test files each open their own pg Pool against
    // POSTGRES_URL (the Supabase transaction pooler) and call it in
    // afterAll. Running those files in parallel worker processes opens
    // many concurrent pools/connections at once, which queues/slows real
    // queries enough to blow test/hook timeouts — not a query
    // correctness problem, a connection-contention one. Running test
    // files sequentially (one Node process, no file-level parallelism)
    // keeps at most one file's pool open against the database at a time.
    fileParallelism: false,
  },
});
