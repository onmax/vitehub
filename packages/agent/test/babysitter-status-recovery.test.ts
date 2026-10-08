import { test, type TestContext } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { github } from "../src/channels.ts";
import { publishAgentActivity } from "../src/index.ts";
import { PullRequestInbox } from "../src/server/github-inbox.ts";
import type { StatusDelivery } from "../src/server/github-inbox/status-delivery.ts";
import { createBabysitterStatusRecovery } from "../src/presets/babysitter/status-recovery.ts";
const head = 'a'.repeat(40)
const repository = 'acme/app'
const pr = { number: 239, state: 'open', draft: false, title: 'Repair cache', user: { login: 'developer' }, head: { sha: head, ref: 'fix', repo: { full_name: repository } }, base: { sha: 'b'.repeat(40), ref: 'main' } }

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-status-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'inbox.sqlite')
  let now = Date.now();
  const setClock = (at: number) => { now = at; };
  const open = () => new PullRequestInbox({ path, clock: () => now, repositories: [repository], activityAuthors: ['worker[bot]'] })
  const inbox = open()
  t.onTestFinished(() => inbox.close())
  await inbox.seed(repository, pr)
  const [claim] = await inbox.claim(1)
  return { inbox, claim: claim!, open, setClock }
}

test('saving a blocked pass also persists its PR status delivery', async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.finish(claim, { text: 'Cannot commit because .git is read-only.', wait: { kind: 'external' as const, headSha: head, reason: 'Provide writable .git metadata.', evidenceKey: 'blocker' } })
  assert.equal((await inbox.get(repository, 239))?.status, 'waiting')
  const pending = await inbox.metaEntries('status-outbox:v1:')
  assert.equal(pending.length, 1, 'a saved result must not depend on a model successfully posting a comment')
  assert.equal((pending[0]![1] as { text: string }).text, 'Cannot commit because .git is read-only.')
  assert.equal((await inbox.pendingStatusDeliveries())[0]?.activity.status, 'waiting')
})

const loadRecovery = async () => ({ createBabysitterStatusRecovery })
const blocked = (text = 'Cannot commit because .git is read-only.') => ({ text, wait: { kind: 'external' as const, headSha: head, reason: 'Provide writable .git metadata.', evidenceKey: 'blocker' } })

test('status retries after restart and reconciles a comment accepted before a connection failure', async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.finish(claim, blocked())
  let posts = 0, updates = 0, loseResponse = true
  const comments: Array<{ id: number; body: string; user: { login: string } }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/user')) return Response.json({ login: 'worker[bot]' })
    if (method === 'GET' && url.includes('/comments')) return Response.json(comments)
    const body = JSON.parse(String(init?.body)).body
    if (method === 'POST') {
      posts++
      comments.push({ id: 10, body, user: { login: 'worker[bot]' } })
      if (loseResponse) { loseResponse = false; throw new Error('Connection lost after GitHub accepted the comment') }
      return Response.json(comments[0])
    }
    if (method === 'PATCH') { updates++; comments[0]!.body = body; return Response.json(comments[0]) }
    throw new Error(`Unexpected request ${method} ${url}`)
  }
  const publisher = () => {
    const channel = github({ activity: true, app: { token: 'test-token', fetch: fetcher, identity: { login: 'worker[bot]' } } })
    return (pending: Awaited<ReturnType<PullRequestInbox["pendingStatusDeliveries"]>>[number]) => publishAgentActivity({ name: 'babysitter-worker', channels: { github: channel } }, { channelId: 'github', target: { repository, issue: 239 }, activity: pending.activity })
  }
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: publisher() }).flush()
  const [saved] = await inbox.metaEntries('status-outbox:v1:')
  assert.ok(saved)
  const pendingValue = saved[1] as { attempts: number; nextAt: number }
  assert.equal(pendingValue.attempts, 1)
  assert.equal(posts, 1)
  await inbox.close()
  const restored = open()
  t.onTestFinished(() => restored.close())
  setClock(pendingValue.nextAt + 1)
  await createBabysitterStatusRecovery({ inbox: restored, revision: 'release-1', publish: publisher() }).flush()
  assert.equal(posts, 1, 'retry must find the already-created managed comment')
  assert.equal(updates, 1)
  assert.equal((await restored.metaEntries('status-outbox:v1:')).length, 0)
  assert.match(comments[0]!.body, /Cannot commit because \.git is read-only/)
})

test('finishing an old delivery cannot erase a newer result saved during publication', async t => {
  const { inbox, claim } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.finish(claim, blocked('First result'))
  const delivered: string[] = []
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => {
    delivered.push(pending.text)
    if (delivered.length === 1) {
      await inbox.wake((await inbox.get(repository, 239))!, 'new-feedback')
      const [next] = await inbox.claim(1)
      await inbox.finish(next!, blocked('New result'))
    }
  } })
  await recovery.flush()
  assert.equal((await inbox.pendingStatusDeliveries())[0]?.text, 'New result')
  await recovery.flush()
  assert.deepEqual(delivered, ['First result', 'New result'])
  assert.equal((await inbox.metaEntries('status-outbox:v1:')).length, 0)
})

test('stale claims and replaced heads do not publish an obsolete result', async t => {
  const { inbox, claim } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.release(claim)
  assert.equal(await inbox.finish(claim, blocked()), false)
  assert.equal((await inbox.metaEntries('status-outbox:v1:')).length, 0)
  const [current] = await inbox.claim(1)
  await inbox.finish(current!, blocked())
  await inbox.seed(repository, { ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } })
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: () => assert.fail('obsolete head must not be published') }).flush()
  assert.equal((await inbox.metaEntries('status-outbox:v1:')).length, 0)
})

test('a new release wakes a worker blocker once and leaves real external blockers parked', async t => {
  const { inbox, claim } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.finish(claim, blocked())
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-2' })
  await recovery.recover()
  assert.equal((await inbox.get(repository, 239))?.status, 'ready')
  const [retry] = await inbox.claim(1)
  await recovery.recordWorkerBlocker(retry!.snapshot, blocked().wait.reason)
  await inbox.finish(retry!, blocked())
  await recovery.recover()
  assert.equal((await inbox.get(repository, 239))?.status, 'waiting', 'unchanged worker failure must not loop')
  await createBabysitterStatusRecovery({ inbox, revision: 'release-3' }).recover()
  assert.equal((await inbox.get(repository, 239))?.status, 'ready')
  const [external] = await inbox.claim(1)
  await inbox.finish(external!, { text: 'Waiting for maintainer credentials.', wait: { kind: 'external', headSha: head, reason: 'Maintainer must authorize the external database account.', evidenceKey: 'credentials' } })
  await createBabysitterStatusRecovery({ inbox, revision: 'release-4' }).recover()
  assert.equal((await inbox.get(repository, 239))?.status, 'waiting')
})

test('historical results are backfilled once and worker recovery survives restart', async t => {
  const { inbox, claim, open } = await fixture(t)
  const { createBabysitterStatusRecovery } = await loadRecovery()
  await inbox.finish(claim, blocked())
  await inbox.deleteMeta('status-outbox:v1:acme/app#239')
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async () => {} })
  await recovery.recover()
  await recovery.flush()
  const [retry] = await inbox.claim(1)
  await recovery.recordWorkerBlocker(retry!.snapshot, blocked().wait.reason)
  await inbox.finish(retry!, blocked())
  await recovery.flush()
  await inbox.close()
  const restored = open()
  t.onTestFinished(() => restored.close())
  await createBabysitterStatusRecovery({ inbox: restored, revision: 'release-1', publish: async () => assert.fail('already delivered result must not be reposted') }).recover()
  assert.equal((await restored.get(repository, 239))?.status, 'waiting')
  assert.equal((await restored.metaEntries('status-outbox:v1:')).length, 0)
})

test('a repair result waits for its synchronize webhook and survives restart', async t => {
  const { inbox, claim, open } = await fixture(t)
  const repaired = 'd'.repeat(40)
  await inbox.finish(claim, { text: 'Pushed the verified repair.', wait: { kind: 'checks', headSha: repaired, reason: 'Waiting for CI.', evidenceKey: 'repair' } })
  assert.equal((await inbox.pendingStatusDeliveries())[0]?.head, repaired)
  await inbox.close()
  const restored = open()
  t.onTestFinished(() => restored.close())
  const delivered: string[] = []
  const recovery = createBabysitterStatusRecovery({ inbox: restored, revision: 'release-1', publish: async pending => { delivered.push(pending.head) } })
  await recovery.flush()
  assert.deepEqual(delivered, [])
  assert.equal((await restored.pendingStatusDeliveries()).length, 1)
  await restored.seed(repository, { ...pr, head: { ...pr.head, sha: repaired } })
  await recovery.flush()
  assert.deepEqual(delivered, [repaired])
  assert.equal((await restored.pendingStatusDeliveries()).length, 0)
})

test('a timed installer retry stays parked across releases', async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.finish(claim, { text: 'Restore frozen-lockfile dependency installation.', wait: { kind: 'external', reason: 'Restore frozen-lockfile dependency installation.', evidenceKey: 'installer', retryAt: Date.now() + 300_000 } })
  await createBabysitterStatusRecovery({ inbox, revision: 'release-2' }).recover()
  assert.equal((await inbox.get(repository, 239))?.status, 'waiting')
})


test('five deferred repair comments do not starve another PR status', async t => {
  const { inbox, claim } = await fixture(t)
  for (let index = 0; index < 5; index++) {
    let current = claim
    if (index) {
      await inbox.seed(repository, { ...pr, number: pr.number + index })
      current = (await inbox.claim(1))[0]!
    }
    await inbox.finish(current, { text: 'Repair pushed.', wait: { kind: 'checks', headSha: 'd'.repeat(40), reason: 'Waiting for synchronize.', evidenceKey: 'repair' } })
  }
  await inbox.seed(repository, { ...pr, number: 244 })
  await inbox.finish((await inbox.claim(1))[0]!, blocked())
  const delivered: number[] = []
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => { delivered.push(pending.number) } }).flush()
  assert.deepEqual(delivered, [244])
})

test('two hosts sharing an inbox claim a saved status before publishing', async t => {
  const { inbox, claim, open } = await fixture(t)
  await inbox.finish(claim, blocked())
  const other = open()
  t.onTestFinished(() => other.close())
  let release!: () => void
  let started!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  const publish = async () => { calls++; started(); await barrier }
  const first = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish }).flush()
  await began
  const second = createBabysitterStatusRecovery({ inbox: other, revision: 'release-1', publish }).flush()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([second, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Second host tried to publish the leased status.')), 100) })])
    assert.equal(calls, 1)
  } finally {
    clearTimeout(deadline)
    release()
    await Promise.all([first, second])
  }
})

test('a stalled publisher retains ownership until its aborted write settles', async t => {
  const { inbox, claim, open } = await fixture(t)
  await inbox.finish(claim, blocked())
  const other = open()
  t.onTestFinished(() => other.close())
  let release!: () => void
  let aborted!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const deadline = new Promise<void>(resolve => { aborted = resolve })
  let settled = false
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publishTimeoutMs: 20,
    publish: async (_pending, signal) => { signal.addEventListener('abort', aborted, { once: true }); await barrier } })
  const flushing = recovery.flush().then(() => { settled = true })
  try {
    await deadline
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(settled, false, 'host shutdown must wait for the actual publisher')
    assert.deepEqual(await other.claimStatusDeliveries(), [], 'timeout must not release an active external writer')
  } finally {
    release()
    await flushing
  }
  const entries = await inbox.metaEntries('status-outbox:v1:')
  assert.equal((entries[0]?.[1] as { attempts: number }).attempts, 1)
})

test('an expired delivery lease can be recovered while its old owner is fenced', async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  await inbox.finish(claim, blocked())
  const [unclaimed] = await inbox.pendingStatusDeliveries()
  assert.ok(unclaimed)
  assert.equal(await inbox.finishStatusDelivery(unclaimed, 'delivered'), false)
  assert.equal(await inbox.retryStatusDelivery(unclaimed, new Error('Unclaimed')), false)
  const [old] = await inbox.claimStatusDeliveries(1, 100)
  assert.ok(old?.lease)
  const other = open()
  t.onTestFinished(() => other.close())
  assert.deepEqual(await other.claimStatusDeliveries(), [])
  setClock(old.leaseUntil! + 1)
  const [replacement] = await other.claimStatusDeliveries()
  assert.ok(replacement?.lease)
  assert.notEqual(replacement.lease, old.lease)
  assert.equal(await inbox.finishStatusDelivery(old, 'delivered'), false)
  assert.equal(await inbox.retryStatusDelivery(old, new Error('Old owner')), false)
  assert.equal(await other.finishStatusDelivery(replacement, 'delivered'), true)
})

test('a newer result keeps the delivery lease until its publisher finishes', async t => {
  const { inbox, claim, open } = await fixture(t)
  await inbox.finish(claim, blocked('First result'))
  const [old] = await inbox.claimStatusDeliveries()
  assert.ok(old)
  await inbox.wake((await inbox.get(repository, 239))!, 'new-feedback')
  await inbox.finish((await inbox.claim(1))[0]!, blocked('New result'))
  const other = open()
  t.onTestFinished(() => other.close())
  assert.deepEqual(await other.claimStatusDeliveries(), [])
  assert.equal(await inbox.retryStatusDelivery(old, new Error('Old publication failed')), false)
  const [next] = await other.claimStatusDeliveries()
  assert.equal(next?.text, 'New result')
  assert.equal(next?.attempts, 0)
})

test('the publication deadline reaches GitHub credentials and stalled HTTP requests', async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.finish(claim, blocked())
  let credentialSignal: AbortSignal | undefined
  let requestSignal: AbortSignal | null | undefined
  const channel = github({ activity: true, app: {
    token: (_context, scope) => { credentialSignal = scope.signal; return 'deadline-token' },
    identity: { login: 'worker[bot]' },
    fetch: async (_input, init) => {
      requestSignal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(requestSignal?.reason)
        if (requestSignal?.aborted) abort()
        else requestSignal?.addEventListener('abort', abort, { once: true })
      })
    },
  } })
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publishTimeoutMs: 20,
    publish: (pending, abortSignal) => publishAgentActivity({ name: 'babysitter-worker', channels: { github: channel } }, {
      channelId: 'github', target: { repository, issue: 239 }, activity: pending.activity, abortSignal,
    }),
  }).flush()
  assert.equal(credentialSignal?.aborted, true)
  assert.equal(requestSignal?.aborted, true)
  const entries = await inbox.metaEntries('status-outbox:v1:')
  assert.equal((entries[0]?.[1] as { attempts: number }).attempts, 1)
})

for (const legacy of [false, true]) test(`saved waiting activity publishes after the invocation has completed, legacy=${legacy}`, async t => {
  const { inbox, claim } = await fixture(t)
  claim.runId = `completed-invocation-${legacy}`
  const comments: Array<{ id: number; body: string; user: { login: string } }> = []
  const channel = github({ activity: true, app: { apiBaseUrl: `https://status-${legacy}.example.test`, token: 'test-token', identity: { login: 'worker[bot]' }, fetch: async (input, init) => {
    if ((init?.method ?? 'GET') === 'GET') return Response.json(comments)
    const body = JSON.parse(String(init?.body)).body
    if (init?.method === 'POST') comments.push({ id: 10, body, user: { login: 'worker[bot]' } })
    else comments[0]!.body = body
    return Response.json(comments[0])
  } } })
  const agent = { name: 'babysitter-worker', channels: { github: channel } }
  await publishAgentActivity(agent, { channelId: 'github', target: { repository, issue: 239 }, activity: {
    runId: claim.runId!, status: 'completed', updatedAt: new Date().toISOString(), links: [], tasks: [], summary: 'Invocation completed.',
  } })
  await inbox.finish(claim, blocked())
  if (legacy) {
    const [pending] = await inbox.pendingStatusDeliveries()
    await inbox.setMeta('status-outbox:v1:acme/app#239', { ...pending!, activity: { ...pending!.activity, runId: claim.runId! } })
  }
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: (pending, abortSignal) =>
    publishAgentActivity(agent, { channelId: 'github', target: { repository, issue: 239 }, activity: pending.activity, abortSignal }) }).flush()
  assert.match(comments[0]!.body, /Cannot commit because \.git is read-only/)
})

test('a late timed-out writer cannot overwrite a newer result from another host', async t => {
  const { inbox, claim, open } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const other = open()
  t.onTestFinished(() => other.close())
  let release!: () => void
  let aborted!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const deadline = new Promise<void>(resolve => { aborted = resolve })
  let projection = ''
  const old = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publishTimeoutMs: 20, publish: async (pending, signal) => {
    signal.addEventListener('abort', aborted, { once: true })
    await barrier
    projection = pending.text
  } }).flush()
  const next = createBabysitterStatusRecovery({ inbox: other, revision: 'release-1', publish: async pending => { projection = pending.text } })
  try {
    await deadline
    await new Promise(resolve => setTimeout(resolve, 20))
    await inbox.wake((await inbox.get(repository, 239))!, 'new-feedback')
    await inbox.finish((await inbox.claim(1))[0]!, blocked('New result'))
    await next.flush()
  } finally { release(); await old }
  await next.flush()
  assert.equal(projection, 'New result')
})

test('a writer that settles after lease replacement requeues the latest saved status', async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const other = open()
  t.onTestFinished(() => other.close())
  let release!: () => void
  let started!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { started = resolve })
  let projection = ''
  const first = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => {
    started()
    await barrier
    projection = pending.text
  } }).flush()
  const next = createBabysitterStatusRecovery({ inbox: other, revision: 'release-1', publish: async pending => { projection = pending.text } })
  try {
    await began
    const entry = (await inbox.metaEntries('status-outbox:v1:'))[0]![1] as { leaseUntil: number }
    await inbox.wake((await inbox.get(repository, 239))!, 'new-feedback')
    await inbox.finish((await inbox.claim(1))[0]!, blocked('New result'))
    setClock(entry.leaseUntil + 1)
    await next.flush()
    assert.equal(projection, 'New result')
  } finally { release(); await first }
  await next.flush()
  assert.equal(projection, 'New result', 'the latest result must be corrected after an expired owner settles')
})

test('lease replacement repeats a newer write whose response is still in flight', async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const other = open()
  t.onTestFinished(() => other.close())
  let releaseOld!: () => void
  let releaseNew!: () => void
  let startedOld!: () => void
  let startedNew!: () => void
  const oldBarrier = new Promise<void>(resolve => { releaseOld = resolve })
  const newBarrier = new Promise<void>(resolve => { releaseNew = resolve })
  const oldBegan = new Promise<void>(resolve => { startedOld = resolve })
  const newBegan = new Promise<void>(resolve => { startedNew = resolve })
  let projection = ''
  const first = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => {
    startedOld(); await oldBarrier; projection = pending.text
  } }).flush()
  let delayNewResponse = true
  const next = createBabysitterStatusRecovery({ inbox: other, revision: 'release-1', publish: async pending => {
    projection = pending.text
    if (delayNewResponse) { delayNewResponse = false; startedNew(); await newBarrier }
  } })
  let second = Promise.resolve()
  try {
    await oldBegan
    const entry = (await inbox.metaEntries('status-outbox:v1:'))[0]![1] as { leaseUntil: number }
    await inbox.wake((await inbox.get(repository, 239))!, 'new-feedback')
    await inbox.finish((await inbox.claim(1))[0]!, blocked('New result'))
    setClock(entry.leaseUntil + 1)
    second = next.flush()
    await newBegan
    releaseOld()
    await first
  } finally { releaseOld(); releaseNew(); await Promise.all([first, second]) }
  await next.flush()
  assert.equal(projection, 'New result')
})

test('lease replacement corrects a late GitHub write through the real activity channel', async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const other = open()
  t.onTestFinished(() => other.close())
  const comments: Array<{ id: number; body: string; user: { login: string } }> = []
  let release!: () => void
  let started!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { started = resolve })
  let delayOldWrite = true
  const publisher = (token: string) => {
    const channel = github({ activity: true, app: { token, identity: { login: 'expiry-worker[bot]' }, fetch: async (_input, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET') return Response.json(comments)
      const body = JSON.parse(String(init?.body)).body as string
      if (method === 'POST') {
        if (token === 'old-expiry-token' && delayOldWrite) { delayOldWrite = false; started(); await barrier }
        const comment = { id: comments.length + 1, body, user: { login: 'expiry-worker[bot]' } }
        comments.push(comment)
        return Response.json(comment)
      }
      const id = Number(String(_input).split('/').at(-1))
      const comment = comments.find(value => value.id === id)!
      comment.body = body
      return Response.json(comment)
    } } })
    return (pending: StatusDelivery, abortSignal: AbortSignal) =>
      publishAgentActivity({ name: 'expiry-correction-worker', channels: { github: channel } }, {
        channelId: 'github', target: { repository, issue: 239 }, activity: pending.activity, abortSignal,
      })
  }
  const first = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: publisher('old-expiry-token') }).flush()
  const next = createBabysitterStatusRecovery({ inbox: other, revision: 'release-1', publish: publisher('new-expiry-token') })
  try {
    await began
    const entry = (await inbox.metaEntries('status-outbox:v1:'))[0]![1] as { leaseUntil: number }
    await inbox.wake((await inbox.get(repository, 239))!, 'new-feedback')
    await inbox.finish((await inbox.claim(1))[0]!, blocked('New result'))
    setClock(entry.leaseUntil + 1)
    await next.flush()
  } finally { release(); await first }
  await next.flush()
  const managed = comments.filter(comment => !comment.body.startsWith('This Agent activity was superseded'))
  assert.equal(managed.length, 1)
  assert.ok(managed[0]!.body.includes('New result'))
  assert.deepEqual(await inbox.pendingStatusDeliveries(), [])
  const restarted = createBabysitterStatusRecovery({ inbox: other, revision: 'release-1', publish: publisher('restarted-expiry-token') })
  await restarted.recover()
  await restarted.flush()
  assert.deepEqual(await inbox.pendingStatusDeliveries(), [], 'the correction acknowledgement must survive restart')
  assert.equal(comments.length, 2)
})

test('a stalled writer renews the lease inherited by a newer saved result', async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const other = open()
  t.onTestFinished(() => other.close())
  let release!: () => void
  let started!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { started = resolve })
  const flushing = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publishTimeoutMs: 20, deliveryLeaseMs: 90,
    publish: async () => { started(); await barrier } }).flush()
  try {
    await began
    const before = (await inbox.metaEntries('status-outbox:v1:'))[0]![1] as { leaseUntil: number }
    setClock(before.leaseUntil - 1)
    await inbox.wake((await inbox.get(repository, 239))!, 'new-feedback')
    await inbox.finish((await inbox.claim(1))[0]!, blocked('New result'))
    // Wait for the publisher heartbeat to renew the coalesced entry.
    let renewed = false
    for (let index = 0; index < 20; index++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      const current = (await inbox.metaEntries('status-outbox:v1:'))[0]![1] as { leaseUntil: number }
      if (current.leaseUntil > before.leaseUntil) { renewed = true; break }
    }
    assert.equal(renewed, true)
    setClock(before.leaseUntil + 1)
    assert.deepEqual(await other.claimStatusDeliveries(), [])
  } finally { release(); await flushing }
  const [next] = await other.claimStatusDeliveries()
  assert.equal(next?.text, 'New result')
  assert.equal(await inbox.renewStatusDelivery({ ...next!, lease: 'replaced' }), false)
})

test('a timed-out writer does not block unrelated publication slots', async t => {
  const { inbox, claim } = await fixture(t)
  for (let index = 0; index < 6; index++) {
    if (index) await inbox.seed(repository, { ...pr, number: pr.number + index })
    await inbox.finish(index ? (await inbox.claim(1))[0]! : claim, blocked())
  }
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const delivered = new Set<number>()
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publishTimeoutMs: 20, publish: async pending => {
    if (pending.number === pr.number) await barrier
    delivered.add(pending.number)
  } })
  const first = recovery.flush()
  let second: Promise<void> | undefined
  try {
    for (let index = 0; index < 50 && delivered.size < 4; index++) await new Promise(resolve => setTimeout(resolve, 10))
    second = recovery.flush()
    for (let index = 0; index < 50 && !delivered.has(244); index++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(delivered.has(244), true, 'remaining slots must serve unrelated PRs')
  } finally { release(); await Promise.all([first, second]) }
})

test('an older release acknowledgement cannot suppress recovery of a silently dropped blocker', async t => {
  const { inbox, claim } = await fixture(t)
  const result = { text: 'Waiting for maintainer credentials.', wait: { kind: 'external' as const, headSha: head, reason: 'Provide maintainer credentials.', evidenceKey: 'credentials' } }
  await inbox.finish(claim, result)
  const [pending] = await inbox.claimStatusDeliveries()
  await inbox.finishStatusDelivery(pending!, 'delivered')
  // Older releases acknowledged the invocation run's rejected waiting update.
  await inbox.setMeta('status-sent:v1:acme/app#239', { contentKey: pending!.contentKey, head, deliveredAt: Date.now() })
  const published: string[] = []
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async delivery => { published.push(delivery.text) } })
  await recovery.recover()
  await recovery.flush()
  assert.deepEqual(published, [result.text])
})

test('same-head feedback supersedes an older saved waiting activity', async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.finish(claim, { text: 'Waiting for credentials.', wait: { kind: 'external', headSha: head, reason: 'Provide credentials.', evidenceKey: 'credentials' } })
  const [pending] = await inbox.pendingStatusDeliveries()
  await inbox.ingest('new-review', 'pull_request_review', { repository: { full_name: repository }, action: 'submitted', pull_request: pr,
    review: { id: 42, body: 'Repair this new finding.', user: { login: 'reviewer' }, state: 'COMMENTED', commit_id: head } })
  const current = await inbox.get(repository, pr.number)
  assert.equal(current?.pr?.head?.sha, head)
  assert.ok(current!.generation > pending!.generation)
  const published: string[] = []
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async delivery => { published.push(delivery.text) } }).flush()
  assert.equal(published.length, 0)
  assert.deepEqual(await inbox.metaEntries('status-outbox:v1:'), [])
  const restarted = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async delivery => { published.push(delivery.text) } })
  await restarted.recover()
  await restarted.flush()
  assert.deepEqual(published, [], 'backfill must not regenerate a superseded result')
})

test('feedback after the worker repair head arrives supersedes its waiting status', async t => {
  const { inbox, claim } = await fixture(t)
  const repaired = 'd'.repeat(40)
  await inbox.finish(claim, { text: 'Repair pushed.', wait: { kind: 'checks', headSha: repaired, reason: 'Waiting for CI.', evidenceKey: 'repair' } })
  const updated = { ...pr, head: { ...pr.head, sha: repaired } }
  await inbox.seed(repository, updated)
  await inbox.ingest('repair-review', 'pull_request_review', { repository: { full_name: repository }, action: 'submitted', pull_request: updated,
    review: { id: 42, body: 'Repair another finding.', user: { login: 'reviewer' }, state: 'COMMENTED', commit_id: repaired } })
  const published: string[] = []
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async delivery => { published.push(delivery.text) } }).flush()
  assert.deepEqual(published, [])
})

test('a confirmed terminal result survives the PR closure webhook', async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.finish(claim, { text: 'Merged the verified repair.', terminal: true })
  await inbox.seed(repository, { ...pr, state: 'closed' })
  const published: string[] = []
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async delivery => { published.push(delivery.text) } }).flush()
  assert.deepEqual(published, ['Merged the verified repair.'])
})

test('a writer that settles after lease replacement requeues a newer saved retry status', async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const other = open()
  t.onTestFinished(() => other.close())
  let release!: () => void
  let started!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { started = resolve })
  let projection = ''
  const first = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => {
    started()
    await barrier
    projection = pending.text
  } }).flush()
  const next = createBabysitterStatusRecovery({ inbox: other, revision: 'release-1', publish: async pending => { projection = pending.text } })
  try {
    await began
    const entry = (await inbox.metaEntries('status-outbox:v1:'))[0]![1] as { leaseUntil: number }
    await inbox.wake((await inbox.get(repository, 239))!, 'new-feedback')
    await inbox.finish((await inbox.claim(1))[0]!, { text: 'New result', retry: true })
    setClock(entry.leaseUntil + 1)
    await next.flush()
    assert.equal(projection, 'New result')
  } finally { release(); await first }
  await next.flush()
  assert.equal(projection, 'New result', 'the latest result must be corrected after an expired owner settles')
})

test('superseded retry results never publish under the newer generation', async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.ingest('new-feedback', 'issue_comment', { repository: { full_name: repository }, action: 'created',
    issue: { number: pr.number, pull_request: {} }, comment: { id: 89, body: 'New repair requirements', user: { login: 'reviewer' } } })
  await inbox.finish(claim, { text: 'Old failure', retry: true })
  assert.equal((await inbox.get(repository, pr.number))?.status, 'ready')
  const published: string[] = []
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => { published.push(pending.text) } }).flush()
  assert.deepEqual(published, [])
  assert.deepEqual(await inbox.pendingStatusDeliveries(), [])
})

test('acknowledging an unchanged wait preserves its pending publication', async t => {
  const { inbox, claim } = await fixture(t)
  const published: string[] = []
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => { published.push(pending.text) } })
  await recovery.recover()
  await inbox.finish(claim, { text: 'Waiting for remaining checks', wait: { kind: 'checks', headSha: head, reason: 'One check remains pending', evidenceKey: 'checks' } })
  await inbox.ingest('partial-check', 'check_run', { repository: { full_name: repository }, action: 'completed',
    check_run: { id: 1, name: 'finished', head_sha: head, status: 'completed', conclusion: 'success', pull_requests: [{ number: pr.number }] } })
  const current = (await inbox.get(repository, pr.number))!
  assert.ok(current.generation > current.handled)
  assert.equal(await inbox.acknowledgeWait(current), true)
  await recovery.flush()
  assert.deepEqual(published, ['Waiting for remaining checks'])
})

test('a writer that settles after lease replacement does not relabel a retry result after newer feedback', async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const other = open()
  t.onTestFinished(() => other.close())
  let release!: () => void
  let started!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { started = resolve })
  let projection = ''
  const first = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => {
    started()
    await barrier
    projection = pending.text
  } }).flush()
  const next = createBabysitterStatusRecovery({ inbox: other, revision: 'release-1', publish: async pending => { projection = pending.text } })
  try {
    await began
    const entry = (await inbox.metaEntries('status-outbox:v1:'))[0]![1] as { leaseUntil: number }
    await inbox.wake((await inbox.get(repository, 239))!, 'new-feedback')
    await inbox.finish((await inbox.claim(1))[0]!, { text: 'New result', retry: true })
    setClock(entry.leaseUntil + 1)
    await next.flush()
    assert.equal(projection, 'New result')
    await inbox.ingest('later-feedback', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: pr.number, pull_request: {} }, comment: { id: 90, body: 'New requirements after the retry result', user: { login: 'reviewer' } } })
  } finally { release(); await first }
  await next.flush()
  assert.deepEqual(await inbox.pendingStatusDeliveries(), [], 'a result from an earlier generation must not become current feedback')
  assert.equal(projection, 'New pull request evidence is queued.', 'the older writer must not remain the visible projection')
  const current = (await inbox.get(repository, pr.number))!
  assert.ok(current.generation > current.handled)
  assert.equal(current.lastResult, 'New result', 'projection recovery must preserve the actual saved result')
})

for (const change of ['closed', 'feedback', 'feedback-with-lost-response'] as const) test(`corrects a status writer superseded by ${change} while publication is in flight`, async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.finish(claim, blocked('Waiting for old checks'))
  let projection = ''
  let writes = 0
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => {
    if (writes++ === 0) {
      if (change === 'closed') await inbox.ingest('closed-during-write', 'pull_request', { repository: { full_name: repository }, action: 'closed', pull_request: { ...pr, state: 'closed' } })
      else await inbox.ingest('feedback-during-write', 'issue_comment', { repository: { full_name: repository }, action: 'created', issue: { number: pr.number, pull_request: {} }, comment: { id: 91, body: 'Changed requirements', user: { login: 'reviewer' } } })
    }
    projection = pending.text
    if (change === 'feedback-with-lost-response' && writes === 1) throw new Error('Response lost after the old write')
  } })
  await recovery.flush()
  await recovery.flush()
  assert.equal(projection, change === 'closed' ? 'Pull request closed.' : 'New pull request evidence is queued.')
  const current = (await inbox.get(repository, pr.number))!
  assert.equal(current.lastResult, 'Waiting for old checks')
  if (change !== 'closed') assert.ok(current.generation > current.handled, 'new feedback must remain available to a worker')
})

for (const repaired of [false, true]) test(`does not relabel a superseded pinned wait, repaired=${repaired}`, async t => {
  const { inbox, claim } = await fixture(t)
  const resultHead = repaired ? 'd'.repeat(40) : head
  if (repaired) await inbox.seed(repository, { ...pr, head: { ...pr.head, sha: resultHead } })
  await inbox.ingest('feedback-before-wait', 'issue_comment', { repository: { full_name: repository }, action: 'created',
    issue: { number: pr.number, pull_request: {} }, comment: { id: 92, body: 'New repair requirements', user: { login: 'reviewer' } } })
  await inbox.finish(claim, { text: 'Earlier pinned wait', wait: { kind: 'checks', headSha: resultHead, reason: 'Waiting for checks', evidenceKey: 'old-checks' } })
  const published: string[] = []
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => { published.push(pending.text) } }).flush()
  assert.deepEqual(published, [])
  assert.deepEqual(await inbox.pendingStatusDeliveries(), [])
  const current = (await inbox.get(repository, pr.number))!
  assert.ok(current.generation > current.handled)
})

for (const priorFeedback of [false, true]) test(`publishes a pinned repair when its synchronize webhook precedes completion, priorFeedback=${priorFeedback}`, async t => {
  const fixtureResult = await fixture(t)
  const { inbox } = fixtureResult
  let claim = fixtureResult.claim
  if (priorFeedback) {
    await inbox.finish(claim, { text: 'Initial retry', retry: true })
    await inbox.ingest('claimed-feedback', 'issue_comment', { repository: { full_name: repository }, action: 'created',
      issue: { number: pr.number, pull_request: {} }, comment: { id: 93, body: 'Requirements already in this claim', user: { login: 'reviewer' } } })
    claim = (await inbox.claim(1))[0]!
  }
  const repaired = 'd'.repeat(40)
  await inbox.ingest('own-repair', 'pull_request', { repository: { full_name: repository }, action: 'synchronize', pull_request: { ...pr, head: { ...pr.head, sha: repaired } } })
  await inbox.finish(claim, { text: 'Own repair pushed', wait: { kind: 'checks', headSha: repaired, reason: 'Waiting for repair checks', evidenceKey: 'repair-checks' } })
  const published: string[] = []
  await createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => { published.push(pending.text) } }).flush()
  assert.deepEqual(published, ['Own repair pushed'])
})

test('defers projection correction to an active repair when publication is in flight', async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  let next: typeof claim | undefined
  const published: string[] = []
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async pending => {
    published.push(pending.text)
    if (published.length === 1) {
      await inbox.wake((await inbox.get(repository, pr.number))!, 'new-feedback')
      ;[next] = await inbox.claim(1)
    }
  } })
  await recovery.flush()
  assert.ok(next)
  const correction = (await inbox.metaEntries('status-outbox:v1:'))[0]?.[1] as StatusDelivery | undefined
  assert.equal(correction?.text, 'New pull request evidence is queued.')
  assert.deepEqual(await inbox.claimStatusDeliveries(), [], 'a saved projection cannot supersede an active repair')
  await recovery.flush()
  assert.deepEqual(published, ['Old result'])
  await inbox.finish(next, blocked('New result'))
  await recovery.flush()
  assert.deepEqual(published, ['Old result', 'New result'])
})

test('persists correction atomically when publication is in flight during closure', async t => {
  const { inbox, claim, open } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const [pending] = await inbox.claimStatusDeliveries()
  assert.ok(pending)
  await inbox.seed(repository, { ...pr, state: 'closed' })
  assert.equal(await inbox.finishStatusDelivery(pending, 'delivered'), false)
  const restarted = open()
  t.onTestFinished(() => restarted.close())
  assert.equal((await restarted.pendingStatusDeliveries())[0]?.text, 'Pull request closed.')
  assert.equal(await restarted.meta('status-sent:v1:acme/app#239'), undefined)
})

for (const via of ['webhook', 'snapshot'] as const) test(`publishes closure after an acknowledged waiting status via ${via}`, async t => {
  const { inbox, claim, open } = await fixture(t)
  await inbox.finish(claim, blocked('Waiting for input.'))
  const published: string[] = []
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async delivery => { published.push(delivery.text) } })
  await recovery.flush()
  assert.deepEqual(await inbox.metaEntries('status-outbox:v1:'), [])
  if (via === 'webhook') await inbox.ingest('closure-after-ack', 'pull_request', { repository: { full_name: repository }, action: 'closed', pull_request: { ...pr, state: 'closed' } })
  else await inbox.seed(repository, { ...pr, state: 'closed' })
  const restored = open()
  t.onTestFinished(() => restored.close())
  await createBabysitterStatusRecovery({ inbox: restored, revision: 'release-2', publish: async delivery => { published.push(delivery.text) } }).flush()
  assert.deepEqual(published, ['Waiting for input.', 'Pull request closed.'])
  assert.equal((await restored.get(repository, pr.number))?.lastResult, 'Waiting for input.')
})

test('keeps a durable correction after acknowledgement while a replaced writer can still mutate the comment', async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const [old] = await inbox.claimStatusDeliveries()
  assert.ok(old?.leaseUntil)
  await inbox.wake((await inbox.get(repository, pr.number))!, 'new-feedback')
  await inbox.finish((await inbox.claim(1))[0]!, blocked('New result'))
  setClock(old.leaseUntil + 1)
  const [replacement] = await inbox.claimStatusDeliveries()
  assert.ok(replacement)
  await inbox.ingest('closed-with-old-writer', 'pull_request', { repository: { full_name: repository }, action: 'closed', pull_request: { ...pr, state: 'closed' } })
  assert.equal(await inbox.finishStatusDelivery(replacement, 'delivered'), false)
  let projection = ''
  const restored = open()
  t.onTestFinished(() => restored.close())
  const recovery = createBabysitterStatusRecovery({ inbox: restored, revision: 'release-2', publish: async delivery => { projection = delivery.text } })
  await recovery.flush()
  assert.equal(projection, 'Pull request closed.')
  assert.equal((await restored.metaEntries('status-outbox:v1:')).length, 1, 'a correction cannot be forgotten while the old HTTP write can still land')
  // The replaced write reaches GitHub after the correction, but its response
  // never reaches the host. Recovery must not depend on that response.
  projection = old.text
  setClock(old.leaseUntil + 60_002)
  await recovery.flush()
  assert.equal(projection, 'Pull request closed.', 'durable replay repairs a late write without the old host settling it')
  assert.equal((await restored.metaEntries('status-outbox:v1:')).length, 1)
  await inbox.reconcileSettledStatusWriter(old)
  await recovery.flush()
  assert.deepEqual(await restored.metaEntries('status-outbox:v1:'), [])
})

for (const legacy of [false, true]) test(`retains recovery for a late orphaned status write beyond its deadline, legacy=${legacy}`, async t => {
  const { inbox, claim, open, setClock } = await fixture(t)
  await inbox.finish(claim, blocked('Old result'))
  const [orphan] = await inbox.claimStatusDeliveries()
  assert.ok(orphan?.leaseUntil)
  if (legacy) await inbox.setMeta('status-writers:v1:acme/app#239', [orphan.lease])
  await inbox.ingest('closed-after-crash', 'pull_request', { repository: { full_name: repository }, action: 'closed', pull_request: { ...pr, state: 'closed' } })
  setClock(orphan.leaseUntil + 1)
  await inbox.close()
  const restored = open()
  t.onTestFinished(() => restored.close())
  let projection = orphan.text
  const recovery = createBabysitterStatusRecovery({ inbox: restored, revision: 'release-2', publish: async delivery => { projection = delivery.text } })
  await recovery.flush()
  assert.equal(projection, 'Pull request closed.')
  setClock(orphan.leaseUntil + 60 * 60_000)
  await recovery.flush()
  // Local elapsed time cannot fence an already accepted external request.
  projection = orphan.text
  setClock(orphan.leaseUntil + 2 * 60 * 60_000)
  await recovery.flush()
  assert.equal(projection, 'Pull request closed.', 'the old HTTP write must remain recoverable after its retirement deadline')
  assert.equal((await restored.metaEntries('status-outbox:v1:')).length, 1)
  await restored.reconcileSettledStatusWriter(orphan)
  await recovery.flush()
  assert.deepEqual(await restored.metaEntries('status-outbox:v1:'), [])
  assert.deepEqual(await restored.metaEntries('status-writers:v1:'), [])
})

test('reopening a closed PR replaces its acknowledged status without an available worker', async t => {
  const { inbox, claim } = await fixture(t)
  await inbox.finish(claim, blocked())
  await inbox.ingest('closed-before-reopen', 'pull_request', { repository: { full_name: repository }, action: 'closed', pull_request: { ...pr, state: 'closed' } })
  let projection = ''
  const recovery = createBabysitterStatusRecovery({ inbox, revision: 'release-1', publish: async delivery => { projection = delivery.text } })
  await recovery.flush()
  assert.equal(projection, 'Pull request closed.')
  await inbox.ingest('reopened-without-worker', 'pull_request', { repository: { full_name: repository }, action: 'reopened', pull_request: pr })
  assert.equal((await inbox.get(repository, 239))?.status, 'ready')
  await recovery.flush()
  assert.equal(projection, 'New pull request evidence is queued.')
})

test('a status writer heartbeat preserves its marker beyond the original retirement deadline', async t => {
  const { inbox, claim, setClock } = await fixture(t)
  await inbox.finish(claim, blocked())
  const [writer] = await inbox.claimStatusDeliveries(1, 60_000)
  assert.ok(writer?.leaseUntil)
  const originalLeaseUntil = writer.leaseUntil
  for (let minute = 1; minute < 20; minute++) {
    setClock(writer.leaseUntil + (minute - 1) * 60_000 - 1)
    assert.equal(await inbox.renewStatusDelivery(writer, 60_000), true)
  }
  const stored = await inbox.meta('status-writers:v1:acme/app#239')
  assert.ok(Array.isArray(stored))
  assert.ok(stored.some(entry => entry.lease === writer.lease && entry.expiresAt > originalLeaseUntil + 20 * 60_000), 'live renewal must extend durable writer retirement')
  assert.equal(await inbox.finishStatusDelivery(writer, 'delivered'), true)
  assert.deepEqual(await inbox.metaEntries('status-writers:v1:'), [])
})
