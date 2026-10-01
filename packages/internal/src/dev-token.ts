/** Private dev credentials are scoped to one project, endpoint, and server instance. */
export interface ViteHubDevTokenScope {
  namespace: string
  serverId: string
}

export const viteHubDevTokenHeader = "x-vitehub-dev-token"

export async function viteHubDevTokenFile(rootDir: string, scope: ViteHubDevTokenScope): Promise<string> {
  const [{ createHash }, { tmpdir }, { join, resolve }] = await Promise.all([
    import("node:crypto"), import("node:os"), import("node:path"),
  ])
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  return join(tmpdir(), "vitehub-dev-tokens", hash(scope.namespace), hash(resolve(rootDir)), hash(scope.serverId), "token")
}

async function viteHubDevTokenActiveFile(rootDir: string, namespace: string): Promise<string> {
  const [{ createHash }, { tmpdir }, { join, resolve }] = await Promise.all([
    import("node:crypto"), import("node:os"), import("node:path"),
  ])
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  return join(tmpdir(), "vitehub-dev-tokens", hash(namespace), hash(resolve(rootDir)), "active")
}

export async function createViteHubDevToken(rootDir: string, namespace: string): Promise<{ serverId: string, token: string }> {
  const serverId = globalThis.crypto.randomUUID()
  const token = [...globalThis.crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("")
  const [{ mkdir, rename, writeFile }, { dirname, join }] = await Promise.all([import("node:fs/promises"), import("node:path")])
  const file = await viteHubDevTokenFile(rootDir, { namespace, serverId })
  await mkdir(dirname(file), { mode: 0o700, recursive: true })
  await writeFile(file, `${token}\n`, { flag: "wx", mode: 0o600 })
  const active = await viteHubDevTokenActiveFile(rootDir, namespace)
  await mkdir(dirname(active), { mode: 0o700, recursive: true })
  const temporary = join(dirname(active), `.active-${serverId}`)
  await writeFile(temporary, `${serverId}\n${token}\n`, { mode: 0o600 })
  await rename(temporary, active)
  return { serverId, token }
}

export async function readViteHubDevTokenServerId(rootDir: string, namespace: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    return (await readFile(await viteHubDevTokenActiveFile(rootDir, namespace), "utf8")).split("\n", 1)[0]?.trim() || undefined
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

/** Reads the active server credential from one atomically replaced snapshot. */
export async function readViteHubDevTokenActive(rootDir: string, namespace: string): Promise<{ serverId: string, token: string } | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    const [serverId, token] = (await readFile(await viteHubDevTokenActiveFile(rootDir, namespace), "utf8")).split("\n")
    return serverId?.trim() && token?.trim() ? { serverId: serverId.trim(), token: token.trim() } : undefined
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

export async function readViteHubDevToken(rootDir: string, scope: ViteHubDevTokenScope): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises")
    return (await readFile(await viteHubDevTokenFile(rootDir, scope), "utf8")).trim() || undefined
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

export async function removeViteHubDevToken(rootDir: string, scope: ViteHubDevTokenScope): Promise<void> {
  const [{ rm, rmdir }, { dirname }] = await Promise.all([import("node:fs/promises"), import("node:path")])
  const file = await viteHubDevTokenFile(rootDir, scope)
  await rm(file, { force: true })
  // Leave the active snapshot in place. A superseded server must never remove a replacement's marker.
  await rmdir(dirname(file)).catch(() => {})
}
