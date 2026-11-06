import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { BENCHMARK_ADMIN_TOKEN: "test-admin-token" },
      },
    }),
  ],
  resolve: {
    alias: {
      "@restaurant-sim/sim": resolve(process.cwd(), "test/fixtures/sim.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
