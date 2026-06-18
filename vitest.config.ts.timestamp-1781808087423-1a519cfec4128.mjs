// vitest.config.ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "file:///sessions/relaxed-awesome-brown/mnt/Fantasy%20World%20Cup/node_modules/vitest/dist/config.js";
var __vite_injected_original_import_meta_url = "file:///sessions/relaxed-awesome-brown/mnt/Fantasy%20World%20Cup/vitest.config.ts";
var vitest_config_default = defineConfig({
  // Mirror tsconfig's "@/* -> ./src/*" path alias so unit tests can import the
  // app/ components (which use "@/...") the same way Next resolves them.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", __vite_injected_original_import_meta_url))
    }
  },
  test: {
    // Integration tests spin up a Testcontainers Postgres - generous timeout.
    testTimeout: 12e4,
    hookTimeout: 12e4,
    // Run integration tests serially: one shared container per file.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false }
    },
    include: ["test/**/*.test.ts"]
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9zZXNzaW9ucy9yZWxheGVkLWF3ZXNvbWUtYnJvd24vbW50L0ZhbnRhc3kgV29ybGQgQ3VwXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvc2Vzc2lvbnMvcmVsYXhlZC1hd2Vzb21lLWJyb3duL21udC9GYW50YXN5IFdvcmxkIEN1cC92aXRlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9zZXNzaW9ucy9yZWxheGVkLWF3ZXNvbWUtYnJvd24vbW50L0ZhbnRhc3klMjBXb3JsZCUyMEN1cC92aXRlc3QuY29uZmlnLnRzXCI7aW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuXG5pbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZXN0L2NvbmZpZ1wiO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICAvLyBNaXJyb3IgdHNjb25maWcncyBcIkAvKiAtPiAuL3NyYy8qXCIgcGF0aCBhbGlhcyBzbyB1bml0IHRlc3RzIGNhbiBpbXBvcnQgdGhlXG4gIC8vIGFwcC8gY29tcG9uZW50cyAod2hpY2ggdXNlIFwiQC8uLi5cIikgdGhlIHNhbWUgd2F5IE5leHQgcmVzb2x2ZXMgdGhlbS5cbiAgcmVzb2x2ZToge1xuICAgIGFsaWFzOiB7XG4gICAgICBcIkBcIjogZmlsZVVSTFRvUGF0aChuZXcgVVJMKFwiLi9zcmNcIiwgaW1wb3J0Lm1ldGEudXJsKSksXG4gICAgfSxcbiAgfSxcbiAgdGVzdDoge1xuICAgIC8vIEludGVncmF0aW9uIHRlc3RzIHNwaW4gdXAgYSBUZXN0Y29udGFpbmVycyBQb3N0Z3JlcyAtIGdlbmVyb3VzIHRpbWVvdXQuXG4gICAgdGVzdFRpbWVvdXQ6IDEyMF8wMDAsXG4gICAgaG9va1RpbWVvdXQ6IDEyMF8wMDAsXG4gICAgLy8gUnVuIGludGVncmF0aW9uIHRlc3RzIHNlcmlhbGx5OiBvbmUgc2hhcmVkIGNvbnRhaW5lciBwZXIgZmlsZS5cbiAgICBwb29sOiBcImZvcmtzXCIsXG4gICAgcG9vbE9wdGlvbnM6IHtcbiAgICAgIGZvcmtzOiB7IHNpbmdsZUZvcms6IGZhbHNlIH0sXG4gICAgfSxcbiAgICBpbmNsdWRlOiBbXCJ0ZXN0LyoqLyoudGVzdC50c1wiXSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUF5VixTQUFTLHFCQUFxQjtBQUV2WCxTQUFTLG9CQUFvQjtBQUZ1TCxJQUFNLDJDQUEyQztBQUlyUSxJQUFPLHdCQUFRLGFBQWE7QUFBQTtBQUFBO0FBQUEsRUFHMUIsU0FBUztBQUFBLElBQ1AsT0FBTztBQUFBLE1BQ0wsS0FBSyxjQUFjLElBQUksSUFBSSxTQUFTLHdDQUFlLENBQUM7QUFBQSxJQUN0RDtBQUFBLEVBQ0Y7QUFBQSxFQUNBLE1BQU07QUFBQTtBQUFBLElBRUosYUFBYTtBQUFBLElBQ2IsYUFBYTtBQUFBO0FBQUEsSUFFYixNQUFNO0FBQUEsSUFDTixhQUFhO0FBQUEsTUFDWCxPQUFPLEVBQUUsWUFBWSxNQUFNO0FBQUEsSUFDN0I7QUFBQSxJQUNBLFNBQVMsQ0FBQyxtQkFBbUI7QUFBQSxFQUMvQjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
