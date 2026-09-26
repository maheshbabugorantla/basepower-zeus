// Test-only stub for the "server-only" package (see vitest.config.ts).
// The real package throws when imported outside Next.js's server compile
// target; vitest has no such target, so this is a no-op in tests only.
export {};
