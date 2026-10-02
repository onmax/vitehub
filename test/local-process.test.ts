import { spawn } from "node:child_process"
import { once } from "node:events"
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
