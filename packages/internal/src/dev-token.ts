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

export async function createViteHubDevToken(rootDir: string, namespace: string): Promise<{ serverId: string, token: string }> {
  const serverId = globalThis.crypto.randomUUID()
  const token = [...globalThis.crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("")
  const [{ mkdir, writeFile }, { dirname }] = await Promise.all([import("node:fs/promises"), import("node:path")])
  const file = await viteHubDevTokenFile(rootDir, { namespace, serverId })
  await mkdir(dirname(file), { mode: 0o700, recursive: true })
  await writeFile(file, `${token}\n`, { flag: "wx", mode: 0o600 })
  return { serverId, token }
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
  await rmdir(dirname(file)).catch(() => {})
}
