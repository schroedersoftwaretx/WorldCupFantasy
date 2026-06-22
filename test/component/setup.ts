/**
 * Shared setup for the React component tests.
 *
 * Imported explicitly by every file under test/component/ (each opts into jsdom
 * with a `// @vitest-environment jsdom` docblock). It is deliberately NOT a
 * global Vitest `setupFiles`: importing @testing-library/react touches
 * `document`/`window` at module load and would crash the node-environment
 * Testcontainers integration tests.
 */
import "@testing-library/jest-dom/vitest";

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
