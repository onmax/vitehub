import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createViteHubDevToken, readViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { defineScheduleTarget, schedules } from "../src/index.ts"
import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute, scheduleDevRuntimeRoute, scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "../src/dev.ts"
import { handleScheduleDevRequest } from "../src/runtime/dev.ts"
import { resetScheduleRuntime, setScheduleRuntimeRegistry } from "../src/runtime/state.ts"
import { registerScheduleDevEndpoint } from "../src/vite-dev.ts"
import { runScheduleCli } from "../src/cli.ts"

import type { IncomingMessage, ServerResponse } from "node:http"

describe("Schedule private dev authority", () => {
  it("rejects network mutations at Vite and Nitro, then permits the project CLI with its private token", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-dev-auth-"))
    const middleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void)[] = []
    const invoked = vi.fn()
    setScheduleRuntimeRegistry({ report: async () => defineScheduleTarget({ handler: async () => { invoked() } }) })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "digest", target: "report" })
    const httpServer = createServer((req, res) => {
      middleware[0]!(req, res, () => {
        void (async () => {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
          const headers = Object.fromEntries(Object.entries(req.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]))
          const response = await handleScheduleDevRequest(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) }), { rootDir: root })
          res.writeHead(response.status, Object.fromEntries(response.headers))
          res.end(Buffer.from(await response.arrayBuffer()))
        })().catch(error => { res.writeHead(500); res.end(String(error)) })
      })
    })
    await registerScheduleDevEndpoint({
      config: { root, server: { host: "0.0.0.0" } }, httpServer,
      environments: { nitro: { dispatchFetch: (request: Request) => handleScheduleDevRequest(request, { rootDir: root }) } },
      middlewares: { use: handler => { middleware.push(handler) } },
    })
    await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve))
    const address = httpServer.address()
    if (!address || typeof address === "string") throw new Error("Missing test server address")
    const url = `http://127.0.0.1:${address.port}`
    const publicGuard = { [scheduleDevHeader]: scheduleDevHeaderValue, "content-type": "application/json" }
    let serverId = ""
    const other = await createViteHubDevToken(join(root, "other"), scheduleDevTokenNamespace)
    try {
      const discoveryText = await (await fetch(`${url}${scheduleDevRoute}`, { headers: publicGuard })).text()
      const discovery = JSON.parse(discoveryText)
      serverId = discovery.scheduleDevTokenServerId
      const token = await readViteHubDevToken(root, { namespace: scheduleDevTokenNamespace, serverId })
      expect(token).toBeTruthy()
      expect(discoveryText).not.toContain(token!)
      for (const route of [scheduleDevRoute, scheduleDevRuntimeRoute]) {
        for (const operation of ["run", "enable", "disable"]) {
          for (const headers of [publicGuard,
            { ...publicGuard, [viteHubDevTokenHeader]: "wrong", [scheduleDevTokenServerHeader]: serverId },
            { ...publicGuard, [viteHubDevTokenHeader]: other.token, [scheduleDevTokenServerHeader]: other.serverId }]) {
            const response = await fetch(`${url}${route}`, { method: "POST", headers, body: JSON.stringify({ id: "digest", operation }) })
            expect(response.status).toBe(403)
          }
        }
      }
      expect(invoked).not.toHaveBeenCalled()
      expect((await schedules.get("digest"))?.enabled).toBe(true)
      for (const operation of ["run", "disable", "enable"]) {
        let stdout = ""
        let stderr = ""
        expect(await runScheduleCli([operation, "digest", "--url", url, "--json"], {
          cwd: root, rootDir: root, env: {}, stdout: { write: chunk => { stdout += String(chunk); return true } }, stderr: { write: chunk => { stderr += String(chunk); return true } },
        })).toBe(0)
        expect(JSON.parse(stdout)).toHaveProperty(operation === "run" ? "run" : "schedule")
        expect(stdout + stderr).not.toContain(token!)
        expect(stderr).toBe("")
      }
      await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
      await symlink(resolve(import.meta.dirname, ".."), join(root, "node_modules/@vite-hub/schedule"), "dir")
      await writeFile(join(root, "vite.config.mjs"), 'import { hubSchedule } from "@vite-hub/schedule/vite"; export default { plugins: [hubSchedule()] };')
      const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/src/index.ts"), "schedule", "run", "digest", "--url", url, "--json"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", chunk => { stdout += String(chunk) })
      child.stderr.on("data", chunk => { stderr += String(chunk) })
      const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
      expect(exitCode, stderr).toBe(0)
      expect(JSON.parse(stdout).run.status).toBe("succeeded")
      expect(stdout + stderr).not.toContain(token!)
      expect(stderr).toBe("")
      expect(invoked).toHaveBeenCalledTimes(2)
      expect((await schedules.get("digest"))?.enabled).toBe(true)
    }
    finally {
      await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()))
      if (serverId) await vi.waitFor(async () => { expect(await readViteHubDevToken(root, { namespace: scheduleDevTokenNamespace, serverId })).toBeUndefined() })
      await removeViteHubDevToken(join(root, "other"), { namespace: scheduleDevTokenNamespace, serverId: other.serverId })
      resetScheduleRuntime()
      await rm(root, { recursive: true, force: true })
    }
  })
})
