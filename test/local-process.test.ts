import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

import { stopChild } from "./local/process.mjs"

it.skipIf(process.platform === "win32")("reaps a child that ignores SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const closed = once(child, "close")
  try {
    await once(child.stdout!, "data")
    await stopChild(child, 20)
    expect(child.signalCode).toBe("SIGKILL")
    await closed
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid!, "SIGKILL")
      await closed
    }
  }
})

it.skipIf(process.platform === "win32")("kills descendants after the group leader exits", async () => {
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require('node:child_process')
    spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
    process.on('SIGTERM', () => process.exit(0))
    setInterval(() => {}, 1000)
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] })
  const closed = once(child, "close")
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await once(child.stdout!, "data")
    await Promise.race([
      stopChild(child, 20),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("descendant survived cleanup")), 2000) }),
    ])
    expect(child.exitCode).toBe(0)
    expect(() => process.kill(-child.pid!, 0)).toThrow(/ESRCH/)
    await closed
  }
  finally {
    clearTimeout(timer)
    try { process.kill(-child.pid!, "SIGKILL") }
    catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH") }
    await closed
  }
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  it.skipIf(process.platform === "win32")(`cleans up the provider group when the runner receives ${signal}`, async () => {
    const helper = fileURLToPath(new URL("./local/process.mjs", import.meta.url))
    const runner = spawn(process.execPath, ["--input-type=module", "-e", `
      import { spawn } from "node:child_process";
      import { manageChild } from ${JSON.stringify(helper)};
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
        detached: true, stdio: ['ignore', 'pipe', 'inherit'],
      });
      const suite = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
        detached: true, stdio: ['ignore', 'ignore', 'inherit'],
      });
      const stop = manageChild(child);
      stop.addChild(suite);
      child.stdout.once('data', () => console.log(child.pid + ' ' + suite.pid));
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "pipe"] })
    const closed = once(runner, "close")
    let providerPid: number | undefined
    let suitePid: number | undefined
    try {
      const [output] = await once(runner.stdout!, "data")
      const [provider, suite] = String(output).trim().split(/\s+/).map(Number)
      providerPid = provider
      suitePid = suite
      expect(providerPid).toBeGreaterThan(0)
      expect(suitePid).toBeGreaterThan(0)
      runner.kill(signal)
      await closed
      expect(runner.signalCode).toBe(signal)
      expect(() => process.kill(-providerPid!, 0)).toThrow(/ESRCH/)
      expect(() => process.kill(-suitePid!, 0)).toThrow(/ESRCH/)
    }
    finally {
      for (const pid of [providerPid, suitePid]) {
        if (!pid) continue
        try { process.kill(-pid, "SIGKILL") }
        catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH") }
      }
      if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL")
      await closed
    }
  })
}
