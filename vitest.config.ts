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
  // Components and tests use JSX without importing React (the Next/automatic
  // runtime). Tell esbuild to use the automatic runtime so .tsx compiles the
  // same way Next does. This only affects .tsx/.jsx files; the node/.ts
  // integration tests are unaffected.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // Integration tests spin up a Testcontainers Postgres - generous timeout.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run integration tests serially: one shared container per file.
    pool: "forks",
    poolOptions: {
      // Cap parallel workers: the default (one fork per logical CPU) runs up
      // to ~18 Node processes AND ~18 Testcontainers Postgres containers at
      // once, which exhausted Windows commit memory ("Committing semi space
      // failed" OOM, 2026-07). Four forks keeps runs fast without blowing
      // the memory budget alongside Docker Desktop.
      forks: { singleFork: false, maxForks: 4 },
    },
    // Default environment stays "node" so the Testcontainers integration tests
    // are untouched. Component tests opt into jsdom per-file with a
    //   // @vitest-environment jsdom
    // docblock (see test/component/*). We add *.test.tsx to the glob so those
    // component tests are collected alongside the existing .test.ts suites.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
