/**
 * Next.js configuration.
 *
 * - `serverExternalPackages`: `pg` (Postgres driver) and `firebase-admin`
 *   are server-only and must not be bundled - they are required at runtime
 *   from node_modules instead.
 * - `experimental.extensionAlias`: the data layer (src/data) and the web
 *   layer write relative imports with explicit `.js` extensions - the
 *   Node16 / ESM convention the CLI and the test runner rely on. Next's
 *   webpack does not resolve a `.js` specifier to a `.ts` file unless told
 *   to; this alias makes the bundler agree with tsc and tsx.
 * - `eslint.ignoreDuringBuilds`: the repo has no ESLint config; type
 *   checking (which the build still runs) is the gate that matters here.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["pg", "firebase-admin"],
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
