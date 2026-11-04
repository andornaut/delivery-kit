import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["cases/**/*.test.ts"],
    maxWorkers: 4,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
