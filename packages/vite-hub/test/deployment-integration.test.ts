import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createBuilder, resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { env, hubEnv } from "@vite-hub/env/vite"
import { vitehub } from "../src/index.ts"

import type { EnvViteUserConfig } from "@vite-hub/env"

describe("built-in deployment preset integration", () => {
  it.each(["cloudflare", "netlify", "vercel", "deno", "node"] as const)("resolves the minimal %s preset with real owner plugins", async (preset) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-config-"))
    const config = await resolveConfig({
      root,
      plugins: [vitehub({
        preset,
        blob: false,
        env: false,
        queue: false,
        rateLimit: false,
      })],
    }, "build")
    expect(config.plugins.map(plugin => plugin.name)).not.toContain("@vite-hub/sandbox/vite")
    expect((config as typeof config & { nitro?: { preset?: string } }).nitro?.preset).toBeTruthy()
  })

  it("applies deployment-owned Nitro configuration only during build", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-preset-command-"))
    try {
      const developmentConfig = {
        nitro: {
          modules: ["local-module"],
          preset: "node-server",
        },
        root,
        plugins: [vitehub({
          preset: "cloudflare",
          blob: false,
          env: false,
          queue: false,
          rateLimit: false,
        })],
        vitehub: {
          marker: "preserved",
        },
      } as Parameters<typeof resolveConfig>[0] & {
        nitro: { modules: string[], preset: string }
        vitehub: { marker: string }
      }
      const development = await resolveConfig(developmentConfig, "serve")
      expect((development as typeof development & {
        nitro?: { modules?: unknown[], preset?: string }
      }).nitro).toMatchObject({
        modules: ["local-module"],
        preset: "node-server",
      })
      expect(development.vitehub).toEqual({
        marker: "preserved",
        preset: "cloudflare",
      })

      const production = await resolveConfig({
        root,
        plugins: [vitehub({
          preset: "cloudflare",
          blob: false,
          env: false,
          queue: false,
          rateLimit: false,
        })],
      }, "build")
      expect((production as typeof production & {
        nitro?: { modules?: unknown[], preset?: string }
      }).nitro).toMatchObject({
        modules: [expect.any(Function)],
        preset: "cloudflare-module",
      })
      expect(production.vitehub).toEqual({
        preset: "cloudflare",
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("preserves a Worker name configured through the Nitro plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-worker-name-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [
          vitehub({ name: "logical-app", preset: "cloudflare" }),
          {
            name: "nitro-config",
            config() {
              return {
                nitro: {
                  cloudflare: {
                    wrangler: {
                      name: "physical-worker",
                    },
                  },
                },
              } as never
            },
          },
        ],
      }, "build")
      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { name?: string } } }
      }).nitro?.cloudflare?.wrangler?.name).toBe("physical-worker")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares an auto-provisionable KV binding in Cloudflare Nitro output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-cloudflare-kv-binding-"))
    try {
      const config = await resolveConfig({
        root,
        plugins: [vitehub({
          blob: false,
          env: false,
          kv: true,
          preset: "cloudflare",
          queue: false,
          rateLimit: false,
        })],
      }, "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { kv_namespaces?: Array<{ binding: string, id?: string }> } } }
      }).nitro?.cloudflare?.wrangler?.kv_namespaces).toEqual([{ binding: "KV" }])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares exact required Server Env secrets in Cloudflare output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-required-secrets-"))
    try {
      const config = await resolveConfig({
        env: {
          server: {
            nested: {
              required: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
              optional: env({ optional: true, secret: true, source: env.source("OPTIONAL_TOKEN") }),
              alternatives: env({ secret: true, source: env.source(["PRIMARY_TOKEN", "FALLBACK_TOKEN"]) }),
              external: env({ secret: true, source: env.provider("credentials", "github/token") }),
              publicValue: env({ source: env.source("PUBLIC_VALUE") }),
            },
          },
        },
        nitro: {
          cloudflare: {
            wrangler: {
              secrets: { required: ["APP_SECRET"] },
            },
          },
        },
        root,
        plugins: [vitehub({ env: { providers: { credentials: "./server/env/credentials.ts" } }, preset: "cloudflare" })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required).toEqual(["APP_SECRET", "VITEHUB_TOKEN"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares Server Env for built-in Channels used by Agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-channel-env-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { github, telegram } from "vite-hub/agent/channels"`,
        `export default defineAgent({ channels: { repo: github(), telegram: telegram({ mode: "webhook" }) } })`,
      ].join("\n"))
      const resolve = (server?: Record<string, unknown>) => resolveConfig({
        ...(server ? { env: { server } } : {}),
        root,
        plugins: [vitehub({ agent: true, preset: "cloudflare" })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")
      const requiredSecrets = (config: Awaited<ReturnType<typeof resolve>>) => (config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required

      const config = await resolve()
      expect(requiredSecrets(config)).toEqual(["TELEGRAM_BOT_TOKEN"])
      await symlink(join(import.meta.dirname, "../../..", "node_modules"), join(root, "node_modules"), "dir")
      const moduleUrl = pathToFileURL(join(root, ".vitehub", "env", "server.mjs")).href
      const token = execFileSync(process.execPath, ["--input-type=module", "-e", `
        const { useServerEnv } = await import(${JSON.stringify(moduleUrl)})
        const serverEnv = useServerEnv({
          env: { VITEHUB_GITHUB_TOKEN: "", GH_TOKEN: "fallback-token", GITHUB_TOKEN: "last-token", TELEGRAM_BOT_TOKEN: "telegram-token" },
        })
        console.log(serverEnv.github.token.unseal())
      `], { encoding: "utf8" })
      expect(token.trim()).toBe("fallback-token")
      const types = await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")
      expect(types).toContain("\"telegram\": {")
      expect(types).toContain("\"botToken\": import(\"vite-hub/env/secret\").SecretEnv<string>")
      expect(types).toContain("\"webhookSecret\"?: import(\"vite-hub/env/secret\").SecretEnv<string>")
      expect(types).toContain("\"appPrivateKey\"?: import(\"vite-hub/env/secret\").SecretEnv<string>")
      const description = await readFile(join(root, ".vitehub", "env", "description.mjs"), "utf8")
      expect(description).toContain("env.server.telegram.botToken")

      const renamed = await resolve({ telegram: { botToken: env({ secret: true, source: env.source("TELEGRAM_TOKEN") }) } })
      expect(requiredSecrets(renamed)).toEqual(["TELEGRAM_TOKEN"])

      await writeFile(join(root, "server", "agents", "support.ts"), [
        `import { defineAgent } from "vite-hub/agent"`,
        `import { telegram } from "vite-hub/agent/channels"`,
        `interface Helpers { telegram(): void }`,
        `const helpers = { telegram() {} }`,
        `class Tools { telegram() {} }`,
        `function format() { const telegram = () => ({}); return telegram() }`,
        `const base = {}`,
        `export default defineAgent({ channels: { telegram: { ...base, kind: "custom" } } })`,
      ].join("\n"))
      const custom = await resolve()
      expect(requiredSecrets(custom) ?? []).not.toContain("TELEGRAM_BOT_TOKEN")
      expect(await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).not.toContain("\"telegram\": {")

      for (const { source, required } of [
        { source: `defineAgent({ channels: { telegram: undefined } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram(undefined) } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram(({})) } })`, required: true },
        { source: `defineAgent({ channels: { telegram: telegram((({ botToken: "token" }))) } })`, required: false },
        { source: `defineAgent({ channels: { telegram: telegram?.({ botToken: "token" }) } })`, required: false },
        { source: `function run() { telegram()\n{} }; defineAgent({ channels: {} })`, required: true },
        { source: `const channels = { telegram: {} }; defineAgent({ channels: channels satisfies AgentChannelInputs })`, required: true },
        { source: `defineAgent({ channels: { telegram: { async botToken() { return "token" } } } })`, required: false },
      ]) {
        await writeFile(join(root, "server", "agents", "support.ts"), [
          `import { defineAgent } from "vite-hub/agent"`,
          `import { telegram } from "vite-hub/agent/channels"`,
          source,
        ].join("\n"))
        expect((requiredSecrets(await resolve()) ?? []).includes("TELEGRAM_BOT_TOKEN")).toBe(required)
      }

      await writeFile(join(root, "server", "agents", "support.ts"), [
        `const defineAgent = (options) => options`,
        `export default defineAgent({ channels: { telegram: {} } })`,
      ].join("\n"))
      expect(requiredSecrets(await resolve()) ?? []).not.toContain("TELEGRAM_BOT_TOKEN")
      expect(await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")).not.toContain("\"telegram\": {")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("emits required Server Env secrets through the Nitro Vite plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-required-secrets-build-"))
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        logLevel: "silent",
        root,
        plugins: [vitehub({ preset: "cloudflare" }), nitro() as never],
      } as Parameters<typeof createBuilder>[0] & EnvViteUserConfig)
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      expect(wrangler).toMatchObject({ secrets: { required: ["VITEHUB_TOKEN"] } })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("emits prefixed secrets from a standalone Env plugin through Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-prefixed-standalone-secrets-build-"))
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        env: { server: { token: env({ secret: true }) } },
        logLevel: "silent",
        root,
        plugins: [vitehub({ env: false, preset: "cloudflare" }), hubEnv({ prefix: "APP_" }), nitro() as never],
      } as Parameters<typeof createBuilder>[0] & EnvViteUserConfig)
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      expect(wrangler).toMatchObject({ secrets: { required: ["APP_TOKEN"] } })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("emits secrets contributed by later pre hooks through Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-late-pre-secrets-build-"))
    try {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
      const builder = await createBuilder({
        logLevel: "silent",
        root,
        plugins: [
          vitehub({ preset: "cloudflare" }),
          {
            name: "app/server-env",
            enforce: "pre",
            config: () => ({ env: { server: { token: env({ secret: true, source: env.source("LATE_TOKEN") }) } } }),
          },
          nitro() as never,
        ],
      } as Parameters<typeof createBuilder>[0] & EnvViteUserConfig)
      await builder.buildApp()

      const wrangler: unknown = JSON.parse(await readFile(join(root, ".output", "server", "wrangler.json"), "utf8"))
      expect(wrangler).toMatchObject({ secrets: { required: ["LATE_TOKEN"] } })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  it("declares required secrets from a standalone Env plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-standalone-required-secrets-"))
    try {
      const config = await resolveConfig({
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        root,
        plugins: [
          vitehub({ env: false, preset: "cloudflare" }),
          hubEnv(),
        ],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required).toEqual(["VITEHUB_TOKEN"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps standalone Env subscriptions scoped to their Cloudflare configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-reused-env-plugin-"))
    try {
      const envPlugin = hubEnv()
      const server = { token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }) }
      await resolveConfig({
        env: { server },
        root,
        plugins: [vitehub({ env: false, preset: "cloudflare" }), envPlugin],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")
      const emptyCloudflareConfig = await resolveConfig({
        root,
        plugins: [vitehub({ env: false, preset: "cloudflare" }), envPlugin],
      } as Parameters<typeof resolveConfig>[0], "build")
      const nodeConfig = await resolveConfig({
        env: { server },
        root,
        plugins: [vitehub({ env: false, preset: "node" }), envPlugin],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((emptyCloudflareConfig as typeof emptyCloudflareConfig & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required).toBeUndefined()
      expect((nodeConfig as typeof nodeConfig & { nitro?: { cloudflare?: unknown } }).nitro?.cloudflare).toBeUndefined()

      const [first, second] = await Promise.all([
        resolveConfig({
          env: { server: { first: env({ secret: true, source: env.source("FIRST_TOKEN") }) } },
          root,
          plugins: [vitehub({ env: false, preset: "cloudflare" }), envPlugin],
        } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build"),
        resolveConfig({
          env: { server: { second: env({ secret: true, source: env.source("SECOND_TOKEN") }) } },
          root,
          plugins: [vitehub({ env: false, preset: "cloudflare" }), envPlugin],
        } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build"),
      ])
      const required = (config: typeof first) => (config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { secrets?: { required?: string[] } } } }
      }).nitro?.cloudflare?.wrangler?.secrets?.required
      expect(required(first)).toEqual(["FIRST_TOKEN"])
      expect(required(second)).toEqual(["SECOND_TOKEN"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares required secrets in named environments from later post hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-late-required-secrets-"))
    try {
      const config = await resolveConfig({
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        root,
        plugins: [
          vitehub({ preset: "cloudflare" }),
          {
            name: "app/cloudflare-environments",
            enforce: "post",
            config() {
              return {
                nitro: {
                  cloudflare: {
                    wrangler: {
                      env: { staging: { name: "staging-worker" } },
                    },
                  },
                },
              }
            },
          },
        ],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((config as typeof config & {
        nitro?: { cloudflare?: { wrangler?: { env?: { staging?: { secrets?: { required?: string[] } } } } } }
      }).nitro?.cloudflare?.wrangler?.env?.staging?.secrets?.required).toEqual(["VITEHUB_TOKEN"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps required Server Env secrets out of non-Cloudflare output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-node-required-secrets-"))
    try {
      const config = await resolveConfig({
        env: {
          server: {
            token: env({ secret: true, source: env.source("VITEHUB_TOKEN") }),
          },
        },
        root,
        plugins: [vitehub({ preset: "node" })],
      } as Parameters<typeof resolveConfig>[0] & EnvViteUserConfig, "build")

      expect((config as typeof config & { nitro?: { cloudflare?: unknown } }).nitro?.cloudflare).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
