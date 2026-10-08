import type { EventKind, ForgeOptionsBase, ForgeProvider, WebhookInput, WebhookUpdate } from "forges"
import { fake } from "forges/fake"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { forgejo, gitlab } from "../src/channels.ts"
import type { ForgejoChannelOptions } from "../src/channels.ts"
import type { AgentCallbackContext } from "../src/types.ts"
import { getAgentChannelSyncDefinition } from "../src/internal/channel-sync.ts"
import { runAgentChannelSyncCli } from "../src/internal/channel-sync-cli.ts"

const hosts = ["gitlab", "forgejo"] as const
const stores = new Map<string, ReturnType<typeof fake>>()
const calls: Array<{ host: string, input: WebhookInput | WebhookUpdate }> = []
let realRequests = false
let failedRequest: Error | undefined
let unsupported = false
const connections: Array<{ host: string, options: ForgeOptionsBase }> = []

const subscriptions = {
  gitlab: {
    comment: ["note_events", "confidential_note_events"],
    review: ["merge_requests_events"], review_comment: ["note_events"],
    state_change: ["issues_events", "confidential_issues_events", "merge_requests_events"],
  },
  forgejo: {
    comment: ["issue_comment", "pull_request_comment"],
    review: ["pull_request_review_approved", "pull_request_review_rejected", "pull_request_review_comment"],
    review_comment: ["pull_request_review_comment"], state_change: ["issues", "pull_request", "pull_request_sync"],
  },
}

function translated(host: typeof hosts[number], events: EventKind[] = []) {
  return [...new Set(events.flatMap(event => subscriptions[host][event as keyof typeof subscriptions.gitlab] || [event]))].sort()
}

async function mockHost(host: typeof hosts[number], options: ForgeOptionsBase) {
  const actual = await vi.importActual<Record<typeof host, (input: ForgeOptionsBase) => { create: () => ForgeProvider }>>(`forges/${host}`)
  connections.push({ host, options })
  if (realRequests) return actual[host](options).create()
  const previous = stores.get(host)
  if (previous) return previous.create()
  const factory = fake({ kind: host, instance: new URL(options.baseUrl || (host === "gitlab" ? "https://gitlab.com" : "https://codeberg.org")).host })
  const provider = factory.create()
  const create = provider.webhooks.create
  const update = provider.webhooks.update
  provider.webhooks.create = async (target, input) => {
    calls.push({ host, input })
    return await create(target, { ...input, nativeEvents: translated(host, input.events) })
  }
  provider.webhooks.update = async (ref, input) => {
    calls.push({ host, input })
    return await update(ref, { ...input, nativeEvents: translated(host, input.events) })
  }
  const list = provider.webhooks.list
  provider.webhooks.list = (target, options) => {
    if (failedRequest) throw failedRequest
    return list(target, options)
  }
  if (unsupported) provider.can = () => false
  stores.set(host, { ...factory, create: () => provider })
  return provider
}
vi.mock("forges/gitlab", () => ({ gitlab: (options: ForgeOptionsBase) => ({ create: () => mockHost("gitlab", options) }) }))
vi.mock("forges/forgejo", () => ({ forgejo: (options: ForgeOptionsBase) => ({ create: () => mockHost("forgejo", options) }) }))

const token = "private-access-token"
const secret = "private-hook-secret"
const url = "https://app.example.com/api/_vitehub/agents/reviewer/webhooks/code"
const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("Unexpected network request") })
// SAFETY: Sync resolution only reads the option callbacks and Channel Env in this fixture.
const context = {} as AgentCallbackContext
const events: EventKind[] = ["comment", "review", "review_comment", "state_change"]
// Forgejo options are the subset that both Channels accept.
const options: ForgejoChannelOptions = {
  token, webhookSecret: secret, sync: { repositories: ["platform/api", "platform/web"] },
  pullRequest: { reconcile: { mentions: ["@review-bot"] } },
}

async function sync(host: typeof hosts[number], input: ForgejoChannelOptions = options) {
  const channel = host === "gitlab" ? gitlab(input) : forgejo(input)
  const definition = getAgentChannelSyncDefinition(channel)!
  expect(definition.provider).toBe(host)
  return (await definition.resolve(context, channel))!
}
function planInput(force = false) { return { desiredUrl: url, fetch: fetcher, force } }
function output() {
  const chunks: string[] = []
  return { write: (value: string | Uint8Array) => chunks.push(String(value)), text: () => chunks.join("") }
}

beforeEach(() => {
  stores.clear(); calls.length = 0; connections.length = 0
  realRequests = false; failedRequest = undefined; unsupported = false
  vi.stubEnv("GITLAB_TOKEN", ""); vi.stubEnv("FORGEJO_TOKEN", "")
  vi.stubEnv("GITLAB_WEBHOOK_SECRET", ""); vi.stubEnv("FORGEJO_WEBHOOK_SECRET", "")
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

for (const host of hosts) describe(`${host} webhook sync`, () => {
  it("reports sync.repositories without credentials or a network request", async () => {
    const provider = await sync(host, {})
    const plan = await provider.plan(planInput())
    expect(plan.action).toBe("none")
    expect(plan.unverifiable?.join(" ")).toContain("sync.repositories")
    expect(connections).toEqual([])
    expect(await provider.apply(plan, fetcher)).toEqual(plan.current)
  })

  it("creates one active JSON hook per repository and then plans no change", async () => {
    const provider = await sync(host)
    const plan = await provider.plan(planInput())
    expect(plan.action).toBe("create")
    expect(plan.current.url).toBe("")
    expect(plan.desired.url).toBe(url)
    expect(plan.changes).toHaveLength(2)
    const result = await provider.apply(plan, fetcher)
    expect(result.url).toBe(url)
    expect(stores.get(host)!.store.webhooks).toHaveLength(2)
    for (const hook of stores.get(host)!.store.webhooks) {
      expect(hook).toMatchObject({ url, events, nativeEvents: translated(host, events), active: true, contentType: "json" })
    }
    expect(calls.every(call => call.input.secret === secret)).toBe(true)
    expect(connections[0]!.options).toMatchObject({ auth: { type: "token", token }, fetch: fetcher })
    expect((await provider.plan(planInput())).action).toBe("none")
    const serialized = JSON.stringify({ plan, result })
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(secret)
    expect(plan.unverifiable).toContain("webhookSecret")
  })

  it("updates events and active state, preserves other URLs, and resends the secret with force", async () => {
    const provider = await sync(host)
    await provider.apply(await provider.plan(planInput()), fetcher)
    const factory = stores.get(host)!
    const first = factory.store.webhooks[0]!
    const other = await factory.create().webhooks.create(first.ref.target, { url: "https://other.example.com/hook", events: ["push"], secret: "other-secret" })
    const previous = JSON.stringify(other)
    first.events = ["push"]; first.nativeEvents = ["push"]; first.active = false
    const plan = await provider.plan(planInput())
    expect(plan.action).toBe("update")
    expect(plan.current.url).toBe(url)
    expect(plan.changes).toEqual(["platform/api: update events.", "platform/api: activate webhook."])
    await provider.apply(plan, fetcher)
    expect(first.active).toBe(true)
    expect(first.events).toEqual(events)
    expect(JSON.stringify(other)).toBe(previous)
    const forced = await provider.plan(planInput(true))
    expect(forced.action).toBe("update")
    expect(forced.changes).toHaveLength(2)
    await provider.apply(forced, fetcher)
    expect(calls.slice(-2).every(call => call.input.secret === secret)).toBe(true)
  })

  it("reports an update when one repository exists and another needs a hook", async () => {
    const provider = await sync(host)
    await provider.apply(await provider.plan(planInput()), fetcher)
    stores.get(host)!.store.webhooks.pop()
    stores.get(host)!.store.webhooks[0]!.active = false
    const plan = await provider.plan(planInput())
    expect(plan.action).toBe("update")
    await provider.apply(plan, fetcher)
    expect(stores.get(host)!.store.webhooks).toHaveLength(2)
  })

  it("fails on duplicate target URLs without changing hooks", async () => {
    const provider = await sync(host)
    await provider.apply(await provider.plan(planInput()), fetcher)
    const factory = stores.get(host)!
    const hook = factory.store.webhooks[0]!
    await factory.create().webhooks.create(hook.ref.target, { url, events })
    const previous = JSON.stringify(factory.store.webhooks)
    await expect(provider.plan(planInput())).rejects.toThrow("duplicate hooks")
    expect(JSON.stringify(factory.store.webhooks)).toBe(previous)
  })

  it.each([
    ["token", { ...options, token: undefined }, `${host.toUpperCase()}_TOKEN`],
    ["webhookSecret", { ...options, webhookSecret: undefined }, `${host.toUpperCase()}_WEBHOOK_SECRET`],
  ])("names the missing %s option and env variable", async (field, input, env) => {
    await expect(sync(host, input)).rejects.toThrow(`${field} or ${env}`)
  })

  it.each([[], ["api"], ["owner//api"], [" owner/api"], ["owner/../api"], ["https://host/repo"]].map(repositories => [repositories]))("rejects invalid repositories %j", async repositories => {
    await expect(sync(host, { ...options, sync: { repositories } })).rejects.toThrow("sync.repositories")
  })

  it("uses callbacks and Server Env, with explicit options first", async () => {
    vi.stubEnv(`${host.toUpperCase()}_TOKEN`, "env-token")
    vi.stubEnv(`${host.toUpperCase()}_WEBHOOK_SECRET`, "env-secret")
    vi.stubEnv(`${host.toUpperCase()}_BASE_URL`, "https://custom.example.com")
    const provider = await sync(host, { ...options, token: () => ({ unseal: () => token }), webhookSecret: undefined })
    await provider.apply(await provider.plan(planInput()), fetcher)
    expect(connections[0]!.options).toMatchObject({ baseUrl: "https://custom.example.com", auth: { token } })
    expect(calls[0]!.input.secret).toBe("env-secret")
  })

  it("uses a stable resource key with no credentials", async () => {
    const first = await sync(host)
    const second = await sync(host, { ...options, token: "different", webhookSecret: "different", sync: { repositories: [...options.sync!.repositories].reverse() } })
    expect(first.resourceKey).toBe(second.resourceKey)
    expect(String(first.resourceKey)).not.toContain(token)
    expect(String(first.resourceKey)).not.toContain(secret)
  })

  it("fails clearly if hooks cannot be managed", async () => {
    unsupported = true
    const provider = await sync(host)
    await expect(provider.plan(planInput())).rejects.toThrow("cannot manage hooks")
  })

  it("redacts failed request messages and serialized errors", async () => {
    const provider = await sync(host)
    const plan = await provider.plan(planInput())
    const result = await provider.apply(plan, fetcher)
    failedRequest = new Error(`Request failed: ${token} ${secret}`)
    const error = await provider.plan(planInput()).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    const serialized = error instanceof Error ? JSON.stringify({ plan, result, error: { ...error, message: error.message, stack: error.stack, cause: error.cause } }) : String(error)
    expect(serialized).toContain("[redacted]")
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(secret)
  })

  it("lists a Channel without sync.repositories in the CLI plan", async () => {
    const provider = await sync(host, {})
    const stdout = output(); const stderr = output()
    const status = await runAgentChannelSyncCli([
      "--stage", "test", "--channel", host, "--url", "https://app.example.com", "--apply", "--confirm-origin", "https://app.example.com",
    ], { cwd: "/repo", rootDir: "/repo", env: {}, stdout, stderr }, {
      fetch: async () => new Response(null, { status: 204, headers: { "x-vitehub-channel-provider": host } }),
      loadTargets: async () => [{ agent: "reviewer", channel: host, mode: "webhook", provider: host, registration: { id: "code" }, sync: provider }],
    })
    expect(stderr.text()).toBe("")
    expect(status).toBe(0)
    expect(stdout.text()).toContain(`reviewer/${host} (${host}): none`)
    expect(stdout.text()).toContain("Current URL: <none>")
    expect(stdout.text()).toContain("Set sync.repositories to manage Code Host webhooks.")
    expect(connections).toEqual([])
  })

  it("passes CLI URL checks for create, no change, and force update", async () => {
    const provider = await sync(host)
    for (const args of [[], [], ["--force"]]) {
      const stdout = output(); const stderr = output()
      const status = await runAgentChannelSyncCli([
        "--stage", "test", "--channel", host, "--url", "https://app.example.com", "--apply", "--confirm-origin", "https://app.example.com", "--json", ...args,
      ], { cwd: "/repo", rootDir: "/repo", env: {}, stdout, stderr }, {
        fetch: async (_input, init) => {
          expect(init?.method).toBe("HEAD")
          return new Response(null, { status: 204, headers: { "x-vitehub-channel-provider": host } })
        },
        loadTargets: async () => [{ agent: "reviewer", channel: host, mode: "webhook", provider: host, registration: { id: "code" }, sync: provider }],
      })
      expect(stderr.text()).toBe("")
      expect(status).toBe(0)
      expect(stdout.text()).toContain('"url":"https://app.example.com/api/_vitehub/agents/reviewer/webhooks/code"')
      expect(stdout.text()).not.toContain(token)
      expect(stdout.text()).not.toContain(secret)
    }
  })
})

it("keeps nested GitLab groups in the repository reference", async () => {
  const provider = await sync("gitlab", { ...options, sync: { repositories: ["platform/team/api"] } })
  await provider.apply(await provider.plan(planInput()), fetcher)
  expect(stores.get("gitlab")!.store.webhooks[0]!.ref.target).toMatchObject({ owner: "platform/team", name: "api" })
  await expect(sync("forgejo", { ...options, sync: { repositories: ["platform/team/api"] } })).rejects.toThrow("sync.repositories")
})

const featureCases: Array<[ForgejoChannelOptions, EventKind[]]> = [
  [{ pullRequest: true }, ["comment"]],
  [{ activity: true }, ["state_change"]],
  [{ pullRequest: { reconcile: { events: [], triggers: [{ events: ["review"] }] } } }, ["comment", "review"]],
  [{ pullRequest: { reconcile: { comments: { events: ["review_comment"] } } } }, ["comment", "review_comment", "state_change"]],
  [{ pullRequest: { reconcile: true } }, ["comment", "state_change"]],
]
it.each(featureCases)("derives subscriptions from enabled features %j", async (features, expected) => {
  const provider = await sync("forgejo", { ...options, ...features, pullRequest: features.pullRequest })
  await provider.apply(await provider.plan(planInput()), fetcher)
  expect(stores.get("forgejo")!.store.webhooks[0]!.events).toEqual(expected)
})

it.each(hosts)("round trips %s subscriptions through the real client and CLI transport", async host => {
  realRequests = true
  let stored: Record<string, unknown> | undefined
  const requests: Request[] = []
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    requests.push(request.clone())
    if (request.method === "GET") return Response.json(stored ? [stored] : [])
    // SAFETY: The client sends a JSON webhook object to this fixture transport.
    const body = await request.json() as Record<string, unknown>
    // GitLab enables push events by default when the create request does not set the flag.
    const defaults = host === "gitlab" && request.method === "POST" ? { push_events: true } : {}
    stored = { id: 1, ...defaults, ...stored, ...body }
    return Response.json(stored)
  }
  const provider = await sync(host, { ...options, sync: { repositories: ["platform/api"] } })
  const input = { desiredUrl: url, fetch: transport, force: false }
  await provider.apply(await provider.plan(input), transport)
  expect((await provider.plan(input)).action).toBe("none")
  const create = requests.find(request => request.method === "POST")!
  expect(create.url).toContain(host === "gitlab" ? "/api/v4/projects/platform%2Fapi/hooks" : "/api/v1/repos/platform/api/hooks")
  const body: unknown = await create.json()
  expect(body).toMatchObject(host === "gitlab" ? { token: secret, note_events: true, merge_requests_events: true, push_events: false } : {
    active: true, events: expect.arrayContaining(translated(host, events)), config: { url, content_type: "json", secret },
  })
  if (host === "gitlab") stored = { ...stored, push_events: true }
  else stored = { ...stored, events: ["push"] }
  const update = await provider.plan(input)
  expect(update.action).toBe("update")
  await provider.apply(update, transport)
  expect((await provider.plan(input)).action).toBe("none")
  if (host === "gitlab") {
    const put = requests.find(request => request.method === "PUT")!
    expect(await put.json()).toMatchObject({ push_events: false, note_events: true, merge_requests_events: true, token: secret })
  }
})

it.each(hosts)("redacts %s HTTP error bodies from the real client", async host => {
  realRequests = true
  const provider = await sync(host)
  const transport: typeof fetch = async () => Response.json({ message: `${token} and ${secret} are invalid` }, { status: 401 })
  const error = await provider.plan({ desiredUrl: url, fetch: transport, force: false }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error && error.message).toContain("HTTP 401")
  const serialized = error instanceof Error ? JSON.stringify({ ...error, message: error.message, cause: error.cause }) : String(error)
  expect(serialized).not.toContain(token)
  expect(serialized).not.toContain(secret)
})

it("rejects an apply result whose active state did not change", async () => {
  const provider = await sync("gitlab")
  await provider.apply(await provider.plan(planInput()), fetcher)
  const factory = stores.get("gitlab")!
  factory.store.webhooks[0]!.active = false
  const update = factory.create().webhooks.update
  factory.create().webhooks.update = async (ref, input) => {
    const hook = await update(ref, input)
    hook.active = false
    return hook
  }
  await expect(provider.apply(await provider.plan(planInput()), fetcher)).rejects.toThrow("desired webhook events and active state")
})
