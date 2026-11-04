import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __DK_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    maxWorkers: 4,
  },
});
