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
