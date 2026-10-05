import { test } from 'vitest'
import assert from 'node:assert/strict'
import { PullRequestInbox } from '../src/server/github-inbox.ts'
import { snapshotPullRequest, claimStopReason, createClaimStopCheck } from '../src/server/github-inbox.ts'

async function fixture() {
  const inbox = new PullRequestInbox({path: ':memory:', repositories: ['vite-hub/vitehub']})
  await inbox.seed('vite-hub/vitehub', { number: 42, state: 'open', user: { login: 'onmax' }, head: { sha: 'new', ref: 'feature', repo: { full_name: 'vite-hub/vitehub' } }, base: { sha: 'base', ref: 'main' }, headRefOid: 'stale', headRefName: 'stale-branch', title: 'Test', html_url: 'https://github.com/vite-hub/vitehub/pull/42', updated_at: '2026-09-13T00:00:00Z' })
  return inbox
}

test('REST webhook head overrides persisted stale GraphQL aliases for checkout', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    assert.ok(claim)
    const pr = snapshotPullRequest(claim.snapshot)
    assert.equal(pr.headRefOid, 'new')
    assert.equal(pr.headRefName, 'feature')
    assert.equal(pr.state, 'OPEN')
    assert.equal(pr.url, 'https://github.com/vite-hub/vitehub/pull/42')
  } finally { await inbox.close() }
})

test('same-head feedback leaves active pass running; new head cancels without network polling', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    const current = structuredClone(claim.snapshot)
    current.generation++
    assert.equal(claimStopReason(claim, current), undefined)
    current.pr!.head!.sha = 'newer'
    assert.equal(claimStopReason(claim, current), 'Pull request head changed.')
  } finally { await inbox.close() }
})

test('terminal webhook and lost lease cancel active pass', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    const current = structuredClone(claim.snapshot)
    current.status = 'terminal'
    assert.equal(claimStopReason(claim, current), 'Pull request is no longer open.')
    current.lease = 'another-owner'
    assert.equal(claimStopReason(claim, current), 'Pull request lease lost.')
  } finally { await inbox.close() }
})

test('new generation remains claimable after old pass parks, without second completion gate', async () => {
  const inbox = await fixture()
  try {
    const old = (await inbox.claim(1))[0]!
    await inbox.ingest('comment', 'issue_comment', { repository: { full_name: 'vite-hub/vitehub' }, issue: { number: 42, pull_request: {} }, action: 'created', comment: { id: 1, body: 'Please fix test', user: { login: 'onmax', type: 'User' } } })
    await inbox.finish(old, { text: 'Waiting for checks' })
    const next = (await inbox.claim(1))[0]!
    assert.ok(next)
    assert.ok(next.generation > old.generation)
    assert.equal(next.snapshot.comments['1']!.body, 'Please fix test')
  } finally { await inbox.close() }
})

test('own repair head proven from provider Git survives cleanup; external head still cancels', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!
  const current = structuredClone(claim.snapshot)
  let reads = 0, cleanup = false
  const check = createClaimStopCheck(claim, async () => current, async () => { reads++; if (cleanup) throw new Error('provider directory removed'); return 'repair' })
  assert.equal(await check(), undefined)
  assert.equal(reads, 0)
  current.pr!.head!.sha = 'repair'
  assert.equal(await check(), undefined)
  assert.equal(reads, 1)
  cleanup = true
  assert.equal(await check(), undefined)
  assert.equal(reads, 1)
  current.pr!.head!.sha = 'external'
  assert.equal(await check(), 'Pull request head changed.')
  assert.equal(reads, 2)
 } finally { await inbox.close() }
})

test('head change without a provider HEAD match cancels regardless of bot identity', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'external'; current.pr!.user = { login: 'vitehub-bot' }
  for (const providerHead of [undefined, 'different']) {
   const check = createClaimStopCheck(claim, async () => current, async () => providerHead)
   assert.equal(await check(), 'Pull request head changed.')
  }
  const failed = createClaimStopCheck(claim, async () => current, async () => { throw new Error('git failed') })
  assert.equal(await failed(), 'Pull request head changed.')
 } finally { await inbox.close() }
})

test('closed PR and lease loss win even after a verified repair push', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'repair'
  const check = createClaimStopCheck(claim, async () => current, async () => 'repair')
  assert.equal(await check(), undefined)
  current.status = 'terminal'
  assert.equal(await check(), 'Pull request is no longer open.')
  current.status = 'working'; current.lease = 'different'
  assert.equal(await check(), 'Pull request lease lost.')
 } finally { await inbox.close() }
})

test('new remote event during provider HEAD read is rechecked before accepting proof', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'repair'
  const check = createClaimStopCheck(claim, async () => current, async () => { current.pr!.head!.sha = 'external'; return 'repair' })
  assert.equal(await check(), 'Pull request head changed.')
 } finally { await inbox.close() }
})

test('expired lease cancels before recovery changes its token', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    const current = structuredClone(claim.snapshot)
    current.leaseUntil = Date.now() - 1
    assert.equal(claimStopReason(claim, current), 'Pull request lease lost.')
  } finally { await inbox.close() }
})

test('durable claim fence rejects a released claim before an irreversible action', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    assert.equal(await inbox.isClaimCurrent(claim), true)
    await inbox.release(claim)
    assert.equal(await inbox.isClaimCurrent(claim), false)
  } finally { await inbox.close() }
})

test('stack parents are claimed before older independent work', async () => {
  let now = 1_000
  const inbox = new PullRequestInbox({ path: ':memory:', repositories: ['acme/app'], clock: () => now++ })
  try {
    const pr = (number: number, head: string, base: string) => ({ number, state: 'open', head: { sha: `${head}-sha`, ref: head }, base: { ref: base }, updated_at: '2026-10-01T00:00:00Z' })
    await inbox.seed('acme/app', pr(3, 'independent', 'main'))
    await inbox.seed('acme/app', pr(1, 'parent', 'main'))
    await inbox.seed('acme/app', pr(2, 'child', 'parent'))
    const claims = await inbox.claim(3)
    // The child waits for its parent; the parent goes first although it changed later.
    assert.deepEqual(claims.map(claim => claim.snapshot.number), [1, 3])
  } finally { await inbox.close() }
})

test('startup releases every held lease and keeps recorded waits', async () => {
  const inbox = await fixture()
  try {
    await inbox.seed('vite-hub/vitehub', { number: 43, state: 'open', head: { sha: 'other', ref: 'other' }, base: { ref: 'main' }, updated_at: '2026-09-13T00:00:00Z' })
    const [first, second] = await inbox.claim(2)
    await inbox.finish(second!, { text: 'Waiting', wait: { headSha: 'other', reason: 'checks', evidenceKey: 'key' } })
    const parked = await inbox.claim(1)
    assert.equal(parked.length, 0)
    assert.equal(await inbox.releaseLeases(), 1)
    const released = await inbox.get('vite-hub/vitehub', first!.snapshot.number)
    assert.equal(released?.lease, null)
    assert.equal(released?.status, 'ready')
    assert.equal((await inbox.get('vite-hub/vitehub', second!.snapshot.number))?.status, 'waiting')
    assert.equal(await inbox.releaseLeases(), 0)
    // The released PR is claimable at once instead of after its two-hour lease.
    assert.equal((await inbox.claim(1))[0]?.snapshot.number, first!.snapshot.number)
  } finally { await inbox.close() }
})
