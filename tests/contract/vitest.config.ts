import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["cases/**/*.test.ts"],
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
