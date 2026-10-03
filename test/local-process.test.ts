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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  it.skipIf(process.platform === "win32")(`cleans up the provider group when the runner receives ${signal}`, async () => {
    const helper = fileURLToPath(new URL("./local/process.mjs", import.meta.url))
    const runner = spawn(process.execPath, ["--input-type=module", "-e", `
      import { spawn } from "node:child_process";
      import { manageChild } from ${JSON.stringify(helper)};
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
        detached: true, stdio: ['ignore', 'pipe', 'inherit'],
      });
      manageChild(child);
      child.stdout.once('data', () => console.log(child.pid));
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "pipe"] })
    const closed = once(runner, "close")
    let providerPid: number | undefined
    try {
      const [output] = await once(runner.stdout!, "data")
      providerPid = Number(String(output).trim())
      expect(providerPid).toBeGreaterThan(0)
      runner.kill(signal)
      await closed
      expect(runner.signalCode).toBe(signal)
      expect(() => process.kill(-providerPid!, 0)).toThrow(/ESRCH/)
    }
    finally {
      if (providerPid) {
        try { process.kill(-providerPid, "SIGKILL") }
        catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH") }
      }
      if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL")
      await closed
    }
  })
}
