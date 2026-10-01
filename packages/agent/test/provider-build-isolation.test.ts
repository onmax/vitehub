import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { hubAgent } from "../src/vite.ts"
import type { ProviderDeploymentOutputWriter } from "@vite-hub/internal/build/deployment-output"
import type { ResolvedConfig } from "vite"

vi.mock("@vite-hub/internal/build/vercel-runtime-packages", () => ({
  copyNodeRuntimePackages: vi.fn(async () => undefined),
  copyVercelFunctionRuntimePackages: vi.fn(async () => undefined),
}))

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it.each([true, false])("keeps Agent output in its owning catalog across environment clones with metadata %j", async (retainMetadata) => {
  vi.stubEnv("VITEHUB_HOSTING", "netlify")
  const plugin = hubAgent({ providers: { state: { provider: "memory" } } })
  const configs: ResolvedConfig[] = []
  for (const name of ["first", "second"]) {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-build-isolation-"))
    roots.push(root)
    const server = join(root, "backend")
    await mkdir(join(server, "agents"), { recursive: true })
    await writeFile(join(server, "agents", `${name}.ts`), "export default {}\n")
    // SAFETY: This fixture supplies the resolved fields read by Agent output generation.
    const config = {
      root, command: "build", plugins: [], build: { outDir: "dist" },
      resolve: { alias: [] }, [VITEHUB_SERVER_DIRS]: [server],
      define: {
        __VITEHUB_PUBLIC_URL__: JSON.stringify({ url: `https://${name}.example.com` }),
        __VITEHUB_APP_BASE_URL__: JSON.stringify(`/${name}/`),
      },
    } as unknown as ResolvedConfig
    configs.push(config)
  }
  for (const config of configs) await (plugin.configResolved as (config: ResolvedConfig) => Promise<void>)(config)
  for (const config of configs) {
    const clone = retainMetadata ? { ...config } : Object.fromEntries(Object.entries(config))
    const context = { environment: { config: clone } }
    ;(plugin.buildStart as (this: typeof context) => void).call(context)
    await (plugin.buildEnd as (this: typeof context) => Promise<void>).call(context)
    const contributions = useProviderOutputCatalog(config).takeDeploymentContributions()
    expect(contributions).toHaveLength(1)
    expect(contributions[0]?.rootDir).toBe(config.root)
    const write = vi.fn<ProviderDeploymentOutputWriter>(async () => undefined)
    await contributions[0]!.write({
      readCloudflareState: async () => ({ wranglerConfig: {} }),
      signal: new AbortController().signal,
      write,
    })
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: config.root,
      netlify: expect.objectContaining({ functions: [expect.objectContaining({
        bundleOptions: expect.objectContaining({ define: config.define }),
      })] }),
    }))
    await contributions[0]?.discard?.()
  }
})
