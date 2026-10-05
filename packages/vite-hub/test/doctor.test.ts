import { describe, expect, it } from "vitest"
import { runProjectFixture, runRuleFixture } from "vite-doctor/testkit"
import type { PluginOption } from "vite"
import type { DoctorPluginApi, DoctorRule } from "vite-doctor/extension"

import vitehubDoctorExtension, { destructureStorageResults, noInternalImports, noServerImportsInClient } from "../src/doctor.ts"
import { vitehub } from "../src/index.ts"

function doctorPluginApi(plugins: PluginOption[]): DoctorPluginApi | undefined {
  for (const plugin of plugins) {
    const api = Array.isArray(plugin)
      ? doctorPluginApi(plugin)
      : plugin && "api" in plugin && plugin.name === "vite-hub/doctor" ? plugin.api?.doctor : undefined
    if (api) return api
  }
}

async function codes(rule: DoctorRule, files: Record<string, string>, framework: "nuxt" | "vite" = "vite") {
  const result = await runRuleFixture({ rule, framework, files })
  return result.diagnostics.map(diagnostic => diagnostic.code)
}

describe("vitehub/no-internal-imports", () => {
  it("reports internal and generated imports", async () => {
    expect(await codes(noInternalImports, {
      "server/api/a.ts": [
        "import { kv } from \"vite-hub/_internal/kv\"",
        "import { isPlainObject } from \"@vite-hub/internal/object\"",
        "import state from \"@vite-hub/queue/internal/runtime/state\"",
        "export * from \"@vite-hub/sandbox/_internal/runtime\"",
        "const env = await import(\"../../.vitehub/env/server.ts\")",
        "export { kv, isPlainObject, state, env }",
      ].join("\n"),
    })).toEqual(["VHUB0001", "VHUB0001", "VHUB0001", "VHUB0001", "VHUB0001"])
  })

  it("accepts public paths and generated aliases", async () => {
    expect(await codes(noInternalImports, {
      "server/api/a.ts": [
        "import { kv } from \"vite-hub/kv\"",
        "import { useServerEnv } from \"#vitehub/env/server\"",
        "import { defineQueue } from \"@vite-hub/queue\"",
        "import internal from \"./internal/helper.ts\"",
        "export { kv, useServerEnv, defineQueue, internal }",
      ].join("\n"),
      "server/api/internal/helper.ts": "export default 1\n",
      ".vitehub/agent/registry.ts": "export { agent } from \"vite-hub/_internal/agent\"\n",
    })).toEqual([])
  })
})

describe("vitehub/no-server-imports-in-client", () => {
  it("reports server-only imports in Vue components and Nuxt app code", async () => {
    expect(await codes(noServerImportsInClient, {
      "src/App.vue": "<script setup lang=\"ts\">\nimport { useServerEnv } from \"#vitehub/env/server\"\nconst env = useServerEnv()\n</script>\n<template><div>{{ env }}</div></template>\n",
    })).toEqual(["VHUB0002"])
    expect(await codes(noServerImportsInClient, {
      "app/composables/useMail.ts": "import { email } from \"vite-hub/email/server\"\nexport const useMail = () => email\n",
      "app/pages/index.vue": "<script setup lang=\"ts\">\nimport { useDatabase } from \"vite-hub/database/drizzle\"\nconst db = useDatabase()\n</script>\n<template><div>{{ db }}</div></template>\n",
    }, "nuxt")).toEqual(["VHUB0002", "VHUB0002"])
  })

  it("accepts server files, type imports, and client paths", async () => {
    expect(await codes(noServerImportsInClient, {
      "server/api/env.get.ts": "import { useServerEnv } from \"#vitehub/env/server\"\nexport default () => useServerEnv()\n",
      "src/App.vue": "<script setup lang=\"ts\">\nimport type { Email } from \"vite-hub/email/server\"\nimport { useUpload } from \"vite-hub/blob/vue\"\nimport { usePublicEnv } from \"#vitehub/env/public\"\ndefineProps<{ email?: Email }>()\nconst upload = useUpload()\nconst env = usePublicEnv()\n</script>\n<template><div>{{ upload }} {{ env }}</div></template>\n",
    })).toEqual([])
    expect(await codes(noServerImportsInClient, {
      "app/plugins/env.server.ts": "import { useServerEnv } from \"#vitehub/env/server\"\nexport default () => useServerEnv()\n",
    }, "nuxt")).toEqual([])
  })
})

describe("vitehub/destructure-storage-results", () => {
  it("reports KV and Blob results used as values", async () => {
    expect(await codes(destructureStorageResults, {
      "server/api/settings.get.ts": [
        "import { kv } from \"vite-hub/kv\"",
        "import { blob as files } from \"@vite-hub/blob\"",
        "const reports = files.store(\"reports\")",
        "export default async () => {",
        "  const settings = await kv.get(\"settings\")",
        "  if (await kv.has(\"flag\")) return settings",
        "  const size = (await reports.head(\"a.txt\")).size",
        "  return !(await kv.store(\"cache\").has(\"key\")) && size",
        "}",
      ].join("\n"),
    })).toEqual(["VHUB0003", "VHUB0003", "VHUB0003", "VHUB0003"])
  })

  it("reports auto-imported helpers in Nuxt server files", async () => {
    expect(await codes(destructureStorageResults, {
      "server/api/settings.get.ts": "export default async () => {\n  const settings = await kv.get(\"settings\")\n  return settings\n}\n",
    }, "nuxt")).toEqual(["VHUB0003"])
  })

  it("accepts destructured, indexed, ignored, and unrelated results", async () => {
    expect(await codes(destructureStorageResults, {
      "server/api/settings.get.ts": [
        "import { kv } from \"vite-hub/kv\"",
        "import { blob } from \"vite-hub/blob\"",
        "export default async () => {",
        "  const [error, settings] = await kv.get(\"settings\")",
        "  if (error) throw error",
        "  await kv.set(\"seen\", true)",
        "  const missing = (await blob.head(\"a.txt\"))[0]",
        "  return { settings, missing }",
        "}",
      ].join("\n"),
      "server/api/other.get.ts": "const kv = new Map<string, string>()\nexport default async () => {\n  const value = await kv.get(\"a\")\n  return value\n}\n",
    })).toEqual([])
    expect(await codes(destructureStorageResults, {
      "server/api/settings.get.ts": "import { kv } from \"./local-kv.ts\"\nexport default async () => {\n  const settings = await kv.get(\"settings\")\n  return settings\n}\n",
      "server/api/local-kv.ts": "export const kv = new Map<string, string>()\n",
      "server/api/local-blob.get.ts": "const blob = new Map<string, string>()\nexport default async () => {\n  const value = await blob.get(\"a\")\n  return value\n}\n",
    }, "nuxt")).toEqual([])
  })
})

describe("ViteHub Doctor Extension", () => {
  it("links each diagnostic to its documentation", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      extensions: [vitehubDoctorExtension],
      dependencies: { "vite-hub": "*" },
      files: {
        "src/App.vue": "<script setup lang=\"ts\">\nimport { useServerEnv } from \"vite-hub/env/server\"\nconst env = useServerEnv()\n</script>\n<template><div>{{ env }}</div></template>\n",
        "server/api/a.ts": "import { kv } from \"vite-hub/_internal/kv\"\nexport default async () => (await kv.get(\"a\")).value\n",
      },
    })
    const found = result.diagnostics
      .filter(diagnostic => diagnostic.code.startsWith("VHUB"))
      .map(diagnostic => [diagnostic.code, diagnostic.docs])
      .sort()
    expect(found).toEqual([
      ["VHUB0001", "https://vitehub.dev/docs/reference/doctor-rules#vhub0001"],
      ["VHUB0002", "https://vitehub.dev/docs/reference/doctor-rules#vhub0002"],
    ])
  })

  it("is exposed by the Vite plugin as a lazy Doctor Extension", async () => {
    const api = doctorPluginApi(vitehub({ preset: "node" }))
    expect(api?.extensions).toHaveLength(1)
    const [load] = api?.extensions ?? []
    if (typeof load !== "function") throw new TypeError("Expected a lazy Doctor Extension loader.")
    const loaded = await load()
    expect("default" in loaded ? loaded.default : loaded).toBe(vitehubDoctorExtension)
  })
})
