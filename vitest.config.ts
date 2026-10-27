import { defineConfig } from "vitest/config";

// Every test file shares this worktree's own database (W4), so files run one at a time and each starts from a
// freshly reset and seeded database (src/test/harness.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/load-env.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
