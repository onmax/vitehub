export async function stopChild(child, graceMs = 500) {
  const exited = child.exitCode !== null || child.signalCode !== null
  if (exited) return
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
  }
  finally {
    clearTimeout(timer)
  }
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
  const stop = () => {
    cleanup ??= (async () => {
      while (children.size) {
        const snapshot = [...children]
        await Promise.all(snapshot.map(child => stopChild(child)))
        if (![...children].some(child => !snapshot.includes(child))) break
      }
    })().finally(() => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    })
    return cleanup
  }
  stop.addChild = child => children.add(child)
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
