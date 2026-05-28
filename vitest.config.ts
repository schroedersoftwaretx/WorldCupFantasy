import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests spin up a Testcontainers Postgres — generous timeout.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run integration tests serially: one shared container per file.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false },
    },
    include: ["test/**/*.test.ts"],
  },
});
