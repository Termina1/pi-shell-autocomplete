import { defineConfig } from "vitest/config";

const includeIntegration =
  process.env.RUN_INTEGRATION === "1" || process.env.RUN_ZSH_BENCH === "1";

export default defineConfig({
  test: {
    include: includeIntegration
      ? ["__tests__/**/*.test.ts"]
      : ["__tests__/*.test.ts"],
    environment: "node",
    globals: true,
  },
});
