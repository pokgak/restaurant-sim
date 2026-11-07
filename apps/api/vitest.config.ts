import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BENCHMARK_ADMIN_TOKEN: "",
          BENCHMARK_ADMIN_TOKEN_SHA256:
            "17d6bfe05d1b1fb7bc499f8e3f639c7b3eda4c40f321eef8887a0c04c89a99c5",
        },
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
