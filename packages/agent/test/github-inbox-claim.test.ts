import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PullRequestInbox } from '../src/server/github-inbox.ts'
import { snapshotPullRequest, claimStopReason, createClaimStopCheck } from '../src/server/github-inbox.ts'

async function fixture(clock?: () => number) {
  const inbox = new PullRequestInbox({path: ':memory:', repositories: ['vite-hub/vitehub'], clock})
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

test('an expired owner cannot park a published head before lease recovery changes its token', async () => {
  let now = Date.now()
  const inbox = await fixture(() => now)
  try {
    const claim = (await inbox.claim(1))[0]!
    now = claim.snapshot.leaseUntil
    const finished = await inbox.finish(claim, { text: 'Repair pushed.', wait: { kind: 'checks', headSha: 'published', reason: 'Waiting for CI.', evidenceKey: 'push-receipt' } })
    assert.equal(finished, false)
    const current = await inbox.get('vite-hub/vitehub', 42)
    assert.equal(current?.lease, claim.token)
    assert.equal(current?.status, 'working')
    assert.equal(current?.lastResult, undefined)
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

test('a verified repair head rejects rollback even if the provider also rolls back', async () => {
 const inbox = await fixture()
 try {
  const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
  current.pr!.head!.sha = 'repair'
  const check = createClaimStopCheck(claim, async () => current, async () => current.pr!.head!.sha)
  assert.equal(await check(), undefined)
  current.pr!.head!.sha = claim.snapshot.pr!.head!.sha
  assert.equal(await check(), 'Pull request head changed.')
 } finally { await inbox.close() }
})


test('each successive worker repair head is verified while unrelated heads still cancel', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!, current = structuredClone(claim.snapshot)
    let providerHead = 'repair-first', reads = 0
    const check = createClaimStopCheck(claim, async () => current, async () => { reads++; return providerHead })
    current.pr!.head!.sha = providerHead
    assert.equal(await check(), undefined)
    assert.equal(reads, 1)
    providerHead = 'repair-second'; current.pr!.head!.sha = providerHead
    assert.equal(await check(), undefined)
    assert.equal(reads, 2)
    assert.equal(await check(), undefined)
    assert.equal(reads, 2, 'an already proven head survives cleanup without repeated Git reads')
    current.pr!.head!.sha = 'external'
    assert.equal(await check(), 'Pull request head changed.')
    assert.equal(reads, 3)
  } finally { await inbox.close() }
})


test('an original-head source rollback cannot park a verified repair head', async () => {
  const inbox = await fixture()
  try {
    const claim = (await inbox.claim(1))[0]!
    await inbox.ingest('repair-push', 'push', { repository: { full_name: 'vite-hub/vitehub' }, ref: 'refs/heads/feature', after: 'repair' })
    await inbox.ingest('rollback-push', 'push', { repository: { full_name: 'vite-hub/vitehub' }, ref: 'refs/heads/feature', after: 'new' })
    const finished = await inbox.finish(claim, { text: 'Repair pushed.', wait: { kind: 'checks', headSha: 'repair', reason: 'Waiting for CI.', evidenceKey: 'push-receipt' }, progress: { kind: 'verified', evidence: 'push:repair' }, verifiedPushHeads: ['repair'] })
    assert.equal(finished, false)
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.status, 'ready')
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.wait, undefined)
  } finally { await inbox.close() }
})


test('prospective publication CI association survives opening a new inbox process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prospective-publication-'))
  const options = { path: join(root, 'inbox.sqlite'), repositories: ['vite-hub/vitehub'] }
  let inbox = new PullRequestInbox(options)
  const head = 'b'.repeat(40)
  try {
    await inbox.seed('vite-hub/vitehub', { number: 42, state: 'open', head: { sha: 'a'.repeat(40), ref: 'feature' }, base: { ref: 'main' } })
    const claim = (await inbox.claim(1))[0]!
    await assert.rejects(inbox.registerProspectivePush(claim, 'unvalidated'), /exact publication/)
    assert.equal(await inbox.registerProspectivePush(claim, head), true)
    await inbox.close()
    inbox = new PullRequestInbox(options)
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.prospectivePush?.token, claim.token)
    await inbox.ingest('ci-before-source-push', 'status', { repository: { full_name: 'vite-hub/vitehub' }, sha: head, context: 'test', state: 'failure' })
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.statuses.test?.state, 'failure')
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.sourcePushHead, undefined, 'candidate association is not a verified publication')
    assert.equal(await inbox.release(claim), true)
    assert.equal((await inbox.get('vite-hub/vitehub', 42))?.prospectivePush, undefined)
  } finally { await inbox.close(); await rm(root, { recursive: true, force: true }) }
})

for (const change of ['lease expired', 'external head', 'claim replaced'] as const) {
  test(`prospective publication association is fenced after ${change}`, async () => {
    let now = Date.now()
    const inbox = await fixture(() => now)
    const head = 'b'.repeat(40)
    try {
      const claim = (await inbox.claim(1))[0]!
      assert.equal(await inbox.registerProspectivePush(claim, head), true)
      if (change === 'lease expired') now = claim.snapshot.leaseUntil + 1
      else if (change === 'external head') await inbox.ingest('external-synchronize', 'pull_request', {
        repository: { full_name: 'vite-hub/vitehub' }, action: 'synchronize',
        pull_request: { ...claim.snapshot.pr!, head: { ...claim.snapshot.pr!.head!, sha: 'c'.repeat(40) } },
      })
      else { await inbox.release(claim); await inbox.claim(1) }
      await inbox.ingest('obsolete-candidate-ci', 'status', { repository: { full_name: 'vite-hub/vitehub' }, sha: head, context: 'obsolete', state: 'failure' })
      assert.equal((await inbox.get('vite-hub/vitehub', 42))?.statuses.obsolete, undefined)
      assert.equal(await inbox.registerProspectivePush(claim, 'd'.repeat(40)), false)
    } finally { await inbox.close() }
  })
}
