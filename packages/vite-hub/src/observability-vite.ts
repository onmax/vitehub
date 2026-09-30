import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import type { EnvVariableDeclaration } from "@vite-hub/env"
import type { NitroModuleOptions } from "evlog/nitro"
import type { Plugin } from "vite"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

export interface ObservabilityOptions {
  /** Service name on every event and log. */
  service: string
  /** Defaults to `NODE_ENV`, then `development`. */
  environment?: string
  /** Export events, exceptions, and failed request logs to PostHog. */
  posthog?: {
    /** Server Env reference, for example `env({ secret: true, source: env.source("POSTHOG_API_KEY") })`. */
    apiKey: EnvVariableDeclaration | string
    /** Defaults to `https://us.i.posthog.com`. */
    host?: string
  }
  /** Options for the evlog Nitro module, such as `sampling`, `redact`, and `pretty`. */
  evlog?: NitroModuleOptions
  /** Durable papercut reports, backed by the Console invocation journal. */
  papercuts?: true | { eventPrefix?: string, uuidNamespace?: string, intervalMs?: number }
  /** Queue bound for best-effort events and for the log buffer. Defaults to 1,000. */
  maxPending?: number
}

const generatedObservabilityPlugin = ".vitehub/nitro/observability/plugin.mjs"

function renderObservabilityNitroPlugin(options: ObservabilityOptions): string {
  const papercuts = options.papercuts === true ? {} : options.papercuts
  // JSON.stringify drops unset values.
  const settings = { service: options.service, environment: options.environment, maxPending: options.maxPending }
  const posthog = options.posthog ? { host: options.posthog.host, service: options.service } : undefined
  return [
    `import { installObservability } from "@vite-hub/agent/observability/host"`,
    ...(posthog
      ? [
          `import { posthog } from "@vite-hub/agent/observability/posthog"`,
          `import { useServerEnv } from "#vitehub/env/server"`,
        ]
      : []),
    ...(papercuts ? [`import { getConsoleInvocations } from "vite-hub/console/server"`] : []),
    "",
    "export default function viteHubObservabilityPlugin(nitroApp) {",
    ...(posthog
      ? [
          "  const apiKey = useServerEnv().observability?.posthog?.apiKey",
          "  const key = typeof apiKey?.unseal === \"function\" ? apiKey.unseal() : apiKey",
        ]
      : []),
    "  installObservability({",
    `    ...${JSON.stringify(settings)},`,
    ...(posthog ? [`    ...(key ? { exporter: posthog({ ...${JSON.stringify(posthog)}, apiKey: key }) } : {}),`] : []),
    ...(papercuts ? [`    papercuts: { ...${JSON.stringify(papercuts)}, invocations: getConsoleInvocations },`] : []),
    "  })(nitroApp)",
    "}",
    "",
  ].join("\n")
}

async function writeIfChanged(file: string, contents: string): Promise<void> {
  if (await readFile(file, "utf8").catch(() => undefined) === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

/** Register the evlog Nitro module and a generated plugin that installs `useObservability()`. */
export function observabilityVitePlugin(options: ObservabilityOptions): Plugin {
  if (!options.service?.trim()) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0125({ message: "[vitehub] observability requires a non-empty service name." })
  }
  return {
    name: "vite-hub/observability",
    async config(config) {
      const { default: evlog } = await import("evlog/nitro/v3").catch(() => {
        throw viteHubErrorDiagnostics.VITE_HUB_B0012({ message: "[vitehub] vitehub({ observability }) requires the evlog package. Install evlog." })
      })
      // SAFETY: ViteHub Env and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & { env?: { server?: Record<string, unknown> }, nitro?: Record<string, unknown> }
      if (options.posthog) {
        const env = viteConfig.env ??= {}
        const server = env.server ??= {}
        // SAFETY: A previous run of this hook on the same config object wrote this shape.
        if (server.observability !== undefined && (server.observability as { posthog?: { apiKey?: unknown } }).posthog?.apiKey !== options.posthog.apiKey) {
          throw viteHubErrorDiagnostics.VITE_HUB_R0128({ message: "[vitehub] env.server.observability is reserved for vitehub({ observability })." })
        }
        server.observability = { posthog: { apiKey: options.posthog.apiKey } }
      }
      const plugin = resolve(config.root || process.cwd(), generatedObservabilityPlugin)
      await writeIfChanged(plugin, renderObservabilityNitroPlugin(options))
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addPlugin(plugin)
      const modules = Array.isArray(kit.config.modules) ? kit.config.modules : []
      const evlogOptions = options.evlog ?? {}
      const env: NonNullable<NitroModuleOptions["env"]> = { service: options.service }
      if (options.environment) env.environment = options.environment
      Object.assign(env, evlogOptions.env)
      // One evlog module per Nitro app. Skip it when this hook already ran on the same config.
      if (!modules.some(module => module instanceof Object && "name" in module && module.name === "evlog")) {
        kit.config.modules = [...modules, evlog({ ...evlogOptions, env })]
      }
      viteConfig.nitro = kit.config
    },
  }
}
