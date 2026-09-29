import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub/env/server": fileURLToPath(new URL("./test/fixtures/server-env.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: ["test/output/**", "test/local/**"],
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
  },
})
