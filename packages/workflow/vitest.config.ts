import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    isolate: true,
    exclude: [...configDefaults.exclude, "**/.vitehub/**"],
  },
})
