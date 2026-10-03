export async function stopChild(child, graceMs = 500) {
  const exited = child.exitCode !== null || child.signalCode !== null
  const closed = exited ? Promise.resolve() : new Promise(resolve => child.once("close", resolve))
  signalChild(child, "SIGTERM")
  let timer
  try {
    await Promise.race([
      closed,
      new Promise(resolve => { timer = setTimeout(resolve, graceMs) }),
    ])
    // The process group can outlive its leader, so also stop surviving descendants.
    signalChild(child, "SIGKILL")
    await closed
    await waitForGroupExit(child)
  }
  finally {
    clearTimeout(timer)
  }
}

async function waitForGroupExit(child) {
  if (process.platform === "win32" || !child.pid) return
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0)
      signalChild(child, "SIGKILL")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    catch (error) {
      if (error.code === "ESRCH") return
      throw error
    }
  }
  // A detached descendant can remain as a zombie after SIGKILL. Its parent
  // process has exited, so there is nothing more this process can reap.
}

function signalChild(child, signal) {
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    return
  }
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  }
  catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

// Keep signal cleanup active until the provider has been reaped.
export function manageChild(...initialChildren) {
  const children = new Set(initialChildren)
  let cleanup
  let interrupted = false
  let stopping = false
  const pendingStops = new Set()
  const stop = () => {
    stopping = true
    cleanup ??= (async () => {
      while (children.size) {
        const snapshot = [...children]
        await Promise.all(snapshot.map(child => stopChild(child)))
        if (![...children].some(child => !snapshot.includes(child))) break
      }
      await Promise.all(pendingStops)
    })().finally(() => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    })
    return cleanup
  }
  stop.addChild = child => {
    children.add(child)
    if (stopping) {
      const pending = stopChild(child).finally(() => pendingStops.delete(pending))
      pendingStops.add(pending)
    }
  }
  stop.removeChild = child => children.delete(child)
  const onSignal = async signal => {
    if (interrupted) return
    interrupted = true
    try {
      await stop()
    }
    finally {
      // Restore Node's default signal termination, including its exit status.
      process.kill(process.pid, signal)
    }
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  return stop
}
