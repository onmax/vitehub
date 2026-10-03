import { github, type GitHubChannelOptions } from '../channels.ts'
import type { AgentChannelDefinition } from '../types.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, spawn } from "node:child_process"
import type { ExecFileOptionsWithStringEncoding } from "node:child_process"
import { createHash, createSign, randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { lstatSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { Diagnostic } from "nostics"

import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { isRuntimeRecord } from "../internal/runtime-type.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { prepareGitHubPullRequestWorkspace } from "./github-checkout.ts"

const exec = promisify(execFile)
const GITHUB_RATE_LIMIT_FALLBACK_MS = 5 * 60_000
const GITHUB_GRAPHQL_CHECK_TIMEOUT_MS = 60_000

export type GitHubHostSecret = string | { unseal: () => string }

export interface GitHubHostCredentials {
  appId?: number | string
  installationId?: number | string
  owner?: string
  privateKey?: GitHubHostSecret
  rateLimitKey?: string
  token?: GitHubHostSecret
}

export interface GitHubHostCredentialContext {
  /** Repository whose GitHub credentials are needed; omitted for unscoped access. */
  repository?: string
  signal: AbortSignal
}

export interface GitHubHostOptions {
  cacheMs?: number
  /**
   * Keeps pull request checkouts under `root` and reuses them per pull request. Reuse keeps ignored
   * files, such as dependencies and build output, resets everything else, and fetches only the new head.
   * Reuse removes initialized submodules, including their ignored files. Initialize them again as needed.
   * Use it only when one process owns `root`. Pooling requires Linux; other hosts use temporary checkouts.
   */
  checkouts?: { root: string }
  credentials: (context: GitHubHostCredentialContext) => GitHubHostCredentials | Promise<GitHubHostCredentials>
  graphQLCheckTimeout?: number
  identity?: { email?: string, login?: string }
  maxBuffer?: number
  reserve?: number
  userAgent?: string
}

export interface GitHubHostAccess {
  env: Record<string, string>
  token: string
}

export interface GitHubHostPullRequest {
  headRef?: string
  headRepository?: string
  headSha: string
  number: number
  repository: string
}

export interface GitHubHostCheckout extends GitHubHostAccess {
  path: string
  prepareWorkspace(target: string): Promise<void>
  push(target?: string, options?: { signal?: AbortSignal, beforePush?: () => void | Promise<void> }): Promise<string>
  signal: AbortSignal
}

export interface GitHubHostCheckoutOptions {
  signal?: AbortSignal
  timeout?: number
}

export interface GitHubGraphQLBudgetOptions extends GitHubHostCheckoutOptions {
  cost: number
}

export interface GitHubHostCommandOptions extends GitHubHostCheckoutOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  repository?: string
}

export interface GitHubHostAccessOptions extends GitHubHostCheckoutOptions {
  fallback?: boolean
  refresh?: boolean
  repository?: string
}

export interface GitHubGraphQLRateLimit {
  checkedAt: number
  remaining: number
  resetAt: number
}

export interface GitHubGraphQLReservation extends GitHubGraphQLRateLimit {
  release(): void
  settle(actualCost: number): void
  submit(): void
}

export interface GitHubHost {
  channel(options?: Omit<GitHubChannelOptions, 'app'>): AgentChannelDefinition
  /** Return the verified login configured for this host, when available. */
  identity(): string | undefined
  /** Resolve credentials and Git binding for the current checkout callback. */
  environment(): Promise<Record<string, string>>
  access(input?: GitHubHostAccessOptions): Promise<GitHubHostAccess>
  budget(): { limited: false } | { limited: true, remaining: number, resetAt: number }
  command(args: string[], input?: GitHubHostCommandOptions): Promise<{ stderr: string, stdout: string }>
  ensureGraphQLBudget(repository: string, options: GitHubGraphQLBudgetOptions): Promise<GitHubGraphQLReservation>
  isRateLimitError(error: unknown): boolean
  withPullRequestCheckout<T>(pullRequest: GitHubHostPullRequest, run: (checkout: GitHubHostCheckout) => Promise<T>, options?: GitHubHostCheckoutOptions): Promise<T>
}

class GitHubRateLimitError extends Diagnostic {
  readonly resetAt: number

  constructor(repository: string, limit: GitHubGraphQLRateLimit, cause?: unknown) {
    super({
      cause,
      code: "AGENT_R0889",
      docs: "https://vitehub.dev/docs/reference/errors-diagnostics#agent-public-errors",
      why: `GitHub GraphQL work for ${repository} is queued until ${new Date(limit.resetAt).toISOString()} (${limit.remaining} points remaining).`,
    }, GitHubRateLimitError)
    this.name = "GitHubRateLimitError"
    this.resetAt = limit.resetAt
  }
}

function secret(value: GitHubHostSecret | undefined): string | undefined {
  return hasRuntimeType(value, "string") ? value : value?.unseal()
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw agentDiagnostics.AGENT_R0748({ message: `${name} must be a positive integer.` })
  return number
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url")
}

function appJwt(appId: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1_000)
  const data = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ exp: now + 540, iat: now - 60, iss: appId }))}`
  return `${data}.${createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url")}`
}

export interface GitHubAppEnvironment {
  appId: number
  privateKey: string
  /** Fixed installation. Without it, each repository resolves its own installation. */
  installationId?: number
  /** Fallback token for repositories without an App installation. */
  token?: string
  userAgent?: string
}

/**
 * GitHub App credentials for `createGitHubHost()` that resolve the installation of each
 * repository from the App, and the App's bot identity for commits. Results are cached.
 */
export function createGitHubAppCredentials(app: GitHubAppEnvironment) {
  const installations = new Map<string, Promise<number>>()
  let identity: Promise<{ login: string, email: string }> | undefined
  const request = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt(app.appId, app.privateKey)}`, "user-agent": app.userAgent || "vitehub" },
      signal,
    })
    if (!response.ok) throw agentDiagnostics.AGENT_R0757({ message: `GitHub App request ${path} failed with ${response.status}.` })
    return await response.json()
  }
  const installation = (repository: string, signal?: AbortSignal) => {
    const key = owner(repository)
    let pending = installations.get(key)
    if (!pending) {
      pending = request(`/repos/${repository}/installation`, signal).then((body) => {
        const id = isRuntimeRecord(body) ? body.id : undefined
        if (!hasRuntimeType(id, "number") || !Number.isSafeInteger(id) || id <= 0) throw agentDiagnostics.AGENT_R0757({ message: `GitHub App is not installed for ${repository}.` })
        return id
      })
      // A failed lookup, for example before the App is installed, is retried on the next request.
      pending.catch(() => installations.delete(key))
      installations.set(key, pending)
    }
    return pending
  }
  return {
    async credentials(context: GitHubHostCredentialContext): Promise<GitHubHostCredentials> {
      if (!context.repository) return { token: app.token }
      const installationId = app.installationId ?? await installation(context.repository, context.signal)
      return { appId: app.appId, installationId, owner: owner(context.repository), privateKey: app.privateKey, token: app.token }
    },
    /** The App bot's login and noreply email, used as the commit author. */
    async identity(): Promise<{ login: string, email: string }> {
      identity ??= (async () => {
        const body = await request("/app")
        const slug = isRuntimeRecord(body) ? body.slug : undefined
        if (!hasRuntimeType(slug, "string") || !slug) throw agentDiagnostics.AGENT_R0757({ message: "GitHub App response did not include a slug." })
        const login = `${slug}[bot]`
        const user = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { accept: "application/vnd.github+json", "user-agent": app.userAgent || "vitehub" } })
        const userBody: unknown = user.ok ? await user.json() : undefined
        const id = isRuntimeRecord(userBody) ? userBody.id : undefined
        return { login, email: hasRuntimeType(id, "number") ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com` }
      })()
      identity.catch(() => { identity = undefined })
      return await identity
    },
  }
}

function owner(repository: string): string {
  return repository.split("/", 1)[0]!.toLowerCase()
}

function rateLimitMessage(error: unknown): boolean {
  const stderr = isRuntimeRecord(error) && "stderr" in error ? String(error.stderr) : ""
  const message = error instanceof Error ? `${error.message}\n${stderr}` : String(error)
  return /(?:rate limit[^\n]*exceeded|exceeded[^\n]*rate limit)/i.test(message)
}

function secondaryRateLimitMessage(error: unknown): boolean {
  const stderr = isRuntimeRecord(error) && "stderr" in error ? String(error.stderr) : ""
  const message = error instanceof Error ? `${error.message}\n${stderr}` : String(error)
  return /secondary rate limit/i.test(message)
}

function isGraphQLCommand(args: string[]): boolean {
  if (args[0] !== "api") return false
  const optionsWithValues = new Set([
    "--cache", "--field", "--header", "--hostname", "--input", "--jq", "--method", "--preview", "--raw-field", "--template",
    "-F", "-H", "-X", "-f", "-p", "-q", "-t",
  ])
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!
    if (optionsWithValues.has(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith("-")) continue
    return argument === "graphql"
  }
  return false
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException("The operation was aborted.", "AbortError")
}

function controlledOperation(options: GitHubHostCheckoutOptions): { close: () => void, signal: AbortSignal } {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  const timeout = options.timeout === undefined
    ? undefined
    : setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), options.timeout)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener("abort", abort, { once: true })
  return {
    close: () => {
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
    },
    signal: controller.signal,
  }
}

async function waitForCaller<T>(promise: Promise<T>, options: GitHubHostCheckoutOptions): Promise<T> {
  if (!options.signal && options.timeout === undefined) return await promise
  if (options.signal?.aborted) throw abortError(options.signal.reason)
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(options.signal?.reason))
    const timeout = options.timeout === undefined
      ? undefined
      : setTimeout(() => reject(new DOMException("The operation timed out.", "TimeoutError")), options.timeout)
    const settle = <TArgs extends unknown[]>(callback: (...args: TArgs) => void) => (...args: TArgs) => {
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
      callback(...args)
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    promise.then(settle(resolve), settle(reject))
  })
}

export function parseGraphQLRateLimit(value: unknown, checkedAt: number = Date.now()): GitHubGraphQLRateLimit {
  const resources = isRuntimeRecord(value) ? value.resources : undefined
  const graphql = isRuntimeRecord(resources) ? resources.graphql : undefined
  const remaining = isRuntimeRecord(graphql) ? graphql.remaining : undefined
  const reset = isRuntimeRecord(graphql) ? graphql.reset : undefined
  if (!hasRuntimeType(remaining, "number") || !Number.isSafeInteger(remaining) || remaining < 0
    || !hasRuntimeType(reset, "number") || !Number.isSafeInteger(reset) || reset < 1) {
    throw agentDiagnostics.AGENT_R0749({ message: "GitHub did not return a valid GraphQL rate limit." })
  }
  return { checkedAt, remaining, resetAt: reset * 1_000 }
}

/**
 * Reusable pull request checkouts under one root that one process owns. A checkout with a verified
 * head returns to its pull request's idle list with its ignored files. A restarted process adopts
 * the directories that a previous process left under the root, clearing their ignored files.
 * Pull request identity is part of the pool key so ignored state cannot cross the trust boundary between pull requests.
 */
function createCheckoutPool(root: string) {
  const idle = new Map<string, { directory: string, adopted: boolean, submodules: Buffer[] }[]>()
  let adopted: Promise<void> | undefined
  let rootIdentity: { dev: number, ino: number } | undefined
  const key = (repository: string, number: number) => `${repository}#${number}`
  const encodeRepository = (repository: string) => repository.split('/').map(part => Buffer.from(part).toString('base64url')).join('--')
  const decodeRepository = (value: string): string | undefined => {
    const parts = value.split('--')
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined
    try {
      const decoded = parts.map(part => Buffer.from(part, 'base64url').toString())
      return decoded.every((part, index) => Buffer.from(part).toString('base64url') === parts[index])
        ? decoded.join('/')
        : undefined
    }
    catch {
      return undefined
    }
  }
  const release = (repository: string, number: number, directory: string, adopted = false, submodules: Buffer[] = []) => {
    const poolKey = key(repository, number)
    idle.set(poolKey, [...idle.get(poolKey) ?? [], { directory, adopted, submodules }])
  }
  const adopt = () => adopted ??= (async () => {
    await mkdir(root, { recursive: true })
    root = await realpath(root)
    const parent = await open(root, "r")
    try {
      rootIdentity = await parent.stat()
    }
    finally {
      await parent.close()
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const match = /^(.+)-pr-(\d+)-[A-Za-z0-9]{6}$/.exec(entry.name)
      const repository = match ? decodeRepository(match[1]!) : undefined
      if (entry.isDirectory() && repository && match) release(repository, Number(match[2]), join(root, entry.name), true)
    }
  })().catch((error: unknown) => {
    adopted = undefined
    throw error
  })
  return {
    async acquire(repository: string, number: number) {
      await adopt()
      await assertCheckoutDirectories(root)
      const parent = await open(root, "r")
      // Git subprocesses resolve the Node process's descriptor, not their own.
      const anchoredRoot = `/proc/${process.pid}/fd/${parent.fd}`
      const validate = async () => {
        await assertCheckoutDirectories(root)
        const current = await lstat(root)
        const retained = await parent.stat()
        const identity = rootIdentity
        if (!identity || current.dev !== identity.dev || current.ino !== identity.ino
          || retained.dev !== identity.dev || retained.ino !== identity.ino) {
          throw new Error("Pooled checkout root was replaced")
        }
      }
      try {
        await validate()
        let checkout = idle.get(key(repository, number))?.pop()
        let anchoredDirectory = ""
        while (checkout) {
          anchoredDirectory = join(anchoredRoot, basename(checkout.directory))
          try {
            await lstat(anchoredDirectory)
            break
          }
          catch (error: unknown) {
            // SAFETY: Node filesystem errors expose their stable errno code through NodeJS.ErrnoException.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            checkout = idle.get(key(repository, number))?.pop()
          }
        }
        if (!checkout) anchoredDirectory = await mkdtemp(join(anchoredRoot, `${encodeRepository(repository)}-pr-${number}-`))
        return {
          directory: join(root, basename(anchoredDirectory)),
          anchoredDirectory,
          identity: await lstat(anchoredDirectory),
          anchoredRoot,
          reused: Boolean(checkout),
          adopted: checkout?.adopted ?? false,
          submodules: checkout?.submodules ?? [],
          validate,
          close: async () => await parent.close(),
        }
      }
      catch (error) {
        await parent.close()
        throw error
      }
    },
    release,
  }
}

type GitHubCommandOptions = { env: NodeJS.ProcessEnv, maxBuffer: number, signal: AbortSignal }

function checkoutSubmodules(checkout: string, options: GitHubCommandOptions): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", checkout, "ls-tree", "-rz", "HEAD"], {
      env: options.env,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const submodules: Buffer[] = []
    let pending = Buffer.alloc(0)
    let stderr = ""
    let settled = false
    let closed = false
    let failure: unknown
    const fail = (error: unknown) => {
      if (settled || failure !== undefined) return
      failure = error
      // A pipe can fail while Git is still traversing the checkout. Stop it
      // and let the close event settle this promise before cleanup proceeds.
      if (!closed) child.kill()
      else {
        settled = true
        reject(error)
      }
    }
    const succeed = (value: Buffer[]) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      let end = pending.indexOf(0)
      while (end !== -1) {
        const entry = pending.subarray(0, end)
        if (entry.subarray(0, 7).toString() === "160000 ") submodules.push(Buffer.from(entry.subarray(entry.indexOf(9) + 1)))
        pending = pending.subarray(end + 1)
        end = pending.indexOf(0)
      }
    })
    child.stderr.on("data", (chunk: Buffer | string) => { stderr = (stderr + (Buffer.isBuffer(chunk) ? chunk.toString() : chunk)).slice(0, options.maxBuffer) })
    child.stdout.on("error", fail)
    child.stderr.on("error", fail)
    child.on("error", fail)
    child.on("close", (code) => {
      closed = true
      if (failure !== undefined) {
        if (!settled) {
          settled = true
          reject(failure)
        }
      }
      else if (code === 0) succeed(submodules)
      else fail(new Error(`Git submodule scan failed (${code}): ${stderr}`))
    })
  })
}

async function assertCheckoutDirectories(path: string | Buffer, boundary?: string) {
  for (let directory: string | Buffer = Buffer.isBuffer(path) ? path : resolve(path); ; directory = Buffer.isBuffer(directory)
    ? directory.subarray(0, Math.max(directory.lastIndexOf(47), 1))
    : dirname(directory)) {
    if (directory === boundary || (Buffer.isBuffer(directory) && boundary !== undefined && directory.equals(Buffer.from(boundary)))) break
    const entry = await lstat(directory)
    if (!entry.isDirectory()) throw new Error("Pooled checkout has unsafe Git metadata")
    if (Buffer.isBuffer(directory) ? directory.length <= 1 : dirname(directory) === directory) break
  }
}

async function assertGitObjectStore(path: string) {
  if (!(await lstat(path)).isDirectory()) throw new Error("Pooled checkout has unsafe Git metadata")
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await assertGitObjectStore(join(path, entry.name))
    else {
      const file = await lstat(join(path, entry.name))
      if (!file.isFile() || file.nlink !== 1) throw new Error("Pooled checkout has unsafe Git metadata")
    }
  }
}

/**
 * Removes the state of the previous pull request from a pooled checkout. Ignored files stay.
 * The previous run could write Git configuration and hooks, so both are recreated.
 */
async function resetPooledCheckout(checkout: string, anchoredRoot: string, repository: string, submodules: Buffer[], commandOptions: GitHubCommandOptions, discardObjects = false) {
  // Relocate the entire checkout before reading any of its metadata. A rename
  // moves a replaced symlink itself, so validation below never traverses it.
  // Keep reset state outside the pool: callback code can retain a cwd in the
  // relocated checkout and traverse its parent while reset is in flight.
  const privateRoot = await mkdtemp(join(tmpdir(), "vitehub-github-reset-"))
  const privateParent = await open(privateRoot, "r")
  const anchoredPrivateRoot = `/proc/${process.pid}/fd/${privateParent.fd}`
  const parkedCheckout = join(anchoredPrivateRoot, "checkout")
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      // Clear the retained directory even when its visible pathname moved.
      // Never recursively remove a replacement at the original pathname.
      for (const entry of await readdir(anchoredPrivateRoot)) {
        const child = join(anchoredPrivateRoot, entry)
        const identity = await lstat(child)
        // Rename the validated entry before recursive removal. This keeps the
        // removal bound to the object that was inspected: a replacement at
        // the visible child pathname is left untouched.
        const quarantine = join(anchoredPrivateRoot, `.removing-${randomUUID()}`)
        await rename(child, quarantine)
        const moved = await lstat(quarantine)
        if (moved.dev !== identity.dev || moved.ino !== identity.ino) {
          // A concurrent replacement won the rename. Keep the moved object and
          // fail closed rather than recursively deleting an unknown tree.
          continue
        }
        rmSync(quarantine, { force: true, recursive: true })
      }
      const retained = await privateParent.stat()
      const current = await lstat(privateRoot).catch((error: unknown) => {
        // SAFETY: Node filesystem errors expose their stable errno code through NodeJS.ErrnoException.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })
      if (current?.isDirectory() && current.dev === retained.dev && current.ino === retained.ino) {
        // Non-recursive removal fails closed if new contents appear.
        await rmdir(privateRoot)
      }
    }
    finally {
      await privateParent.close()
    }
  }
  try {
    await rename(checkout, parkedCheckout)
    await assertCheckoutDirectories(parkedCheckout, anchoredPrivateRoot)
    const gitMetadata = join(parkedCheckout, ".git")
    if (!(await lstat(gitMetadata)).isDirectory()) throw new Error("Pooled checkout has unsafe Git metadata")
    const info = await lstat(join(gitMetadata, "info")).catch(() => undefined)
    if (info && !info.isDirectory()) throw new Error("Pooled checkout has unsafe Git metadata")
    const gitQuarantine = join(anchoredPrivateRoot, "git")
    await rename(gitMetadata, gitQuarantine)
    await assertGitObjectStore(join(gitQuarantine, "objects"))
    await rm(join(gitQuarantine, "objects/info"), { force: true, recursive: true })
    const replacement = await mkdtemp(join(anchoredPrivateRoot, "replacement-"))
    await exec("git", ["-C", replacement, "init", "-q", "--template="], commandOptions)
    const replacementGit = join(replacement, ".git")
    await rm(join(replacementGit, "objects"), { force: true, recursive: true })
    if (discardObjects) {
      await rm(join(gitQuarantine, "objects"), { force: true, recursive: true })
      await mkdir(join(replacementGit, "objects"))
    }
    else await rename(join(gitQuarantine, "objects"), join(replacementGit, "objects"))
    await mkdir(join(replacementGit, "info"), { recursive: true })
    await writeFile(join(replacementGit, "info/exclude"), "")
    for (const [key, value] of [
      ["core.repositoryformatversion", "1"],
      ["fetch.recurseSubmodules", "false"],
      ["remote.origin.url", `https://github.com/${repository}.git`],
      ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["remote.origin.promisor", "true"],
      ["remote.origin.partialclonefilter", "blob:none"],
    ] as const) await exec("git", ["-C", replacement, "config", key, value], commandOptions)
    await rename(replacementGit, gitMetadata)
    // These paths came from the verified tree before the previous callback,
    // rather than its mutable index or the incoming head's ignore rules.
    for (const submodule of submodules) {
      const target = Buffer.concat([Buffer.from(`${parkedCheckout}${sep}`), submodule])
      try {
        await assertCheckoutDirectories(target.subarray(0, Math.max(target.lastIndexOf(47), 1)), parkedCheckout)
      }
      catch (error: unknown) {
        // SAFETY: Node filesystem errors expose their stable errno code through NodeJS.ErrnoException.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      await rm(target, { force: true, recursive: true })
    }
    await rm(join(parkedCheckout, ".vitehub"), { force: true, recursive: true })
    await rm(`${checkout}.meta.json`, { force: true })
    return {
      directory: parkedCheckout,
      close,
      async restore() {
        await rename(parkedCheckout, checkout)
        await close()
      },
    }
  }
  catch (error) {
    await close()
    throw error
  }
}

export function createGitHubHost(options: GitHubHostOptions): GitHubHost {
  const checkoutScope = new AsyncLocalStorage<GitHubHostAccess & { path: string }>()
  if (options.checkouts !== undefined && (!hasRuntimeType(options.checkouts?.root, "string") || !options.checkouts.root.trim())) {
    throw agentDiagnostics.AGENT_R0748({ message: "GitHub host checkouts.root must be a directory path." })
  }
  // Linux provides descriptor-relative rename through /proc. Other hosts use
  // disposable checkouts because path-based restoration can follow swapped parents.
  const checkoutPool = options.checkouts && process.platform === "linux" ? createCheckoutPool(resolve(options.checkouts.root)) : undefined
  const reserve = options.reserve ?? 1_500
  const cacheMs = options.cacheMs ?? 15_000
  const graphQLCheckTimeout = options.graphQLCheckTimeout ?? GITHUB_GRAPHQL_CHECK_TIMEOUT_MS
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024
  const identity = options.identity ?? {}
  const limits = new Map<string, GitHubGraphQLRateLimit>()
  const limitVersions = new Map<string, number>()
  const observedLimits = new Map<string, GitHubGraphQLRateLimit & { version: number }>()
  const reservations = new Map<string, Set<{
    admittedAtVersion: number
    expired?: boolean
    points: number
    resetAt: number
    rolledOver?: boolean
    submittedAtVersion?: number
  }>>()
  const checks = new Map<string, Promise<GitHubGraphQLRateLimit>>()
  const commands = new Map<string, number>()
  const fallbackIdentities = new Map<string, string>()
  const fallbackIdentityLimit = 1_000
  const budgetStateLimit = 1_000
  const budgetStateAccess = new Map<string, number>()
  const appTokens = new Map<string, { expiresAt: number, token: string }>()

  function touchBudgetState(key: string, now: number): void {
    if (budgetStateAccess.has(key)) {
      budgetStateAccess.delete(key)
      budgetStateAccess.set(key, now)
      return
    }
    while (budgetStateAccess.size >= budgetStateLimit) {
      let evicted = false
      for (const [candidate] of budgetStateAccess) {
        if (reservations.has(candidate) || checks.has(candidate) || commands.has(candidate)) continue
        const limit = limits.get(candidate)
        if (limit?.remaining === 0 && limit.resetAt > now) continue
        budgetStateAccess.delete(candidate)
        limits.delete(candidate)
        limitVersions.delete(candidate)
        observedLimits.delete(candidate)
        evicted = true
        break
      }
      if (!evicted) throw agentDiagnostics.AGENT_R0750({ message: "GitHub credential budget state capacity is exhausted by active rate limits." })
    }
    budgetStateAccess.delete(key)
    budgetStateAccess.set(key, now)
  }

  async function credentials(input: GitHubHostAccessOptions): Promise<GitHubHostCredentials> {
    const operation = controlledOperation(input)
    try {
      operation.signal.throwIfAborted()
      const pending = Promise.resolve().then(() => options.credentials({ repository: input.repository, signal: operation.signal }))
      return await waitForCaller(pending, { signal: operation.signal })
    }
    finally {
      operation.close()
    }
  }

  async function fallbackToken(config: GitHubHostCredentials, input: GitHubHostCheckoutOptions): Promise<string> {
    const configured = secret(config.token)?.trim()
    if (configured) return configured
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "GH_TOKEN" && key !== "GITHUB_TOKEN"))
    const result = await exec("gh", ["auth", "token", "--hostname", "github.com"], {
      env: cleanEnv,
      maxBuffer,
      signal: input.signal,
      timeout: input.timeout,
    })
    const token = result.stdout.trim()
    if (!token) throw agentDiagnostics.AGENT_R0751({ message: "GitHub authentication is not configured." })
    return token
  }

  async function fallbackRateLimitKey(token: string, configuredKey: string | undefined, input: GitHubHostCheckoutOptions): Promise<string> {
    const stableKey = configuredKey?.trim()
    if (stableKey) return `credential:${stableKey}`
    const tokenKey = createHash("sha256").update(token).digest("base64url")
    const cached = fallbackIdentities.get(tokenKey)
    if (cached) return cached
    const response = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": options.userAgent || "vitehub",
      },
      signal: input.signal,
    })
    if (response.status === 403) {
      throw agentDiagnostics.AGENT_R0752({ message: "GitHub credentials that cannot identify their user must provide rateLimitKey." })
    }
    if (!response.ok) throw agentDiagnostics.AGENT_R0753({ message: `GitHub user request failed with ${response.status}.` })
    const body: unknown = await response.json()
    const id = isRuntimeRecord(body) ? body.id : undefined
    if (!hasRuntimeType(id, "number") || !Number.isSafeInteger(id) || id <= 0) {
      throw agentDiagnostics.AGENT_R0754({ message: "GitHub did not return a valid authenticated user ID." })
    }
    const key = `user:${id}`
    if (fallbackIdentities.size >= fallbackIdentityLimit) {
      const oldest = fallbackIdentities.keys().next().value
      if (oldest) fallbackIdentities.delete(oldest)
    }
    fallbackIdentities.set(tokenKey, key)
    return key
  }

  async function scopedAccess(input: GitHubHostAccessOptions): Promise<GitHubHostAccess & { rateLimitKey: string }> {
    const config = await credentials({ repository: input.repository, signal: input.signal })
    const appId = String(config.appId || "").trim()
    const installationId = String(config.installationId || "").trim()
    const appOwner = String(config.owner || "").trim().toLowerCase()
    const privateKey = secret(config.privateKey)?.trim().replace(/\\n/g, "\n") || ""
    const appValues = [appId, installationId, privateKey]
    const repositoryOwner = input.repository ? owner(input.repository) : undefined
    let token: string
    let rateLimitKey: string

    if (appValues.some(Boolean)) {
      if (!appValues.every(Boolean)) throw agentDiagnostics.AGENT_R0755({ message: "GitHub App appId, installationId, and privateKey must be configured together." })
      if (!appOwner) throw agentDiagnostics.AGENT_R0756({ message: "GitHub App owner must be configured with App credentials." })
      if (input.fallback || (repositoryOwner && repositoryOwner !== appOwner)) {
        token = await fallbackToken(config, input)
        rateLimitKey = await fallbackRateLimitKey(token, config.rateLimitKey, input)
      }
      else {
        const numericAppId = positiveInteger(appId, "GitHub App appId")
        const numericInstallationId = positiveInteger(installationId, "GitHub App installationId")
        rateLimitKey = `app:${numericAppId}:${numericInstallationId}`
        const key = `${numericAppId}:${numericInstallationId}:${privateKey}`
        let appToken = appTokens.get(key)
        if (input.refresh || !appToken || appToken.expiresAt <= Date.now() + 60_000) {
          const response = await fetch(`https://api.github.com/app/installations/${numericInstallationId}/access_tokens`, {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${appJwt(numericAppId, privateKey)}`,
              "user-agent": options.userAgent || "vitehub",
            },
            method: "POST",
            signal: input.signal,
          })
          if (!response.ok) throw agentDiagnostics.AGENT_R0757({ message: `GitHub App token request failed with ${response.status}.` })
          const body: unknown = await response.json()
          const responseToken = isRuntimeRecord(body) ? body.token : undefined
          const expiresAt = isRuntimeRecord(body) ? body.expires_at : undefined
          if (!hasRuntimeType(responseToken, "string")) throw agentDiagnostics.AGENT_R0758({ message: "GitHub App token response did not include a token." })
          appToken = {
            expiresAt: hasRuntimeType(expiresAt, "string") ? Date.parse(expiresAt) || Date.now() + 50 * 60_000 : Date.now() + 50 * 60_000,
            token: responseToken,
          }
          if (appTokens.size >= 128) appTokens.delete(appTokens.keys().next().value!)
          appTokens.set(key, appToken)
        }
        token = appToken.token
      }
    }
    else {
      token = await fallbackToken(config, input)
      rateLimitKey = await fallbackRateLimitKey(token, config.rateLimitKey, input)
    }

    const env: Record<string, string> = {
      GH_HOST: "github.com",
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_VALUE_1: '!f() { if [ "$1" = get ]; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f',
      GIT_TERMINAL_PROMPT: "0",
    }
    if (identity.login) {
      env.GIT_AUTHOR_NAME = identity.login
      env.GIT_COMMITTER_NAME = identity.login
    }
    if (identity.email) {
      env.GIT_AUTHOR_EMAIL = identity.email
      env.GIT_COMMITTER_EMAIL = identity.email
    }
    return { env, rateLimitKey, token }
  }

  async function access(input: GitHubHostAccessOptions = {}): Promise<GitHubHostAccess> {
    const operation = controlledOperation(input)
    try {
      return await scopedAccess({ ...input, signal: operation.signal, timeout: undefined })
    }
    finally {
      operation.close()
    }
  }

  async function command(
    args: string[],
    input: GitHubHostCommandOptions = {},
  ): Promise<{ stderr: string, stdout: string }> {
    const operation = controlledOperation(input)
    let auth: Awaited<ReturnType<typeof scopedAccess>> | undefined
    try {
      auth = await scopedAccess({ repository: input.repository, signal: operation.signal })
      touchBudgetState(auth.rateLimitKey, Date.now())
      commands.set(auth.rateLimitKey, (commands.get(auth.rateLimitKey) ?? 0) + 1)
      const execOptions: ExecFileOptionsWithStringEncoding = {
        encoding: "utf8",
        env: { ...process.env, ...input.env, ...auth.env, GH_HOST: "github.com" },
        maxBuffer,
        signal: operation.signal,
      }
      if (input.cwd) execOptions.cwd = input.cwd
      return await exec("gh", args, execOptions)
    }
    catch (error) {
      if (auth && rateLimitMessage(error)
        && (secondaryRateLimitMessage(error) || isGraphQLCommand(args))) {
        const limit = { checkedAt: Date.now(), remaining: 0, resetAt: Date.now() + GITHUB_RATE_LIMIT_FALLBACK_MS }
        touchBudgetState(auth.rateLimitKey, limit.checkedAt)
        limitVersions.set(auth.rateLimitKey, (limitVersions.get(auth.rateLimitKey) ?? 0) + 1)
        limits.set(auth.rateLimitKey, limit)
        throw new GitHubRateLimitError(input.repository ?? "this credential", limit, error)
      }
      throw error
    }
    finally {
      if (auth) {
        const count = commands.get(auth.rateLimitKey)
        if (count === 1) commands.delete(auth.rateLimitKey)
        else if (count !== undefined) commands.set(auth.rateLimitKey, count - 1)
      }
      operation.close()
    }
  }

  async function ensureGraphQLBudget(repository: string, options: GitHubGraphQLBudgetOptions): Promise<GitHubGraphQLReservation> {
    if (!Number.isSafeInteger(options.cost) || options.cost <= 0) throw agentDiagnostics.AGENT_R0759({ message: "GitHub GraphQL cost must be a positive integer." })
    const operation = controlledOperation(options)
    try {
      operation.signal.throwIfAborted()
      const auth = await scopedAccess({ repository, signal: operation.signal })
      const key = auth.rateLimitKey
      const now = Date.now()
      touchBudgetState(key, now)
      const cached = limits.get(key)
      const admit = (limit: GitHubGraphQLRateLimit): GitHubGraphQLReservation => {
        const available = limits.get(key) ?? limit
        if (available.resetAt > Date.now() && available.remaining - options.cost < reserve) {
          throw new GitHubRateLimitError(repository, available)
        }
        const reserved = { ...available, remaining: available.remaining - options.cost }
        const limitVersion = limitVersions.get(key) ?? 0
        const reservation: {
          admittedAtVersion: number
          expired?: boolean
          points: number
          resetAt: number
          rolledOver?: boolean
          submittedAtVersion?: number
        } = { admittedAtVersion: limitVersion, points: options.cost, resetAt: available.resetAt }
        const outstanding = reservations.get(key) ?? new Set()
        outstanding.add(reservation)
        reservations.set(key, outstanding)
        limits.set(key, reserved)
        let settled = false
        const settle = (actualCost: number, released: boolean = false) => {
          if (!Number.isSafeInteger(actualCost) || actualCost < 0) {
            throw agentDiagnostics.AGENT_R0760({ message: "GitHub GraphQL actual cost must be a non-negative integer." })
          }
          if (actualCost > options.cost) {
            throw agentDiagnostics.AGENT_R0761({ message: "GitHub GraphQL actual cost cannot exceed its reserved cost." })
          }
          if (settled) return
          if (!released && reservation.submittedAtVersion === undefined) {
            throw agentDiagnostics.AGENT_R0762({ message: "GitHub GraphQL reservations must be submitted before they are settled." })
          }
          if (released && reservation.submittedAtVersion !== undefined) {
            throw agentDiagnostics.AGENT_R0763({ message: "Submitted GitHub GraphQL reservations cannot be released." })
          }
          settled = true
          const outstanding = reservations.get(key)
          if (!outstanding?.delete(reservation)) return
          if (outstanding.size === 0) reservations.delete(key)
          const releasedPoints = options.cost - actualCost
          const current = limits.get(key)
          if (current?.resetAt === reservation.resetAt) {
            const observed = observedLimits.get(key)
            const remaining = current.remaining + releasedPoints
            const observationCeiling = observed?.resetAt === current.resetAt
              ? observed.version > (reservation.submittedAtVersion ?? observed.version)
                ? Math.max(0, observed.remaining - actualCost
                    - [...(outstanding ?? [])]
                      .filter(other => other.admittedAtVersion >= observed.version)
                      .reduce((points, other) => points + other.points, 0))
                : observed.remaining
              : undefined
            limits.set(key, {
              ...current,
              remaining: observationCeiling === undefined ? remaining : Math.min(remaining, observationCeiling),
            })
          }
        }
        return {
          ...reserved,
          release() {
            settle(0, true)
          },
          settle,
          submit() {
            if (settled) throw agentDiagnostics.AGENT_R0764({ message: "Settled GitHub GraphQL reservations cannot be submitted." })
            if (reservation.expired) throw agentDiagnostics.AGENT_R0765({ message: "Expired GitHub GraphQL reservations cannot be submitted." })
            reservation.submittedAtVersion ??= limitVersions.get(key) ?? limitVersion
          },
        }
      }
      if (cached && cached.resetAt > now && (cached.remaining === 0 || now - cached.checkedAt < cacheMs)) return admit(cached)
      const pending = checks.get(key)
      if (pending) return admit(await waitForCaller(pending, { signal: operation.signal }))
      const checkVersion = limitVersions.get(key) ?? 0
      const check = (async () => {
        const checkOperation = controlledOperation({ timeout: graphQLCheckTimeout })
        try {
          const result = await exec("gh", ["api", "--hostname", "github.com", "rate_limit"], {
            encoding: "utf8",
            env: { ...process.env, ...auth.env },
            maxBuffer,
            signal: checkOperation.signal,
          })
          const limit = parseGraphQLRateLimit(JSON.parse(result.stdout), now)
          if ((limitVersions.get(key) ?? 0) !== checkVersion) {
            return limits.get(key) ?? limit
          }
          const nextVersion = (limitVersions.get(key) ?? 0) + 1
          const observed = observedLimits.get(key)
          observedLimits.set(key, {
            ...limit,
            remaining: observed?.resetAt === limit.resetAt ? Math.min(observed.remaining, limit.remaining) : limit.remaining,
            version: observed?.resetAt === limit.resetAt && observed.remaining <= limit.remaining
              ? observed.version
              : nextVersion,
          })
          const activeReservations = reservations.get(key)
          if (activeReservations) {
            for (const reservation of activeReservations) {
              if (reservation.resetAt === limit.resetAt) continue
              if (reservation.submittedAtVersion === undefined || reservation.rolledOver) {
                reservation.expired = true
                activeReservations.delete(reservation)
              }
              else {
                reservation.resetAt = limit.resetAt
                reservation.rolledOver = true
                reservation.submittedAtVersion = (limitVersions.get(key) ?? 0) + 1
              }
            }
            if (activeReservations.size === 0) reservations.delete(key)
          }
          const outstanding = [...(activeReservations ?? [])]
            .filter(reservation => reservation.resetAt === limit.resetAt
              && (reservation.submittedAtVersion === undefined || reservation.rolledOver))
            .reduce((points, reservation) => points + reservation.points, 0)
          const current = limits.get(key)
          const reconciled = current !== undefined
            && current.resetAt > Date.now()
            && current.resetAt === limit.resetAt
            ? { ...limit, remaining: Math.min(current.remaining, limit.remaining - outstanding) }
            : { ...limit, remaining: limit.remaining - outstanding }
          limitVersions.set(key, nextVersion)
          limits.set(key, reconciled)
          return reconciled
        }
        catch (error) {
          if (rateLimitMessage(error)) {
            const limit = { checkedAt: Date.now(), remaining: 0, resetAt: Date.now() + GITHUB_RATE_LIMIT_FALLBACK_MS }
            limitVersions.set(key, (limitVersions.get(key) ?? 0) + 1)
            limits.set(key, limit)
            throw new GitHubRateLimitError(repository, limit, error)
          }
          throw error
        }
        finally {
          checkOperation.close()
        }
      })().finally(() => checks.delete(key))
      checks.set(key, check)
      return admit(await waitForCaller(check, { signal: operation.signal }))
    }
    finally {
      operation.close()
    }
  }

  function budget(): { limited: false } | { limited: true, remaining: number, resetAt: number } {
    const limited = [...limits.values()].filter(limit => limit.remaining <= reserve && limit.resetAt > Date.now())
    return limited.length
      ? {
          limited: true,
          remaining: Math.min(...limited.map(limit => limit.remaining)),
          resetAt: Math.max(...limited.map(limit => limit.resetAt)),
        }
      : { limited: false }
  }

  async function withPullRequestCheckout<T>(
    pullRequest: GitHubHostPullRequest,
    run: (checkout: GitHubHostCheckout) => Promise<T>,
    options: GitHubHostCheckoutOptions = {},
  ): Promise<T> {
    if (!/^[a-f0-9]{40}$/i.test(pullRequest.headSha)) throw agentDiagnostics.AGENT_R0766({ message: "A pull request headSha must be a full Git commit SHA." })
    for (const repository of [pullRequest.repository, pullRequest.headRepository]) {
      if (repository !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        throw agentDiagnostics.AGENT_R0766({ message: "Expected a GitHub repository in owner/name form." })
      }
    }
    if (pullRequest.headRepository && !pullRequest.headRef) {
      throw agentDiagnostics.AGENT_R0766({ message: "A pull request headRef is required when headRepository is supplied." })
    }
    const pooled = checkoutPool ? await checkoutPool.acquire(pullRequest.repository, pullRequest.number) : undefined
    let checkout = pooled?.anchoredDirectory ?? await mkdtemp(join(tmpdir(), `vitehub-${pullRequest.repository.replace("/", "-")}-pr-${pullRequest.number}-`))
    const operation = controlledOperation(options)
    let keepCheckout = false
    let checkoutIdentity: { dev: number, ino: number } | undefined = pooled?.identity
    let reset: Awaited<ReturnType<typeof resetPooledCheckout>> | undefined
    let submodules: Buffer[] = []
    try {
      const baseAuth = await access({
        refresh: true,
        repository: pullRequest.repository,
        signal: operation.signal,
      })
      const env = { ...process.env, ...baseAuth.env, GH_HOST: "github.com" }
      const commandOptions = { env, maxBuffer, signal: operation.signal }
      if (pullRequest.headRef) {
        await exec("git", ["check-ref-format", `refs/heads/${pullRequest.headRef}`], commandOptions)
        if (pullRequest.headRef.startsWith("-")) throw agentDiagnostics.AGENT_R0766({ message: "A pull request headRef cannot start with a dash." })
      }
      if (pooled?.reused) {
        reset = await resetPooledCheckout(checkout, pooled.anchoredRoot, pullRequest.repository, pooled.submodules, commandOptions, pooled.adopted)
        checkout = reset.directory
      }
      else await exec("git", ["clone", "--filter=blob:none", "--no-checkout", "--", `https://github.com/${pullRequest.repository}.git`, checkout], commandOptions)
      if (pullRequest.headRef) {
        // Fetch the source branch: GitHub's synthetic pull refs can lag a push.
        const sourceRepository = pullRequest.headRepository ?? pullRequest.repository
        const sourceAuth = sourceRepository === pullRequest.repository ? baseAuth : await access({ refresh: true, repository: sourceRepository, signal: operation.signal })
        await exec("git", ["-C", checkout, "fetch", "--no-tags", "--", `https://github.com/${sourceRepository}.git`, `refs/heads/${pullRequest.headRef}`], { ...commandOptions, env: { ...env, ...sourceAuth.env } })
        await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "checkout", "-f", "-B", pullRequest.headRef, "FETCH_HEAD"], commandOptions)
      }
      else {
        await exec("git", ["-C", checkout, "fetch", "--no-tags", "--", "origin", pullRequest.headSha], commandOptions)
        await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "checkout", "-f", "--detach", "FETCH_HEAD"], commandOptions)
      }
      // Read gitlinks directly so cleanup does not parse callback-controlled .gitmodules.
      if (checkoutPool) {
        submodules = await checkoutSubmodules(checkout, commandOptions)
      }
      if (pooled?.reused) {
        for (const submodule of submodules) {
          // Keep the gitlink bytes intact. Git permits paths that are not valid UTF-8.
          const target = Buffer.concat([Buffer.from(`${checkout}${sep}`), submodule])
          await rm(target, { force: true, recursive: true })
          await mkdir(target)
        }
      }
      // An adopted directory has no trusted PR identity: discard ignored state after
      // checkout installs the verified incoming tree, even if its name matches this PR.
      await exec("git", ["-C", checkout, "clean", pooled?.adopted ? "-ffdxq" : "-ffdq"], commandOptions)
      await exec("git", ["-C", checkout, "remote", "set-url", "origin", `https://github.com/${pullRequest.repository}.git`], commandOptions)
      const pushUrl = pullRequest.headRepository
        ? `https://github.com/${pullRequest.headRepository}.git`
        : "disabled://pull-request-head-repository-unavailable"
      await exec("git", ["-C", checkout, "remote", "set-url", "--push", "origin", pushUrl], commandOptions)
      if (pullRequest.headRepository) {
        if (!pullRequest.headRef) throw agentDiagnostics.AGENT_R0766({ message: "A pull request headRef is required when headRepository is supplied." })
        await exec("git", ["-C", checkout, "config", "remote.origin.push", `HEAD:refs/heads/${pullRequest.headRef}`], commandOptions)
      }
      const fetched = (await exec("git", ["-C", checkout, "rev-parse", "HEAD"], commandOptions)).stdout.trim()
      if (fetched !== pullRequest.headSha) throw agentDiagnostics.AGENT_R0767({ message: `Pull request head changed from ${pullRequest.headSha} to ${fetched}.` })
      // Clean with the verified incoming head's ignore rules.
      await exec("git", ["-C", checkout, "clean", "-ffdq"], commandOptions)
      operation.signal.throwIfAborted()
      // Only a checkout with a verified head returns to the pool. Reuse resets it again.
      if (reset && pooled) {
        await reset.restore()
        checkout = pooled.anchoredDirectory
      }
      operation.signal.throwIfAborted()
      await pooled?.validate()
      if (pooled) {
        const retained = await lstat(pooled.anchoredDirectory)
        if (!retained.isDirectory()) throw new Error("Pooled checkout is not a directory")
        checkoutIdentity = { dev: retained.dev, ino: retained.ino }
      }
      // Keep callbacks on the descriptor-anchored path. The visible pool path
      // can be replaced after validation; exposing it would let a callback
      // traverse a different checkout before custody is released.
      const publicCheckout = pooled?.anchoredDirectory ?? checkout
      keepCheckout = Boolean(checkoutPool)
      const prepareWorkspace = async (target: string) => await prepareGitHubPullRequestWorkspace(checkout, target, { signal: operation.signal })
      let pushHead = pullRequest.headSha
      const push = async (target: string = checkout, options: { signal?: AbortSignal, beforePush?: () => void | Promise<void> } = {}) => {
        const signal = options.signal ? AbortSignal.any([operation.signal, options.signal]) : operation.signal
        signal.throwIfAborted()
        const expectedHead = pushHead
        if (!pullRequest.headRepository || !pullRequest.headRef) throw agentDiagnostics.AGENT_R0766({ message: "Pull request source repository and branch are required to push." })
        const readEnv = { ...process.env }
        delete readEnv.GH_TOKEN
        delete readEnv.GITHUB_TOKEN
        delete readEnv.GIT_DIR
        delete readEnv.GIT_WORK_TREE
        delete readEnv.GIT_INDEX_FILE
        delete readEnv.GIT_COMMON_DIR
        for (const key of Object.keys(readEnv)) if (key.startsWith("GIT_CONFIG_")) delete readEnv[key]
        readEnv.GIT_CONFIG_NOSYSTEM = "1"
        readEnv.GIT_CONFIG_GLOBAL = "/dev/null"
        const readOptions = { env: readEnv, maxBuffer, signal }
        const root = (await exec("git", ["-C", target, "rev-parse", "--show-toplevel"], readOptions)).stdout.trim()
        if (await realpath(root) !== await realpath(target)) throw agentDiagnostics.AGENT_R0766({ message: "Push target must be the root of its prepared Git checkout." })
        const head = (await exec("git", ["-C", target, "rev-parse", "HEAD"], readOptions)).stdout.trim()
        if (!/^[a-f0-9]{40}$/i.test(head)) throw agentDiagnostics.AGENT_R0766({ message: "Push target did not return a full Git commit SHA." })
        if (await realpath(target) !== await realpath(checkout)) {
          // Import without host credentials. Authenticated Git only reads our trusted clone's config.
          await exec("git", ["-C", checkout, "-c", "protocol.file.allow=always", "-c", "uploadpack.packObjectsHook=", "fetch", "--no-tags", "--", await realpath(target), head], readOptions)
        }
        await exec("git", ["-C", checkout, "merge-base", "--is-ancestor", expectedHead, head], { ...commandOptions, signal })
        const refreshed = await access({
          refresh: true,
          repository: pullRequest.headRepository,
          signal,
        })
        signal.throwIfAborted()
        await options.beforePush?.()
        await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "push", "--no-verify", `--force-with-lease=refs/heads/${pullRequest.headRef}:${expectedHead}`, "--", pushUrl, `${head}:refs/heads/${pullRequest.headRef}`], {
          env: { ...process.env, ...refreshed.env },
          maxBuffer,
          signal,
        })
        // Re-check custody immediately after the remote mutation. A lease can
        // be reclaimed while Git is in flight; surface that loss so callers do
        // not report the stale operation as successful or continue with merge.
        signal.throwIfAborted()
        await options.beforePush?.()
        pushHead = head
        return head
      }
      return await checkoutScope.run({ ...baseAuth, path: publicCheckout }, () => run({ ...baseAuth, path: publicCheckout, prepareWorkspace, push, signal: operation.signal }))
    }
    finally {
      operation.close()
      try {
        await reset?.close()
        let retainedCheckout = false
        if (keepCheckout && checkoutPool && pooled && checkoutIdentity) {
          const retained = await lstat(pooled.anchoredDirectory).catch((error: unknown) => {
            // SAFETY: Node filesystem errors expose their stable errno code through NodeJS.ErrnoException.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
            throw error
          })
          retainedCheckout = Boolean(retained?.isDirectory() && retained.dev === checkoutIdentity.dev && retained.ino === checkoutIdentity.ino)
          if (retainedCheckout) checkoutPool.release(pullRequest.repository, pullRequest.number, pooled.directory, false, submodules)
        }
        if (!retainedCheckout) {
          const discard = pooled?.anchoredDirectory ?? checkout
          if (pooled && checkoutIdentity) {
            const current = lstatSync(discard, { throwIfNoEntry: false })
            // Do not yield between checking custody and cleanup. A callback
            // may replace this child while the pool's parent stays retained.
            if (current?.dev === checkoutIdentity.dev && current.ino === checkoutIdentity.ino) {
              rmSync(discard, { force: true, recursive: true })
              rmSync(`${discard}.meta.json`, { force: true })
            }
          }
          else await rm(discard, { force: true, recursive: true })
        }
      }
      finally {
        await pooled?.close()
      }
    }
  }

  const host: GitHubHost = {
    identity() {
      return identity.login?.trim() || undefined
    },
    channel(channelOptions = {}) {
      return github({ ...channelOptions, app: host })
    },
    async environment() {
      const current = checkoutScope.getStore()
      if (!current) return (await access({ fallback: true })).env
      return { ...current.env, GIT_DIR: join(current.path, '.git'), GIT_WORK_TREE: '.' }
    },
    access,
    budget,
    command,
    ensureGraphQLBudget,
    isRateLimitError: (error: unknown) => error instanceof GitHubRateLimitError,
    withPullRequestCheckout,
  }
  return host
}
