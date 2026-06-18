import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirror tsconfig's "@/* -> ./src/*" path alias so unit tests can import the
  // app/ components (which use "@/...") the same way Next resolves them.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Integration tests spin up a Testcontainers Postgres - generous timeout.
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
