import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { hubWorkflow } from "../src/vite.ts"
import type { ResolvedConfig, UserConfig } from "vite"

const generated = vi.hoisted(() => vi.fn())
vi.mock("../src/internal/vite-build.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/internal/vite-build.ts")>()
  return {
    ...original,
    generateWorkflowProviderOutputs: async (...args: Parameters<typeof original.generateWorkflowProviderOutputs>) => {
      generated(args[0])
      return await original.generateWorkflowProviderOutputs(...args)
    },
  }
})

beforeEach(() => generated.mockClear())

describe("Workflow preparation for Schedule", () => {
  it.each([true, false])("retains each reused build's Workflow sources and aliases with resolved forwarded directories %j", async (retainForwardedDirs) => {
    const plugin = hubWorkflow({ provider: "vercel" })
    const roots: string[] = []
    try {
      const configs: ResolvedConfig[] = []
      for (const name of ["first", "second"]) {
        const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-schedule-build-"))
        roots.push(root)
        const server = join(root, "backend")
        await mkdir(join(server, "workflows"), { recursive: true })
        await symlink(join(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
        await writeFile(join(root, "alias.ts"), `export const name = ${JSON.stringify(name)}\n`)
        await writeFile(join(server, "workflows", `${name}.ts`), "export default async function run() { return 'ok' }\n")
        const input: UserConfig & { [VITEHUB_SERVER_DIRS]?: string[] } = {
          root,
          plugins: [],
          workflow: { provider: "vercel" },
          resolve: { alias: [{ find: "build-alias", replacement: join(root, "alias.ts") }] },
          [VITEHUB_SERVER_DIRS]: [server],
        }
        await (plugin.config as (config: UserConfig) => void)(input)
        // Model a host config clone that omits the framework's forwarded-directory field.
        const config = { ...input, command: "build" } as unknown as ResolvedConfig
        if (!retainForwardedDirs) Reflect.deleteProperty(config, VITEHUB_SERVER_DIRS)
        configs.push(config)
      }
      // Both config hooks run before either configResolved hook.
      for (const config of configs) await (plugin.configResolved as (config: ResolvedConfig) => void)(config)
      const artifacts = await Promise.all(configs.map(config =>
        plugin.vitehub?.workflow?.prepareScheduleRuntime?.(join(config.root, "artifact"), config),
      ))
      for (const [index, runtime] of artifacts.entries()) {
        expect(runtime).toBeDefined()
        const name = index === 0 ? "first" : "second"
        const other = index === 0 ? "second" : "first"
        const registry = await readFile(runtime!.registryFile, "utf8")
        expect(registry).toContain(`${name}.ts`)
        expect(registry).not.toContain(`${other}.ts`)
        expect(await readFile(runtime!.bundleAlias["build-alias"]!, "utf8")).toContain(JSON.stringify(name))
      }
    } finally {
      await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
    }
  })

  it.each([true, false])("uses each environment config and owning catalog when the clone retains private metadata %j", async (retainPrivateMetadata) => {
    const plugin = hubWorkflow({ provider: "vercel" })
    const roots: string[] = []
    try {
      const configs: ResolvedConfig[] = []
      for (const name of ["first", "second"]) {
        const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-reused-build-"))
        roots.push(root)
        const server = join(root, "backend")
        await mkdir(join(server, "workflows"), { recursive: true })
        await symlink(join(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
        await writeFile(join(server, "workflows", `${name}.ts`), "export default async function run() { return 'ok' }\n")
        const input: UserConfig & { [VITEHUB_SERVER_DIRS]?: string[] } = {
          root,
          plugins: [],
          workflow: { provider: "vercel" },
          [VITEHUB_SERVER_DIRS]: [server],
        }
        await (plugin.config as (config: UserConfig) => void)(input)
        configs.push({
          ...input,
          build: { outDir: "dist" },
          command: "build",
          define: {
            __VITEHUB_PUBLIC_URL__: JSON.stringify(`https://${name}.example.com`),
            __VITEHUB_APP_BASE_URL__: JSON.stringify(`/${name}/`),
          },
          resolve: { alias: [] },
        } as unknown as ResolvedConfig)
      }
      // Resolve both configs before either environment starts, as Vite's builder does.
      for (const config of configs) await (plugin.configResolved as (config: ResolvedConfig) => void)(config)
      const contexts = configs.map(config => {
        // Vite creates an environment config from the resolved app config.
        const clone = { ...config }
        if (!retainPrivateMetadata) {
          for (const key of Object.getOwnPropertySymbols(clone)) Reflect.deleteProperty(clone, key)
          Reflect.deleteProperty(clone, VITEHUB_SERVER_DIRS)
          Reflect.deleteProperty(clone, "__vitehubWorkflowServerDirs")
        }
        return { environment: { config: clone } }
      })
      // Start both environments before either completes its provider output.
      for (const context of contexts) {
        ;(plugin.buildStart as (this: typeof context) => void).call(context)
      }
      for (const [index, context] of contexts.entries()) {
        const config = configs[index]!
        await (plugin.buildEnd as (this: typeof context, error?: Error) => Promise<void>).call(context)
        // The host plugins finalize this original config's catalog.
        const contributions = useProviderOutputCatalog(config).takeDeploymentContributions()
        expect(contributions).toHaveLength(1)
        await contributions[0]!.write({
          readCloudflareState: async () => ({ wranglerConfig: {} }),
          signal: new AbortController().signal,
          write: async () => undefined,
        })
        expect(generated).toHaveBeenLastCalledWith(expect.objectContaining({
          rootDir: config.root,
          bundleDefines: config.define,
        }))
      }
      for (const [index, root] of roots.entries()) {
        const name = index === 0 ? "first" : "second"
        const registry = await readFile(join(root, ".vitehub/workflow/registry.mjs"), "utf8")
        expect(registry).toContain(`${name}.ts`)
        expect(registry).not.toContain(index === 0 ? "second.ts" : "first.ts")
      }
    } finally {
      await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
    }
  })
})
