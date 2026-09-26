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
  },
});
