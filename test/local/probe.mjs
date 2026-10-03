import { setTimeout as sleep } from "node:timers/promises"

export async function waitForProbe(url, timeoutMs = 60_000) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt))
      const response = await fetch(new URL("/api/tests/probe", url), {
        signal: AbortSignal.timeout(remaining),
      })
      const bodyCancellation = response.body?.cancel()
      if (bodyCancellation) {
        await Promise.race([
          Promise.resolve(bodyCancellation),
          sleep(Math.max(0, timeoutMs - (Date.now() - startedAt)), undefined, { ref: false }),
        ])
      }
      if (response.ok) return
      lastError = new Error(`probe status ${response.status}`)
    }
    catch (error) {
      lastError = error
    }
    await sleep(Math.min(1_000, Math.max(0, timeoutMs - (Date.now() - startedAt))))
  }
  throw new Error(`[e2e:local] App at ${url} never became healthy: ${lastError}`)
}
