import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import { describe, expect, it, vi } from "vitest"

import * as consoleRoutes from "../src/console/runtime/console-route.ts"
import consolePageHandler from "../src/console/runtime/server/page.get.ts"

describe("Console application mount", () => {
  it.each(["", "/portal", "/team/portal"])("mounts Connections requests and navigation under %s", async (base) => {
    const pathname = `${base}/_vitehub/connections`
    const source = readFileSync(new URL("../src/console/runtime/client/main.js", import.meta.url), "utf8")
      .split("const loadSections =")[0]!
      .replace(/^import[\s\S]*?;\n/gm, "")
    const components = Object.fromEntries([...source.matchAll(/component: (\w+)/g)].map(([, name]) => [name!, {}]))
    const createRouter = vi.fn((options: { history: string, routes: Array<{ name: string, props: Record<string, unknown> }> }) => options)
    runInNewContext(source, {
      ...consoleRoutes,
      ...components,
      createRouter,
      createWebHistory: (path: string) => path,
      window: { location: { pathname } },
    })
    const router = createRouter.mock.calls[0]![0]
    expect(router.history).toBe(`${base}/_vitehub/`)
    const connections = router.routes.find(route => route.name === "vitehub-console-connections")!
    expect(connections.props.managementBase).toBe(`${base}/_vitehub/connections/manage`)
    expect(connections.props.sectionsBase).toBe(`${base}/api/_vitehub/console/sections`)
    expect(connections.props.agentsBase).toBe(`${base}/api/_vitehub/console/agents`)
    expect(router.routes.find(route => route.name === "vitehub-console-agent")?.props.hostBase).toBe(base)

    const page = await consolePageHandler({ req: { method: "GET", url: `https://app.test${pathname}` } }).text()
    expect(page).toContain(`src="${base}/api/_vitehub/console/client.js"`)
    expect(page).toContain(`src="${base}/_vitehub/assets/__VITEHUB_CONSOLE_SCRIPT_ASSET__"`)
    expect(page).toContain(`href="${base}/_vitehub/assets/__VITEHUB_CONSOLE_STYLE_ASSET__"`)
  })
})
