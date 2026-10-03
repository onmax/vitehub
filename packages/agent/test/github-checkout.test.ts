import { execFile } from 'node:child_process'
import { access, cp, link, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { createGitHubHost, prepareGitHubPullRequestWorkspace } from '../src/server/github.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, mkdtemp: vi.fn(fs.mkdtemp), rename: vi.fn(fs.rename) }
})

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim()
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-pr-git-'))
  roots.push(root)
  const source = join(root, 'source')
  const target = join(root, 'provider')
  await mkdir(source)
  await mkdir(target)
  await git(source, 'init', '-b', 'feature')
  await git(source, 'config', 'user.name', 'Test')
  await git(source, 'config', 'user.email', 'test@example.com')
  await git(source, 'remote', 'add', 'origin', 'https://github.com/acme/base.git')
  await git(source, 'remote', 'set-url', '--push', 'origin', 'https://github.com/contributor/fork.git')
  await writeFile(join(source, 'file.txt'), 'before\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'base')
  await cp(join(source, 'file.txt'), join(target, 'file.txt'))
  return { root, source, target, head: await git(source, 'rev-parse', 'HEAD') }
}

it('preserves independent ancestry and source push destination, replacing stale metadata without credentials', async () => {
  const { source, target, head } = await fixture()
  await git(target, 'init')
  await git(target, 'config', 'stale.value', 'yes')
  await git(source, 'config', 'credential.helper', 'secret-helper')
  await git(source, 'config', 'http.https://github.com/.extraheader', 'Authorization: secret')
  await prepareGitHubPullRequestWorkspace(source, target)
  expect(await git(target, 'rev-parse', 'HEAD')).toBe(head)
  expect(await git(target, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/base.git')
  expect(await git(target, 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/contributor/fork.git')
  const config = await readFile(join(target, '.git/config'), 'utf8')
  expect(config).not.toMatch(/secret|stale/)
  await writeFile(join(target, 'file.txt'), 'repair\n')
  await git(target, 'add', '.')
  await git(target, 'commit', '-m', 'repair')
  expect(await git(target, 'rev-parse', 'HEAD^')).toBe(head)
  expect(await git(source, 'rev-parse', 'HEAD')).toBe(head)
  expect(await git(source, 'status', '--porcelain')).toBe('')
})

it('rejects shared directories, linked worktrees, and cancelled preparation', async () => {
  const { root, source, target } = await fixture()
  await expect(prepareGitHubPullRequestWorkspace(source, source)).rejects.toThrow('must be separate')
  await expect(prepareGitHubPullRequestWorkspace(source, root)).rejects.toThrow('must be separate')
  const linked = join(root, 'linked')
  await git(source, 'worktree', 'add', '--detach', linked)
  await expect(prepareGitHubPullRequestWorkspace(linked, target)).rejects.toThrow('independent prepared Git clone')
  await expect(prepareGitHubPullRequestWorkspace(source, target, { signal: AbortSignal.abort() })).rejects.toThrow()
})

it('supplies Git credentials without running the GitHub CLI', async () => {
  const { source } = await fixture()
  const host = createGitHubHost({ credentials: () => ({ token: 'test-token', rateLimitKey: 'test' }) })
  const { env } = await host.access()
  const result = await new Promise<string>((resolve, reject) => {
    const child = execFile('git', ['credential', 'fill'], { cwd: source, env: { ...process.env, ...env } }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin!.end('protocol=https\nhost=github.com\n\n')
  })
  expect(result).toContain('username=x-access-token')
  expect(result).toContain('password=test-token')
})

it('fetches the fork branch instead of stale PR refs and pushes provider repairs with a head lease', async () => {
  const { root, source, target, head: staleHead } = await fixture()
  const fork = join(root, 'fork.git')
  await git(root, 'clone', '--bare', source, fork)
  await git(source, 'update-ref', 'refs/pull/123/head', staleHead)
  await writeFile(join(source, 'file.txt'), 'new head\n')
  await git(source, 'commit', '-am', 'new head')
  const headSha = await git(source, 'rev-parse', 'HEAD')
  await git(source, 'push', fork, 'feature')
  const bin = join(root, 'bin')
  await mkdir(bin)
  const realGit = (await exec('which', ['git'])).stdout.trim()
  await writeFile(join(bin, 'gh'), '#!/bin/sh\necho "gh must not run" >&2\nexit 1\n', { mode: 0o755 })
  // Run real Git against local repositories. Only the network URL boundary is replaced.
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const map = ${JSON.stringify({ 'https://github.com/acme/base.git': source, 'https://github.com/contributor/fork.git': fork })};
const args = process.argv.slice(2).map(arg => map[arg] || arg);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  const credentials = vi.fn(({ repository }: { repository?: string }) => ({ token: repository ?? 'default', rateLimitKey: repository ?? 'default' }))
  const host = createGitHubHost({ credentials })
  const pr = { repository: 'acme/base', headRepository: 'contributor/fork', headRef: 'feature', headSha, number: 123 }
  await host.withPullRequestCheckout(pr, async checkout => {
    expect(await git(checkout.path, 'rev-parse', 'HEAD')).toBe(headSha)
    await cp(join(checkout.path, 'file.txt'), join(target, 'file.txt'))
    await checkout.prepareWorkspace(target)
    await git(target, 'config', 'user.name', 'Test')
    await git(target, 'config', 'user.email', 'test@example.com')
    await writeFile(join(target, 'file.txt'), 'repair\n')
    await git(target, 'commit', '-am', 'repair')
    const repair = await git(target, 'rev-parse', 'HEAD')
    await git(target, 'remote', 'set-url', '--push', 'origin', 'disabled://worker-controlled')
    const hooks = join(root, 'worker-hooks')
    await mkdir(hooks)
    const hookMarker = join(root, 'hook-ran')
    await writeFile(join(hooks, 'pre-push'), `#!/bin/sh\ntouch '${hookMarker}'\n`, { mode: 0o755 })
    await git(target, 'config', 'core.hooksPath', hooks)
    // Custody can change while host credentials are being refreshed.
    let custody = true
    credentials.mockImplementationOnce(({ repository }) => {
      custody = false
      return { token: repository ?? 'default', rateLimitKey: repository ?? 'default' }
    })
    await expect(checkout.push(target, { beforePush: () => {
      if (!custody) throw new DOMException('Lease lost', 'AbortError')
    } })).rejects.toThrow('Lease lost')
    expect(await git(fork, 'rev-parse', 'feature')).toBe(headSha)
    const pushController = new AbortController()
    credentials.mockImplementationOnce(({ repository }) => {
      pushController.abort(new DOMException('Lease expired', 'AbortError'))
      return { token: repository ?? 'default', rateLimitKey: repository ?? 'default' }
    })
    await expect(checkout.push(target, { signal: pushController.signal })).rejects.toThrow('Lease expired')
    expect(await git(fork, 'rev-parse', 'feature')).toBe(headSha)
    expect(await checkout.push(target)).toBe(repair)
    await expect(readFile(hookMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(fork, 'rev-parse', 'feature')).toBe(repair)
    expect(await git(target, 'rev-parse', 'HEAD^')).toBe(headSha)
    await git(source, 'fetch', fork, 'feature')
    await git(source, 'reset', '--hard', 'FETCH_HEAD')
    await writeFile(join(source, 'file.txt'), 'external update\n')
    await git(source, 'commit', '-am', 'external update')
    await git(source, 'push', fork, 'feature')
    const external = await git(source, 'rev-parse', 'HEAD')
    // A second push cannot overwrite a branch changed by another actor.
    await writeFile(join(target, 'file.txt'), 'second repair\n')
    await git(target, 'commit', '-am', 'second repair')
    await expect(checkout.push(target)).rejects.toThrow()
    expect(await git(fork, 'rev-parse', 'feature')).toBe(external)
  })
  expect(credentials.mock.calls.some(([scope]) => scope.repository === 'contributor/fork')).toBe(true)
  await expect(host.withPullRequestCheckout(pr, async () => { throw new Error('must not run') })).rejects.toThrow('head changed')
  await expect(host.withPullRequestCheckout({ ...pr, headRef: '../invalid' }, async () => {})).rejects.toThrow()
  const baseHead = await git(source, 'rev-parse', 'HEAD')
  await host.withPullRequestCheckout({ ...pr, headRepository: pr.repository, headSha: baseHead }, async checkout => {
    expect(await git(checkout.path, 'rev-parse', 'HEAD')).toBe(baseHead)
  })
  await host.withPullRequestCheckout({ repository: pr.repository, number: 124, headSha: baseHead }, async checkout => {
    expect(await git(checkout.path, 'rev-parse', 'HEAD')).toBe(baseHead)
    await expect(git(checkout.path, 'symbolic-ref', 'HEAD')).rejects.toThrow()
    await expect(checkout.push()).rejects.toThrow('source repository and branch are required')
  })

}, 30_000)

it.each(['darwin', 'win32'])('uses disposable checkouts without touching a configured pool on %s', async (platform) => {
  const { root, source, head } = await fixture()
  const pool = join(root, 'pool')
  const adopted = join(pool, 'YWNtZQ--YmFzZQ-pr-1-ABC123')
  await mkdir(adopted, { recursive: true })
  await writeFile(join(adopted, 'marker'), 'untouched')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  await git(root, 'config', '--file', config, `url.file://${source}.insteadOf`, 'https://github.com/acme/base.git')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  const originalPlatform = process.platform
  const host = (() => {
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      return createGitHubHost({
        checkouts: { root: pool },
        credentials: () => ({ token: 'test-token', rateLimitKey: 'offline-test' }),
      })
    }
    finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })()
  const pullRequest = { repository: 'acme/base', number: 1, headSha: head }
  let previousPath = ''
  for (let pass = 0; pass < 2; pass++) {
    await host.withPullRequestCheckout(pullRequest, async ({ path }) => {
      expect(path.startsWith(`${pool}/`)).toBe(false)
      expect(path).not.toBe(previousPath)
      expect(await git(path, 'rev-parse', 'HEAD')).toBe(head)
      previousPath = path
    })
    await expect(access(previousPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(await readdir(pool)).toEqual(['YWNtZQ--YmFzZQ-pr-1-ABC123'])
  expect(await readFile(join(adopted, 'marker'), 'utf8')).toBe('untouched')
}, 30_000)

it('reuses a pooled checkout, keeps ignored files, and resets the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-checkout-pool-'))
  roots.push(root)
  const base = join(root, 'base.git')
  const source = join(root, 'source')
  const pool = join(root, 'checkouts')
  const poolAlias = join(root, 'checkout-alias')
  await mkdir(pool)
  await symlink(pool, poolAlias, 'dir')
  await mkdir(source)
  await git(root, 'init', '--bare', base)
  await git(source, 'init', '-b', 'main')
  await git(source, 'config', 'user.name', 'Test')
  await git(source, 'config', 'user.email', 'test@example.com')
  await writeFile(join(source, '.gitignore'), 'node_modules\n')
  await writeFile(join(source, 'file'), 'base')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'base')
  await git(source, 'push', base, 'HEAD:refs/heads/main')
  await git(root, '--git-dir', base, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const commit = async (branch: string) => {
    await git(source, 'checkout', '-b', branch, 'main')
    await writeFile(join(source, 'file'), branch)
    await git(source, 'commit', '-am', branch)
    await git(source, 'push', base, `HEAD:refs/heads/${branch}`)
    return await git(source, 'rev-parse', 'HEAD')
  }
  const oneSha = await commit('one')
  const twoSha = await commit('two')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  await git(root, 'config', '--file', config, `url.file://${base}.insteadOf`, 'https://github.com/base--owner/repo--name.git')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  const options = {
    checkouts: { root: poolAlias },
    credentials: () => ({ token: 'test-token', rateLimitKey: 'offline-test' }),
    identity: { login: 'Test', email: 'test@example.com' },
  }
  const host = createGitHubHost(options)

  let firstPath = ''
  await host.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 1, headSha: oneSha, headRepository: 'base--owner/repo--name', headRef: 'one' }, async ({ path }) => {
    firstPath = await realpath(path)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(oneSha)
    await mkdir(join(path, 'node_modules'), { recursive: true })
    await writeFile(join(path, 'node_modules/marker'), 'warm')
    await writeFile(join(path, 'file'), 'dirty')
    await writeFile(join(path, 'untracked'), 'x')
    await mkdir(join(path, '.git/hooks'), { recursive: true })
    await writeFile(join(path, '.git/hooks/post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await git(path, 'config', 'core.fsmonitor', 'false')
    await writeFile(join(path, '.git/info/exclude'), 'untracked\n')
    await mkdir(join(path, '.vitehub'), { recursive: true })
    await writeFile(`${path}.meta.json`, '{}')
  })
  await access(firstPath)

  // Regular alternate metadata can expose an outside object store without a symlink.
  const outsideObjects = join(root, 'borrowed-object-store')
  await mkdir(outsideObjects)
  await git(outsideObjects, 'init')
  await writeFile(join(outsideObjects, 'private'), 'outside checkout object\n')
  const borrowedBlob = await git(outsideObjects, 'hash-object', '-w', 'private')
  await writeFile(join(firstPath, '.git/objects/info/alternates'), `${join(outsideObjects, '.git/objects')}\n`)
  expect(await git(firstPath, 'cat-file', '-p', borrowedBlob)).toBe('outside checkout object')

  // Split indexes must not retain references to shared index files removed during reset.
  await git(firstPath, 'update-index', '--split-index')
  expect((await readdir(join(firstPath, '.git'))).some(name => name.startsWith('sharedindex.'))).toBe(true)

  // An interrupted Git command can leave locks behind when the host stops.
  const staleLocks = ['index.lock', 'config.lock', 'config.worktree.lock', 'HEAD.lock', 'shallow.lock', 'packed-refs.lock']
  for (const lock of staleLocks) await writeFile(join(firstPath, '.git', lock), '')
  const staleGitState = ['rebase-merge', 'rebase-apply', 'sequencer']
  for (const state of staleGitState) await mkdir(join(firstPath, '.git', state))
  for (const state of ['CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REVERT_HEAD']) await writeFile(join(firstPath, '.git', state), '')

  // A restarted process adopts the checkout that the previous process left in the pool.
  const restarted = createGitHubHost(options)
  await restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 1, headSha: twoSha, headRepository: 'base--owner/repo--name', headRef: 'two' }, async ({ path }) => {
    expect(await realpath(path)).toBe(firstPath)
    await expect(access(join(path, '.git/objects/info/alternates'))).rejects.toThrow()
    await expect(git(path, 'cat-file', '-p', borrowedBlob)).rejects.toThrow()
    expect(await git(outsideObjects, 'cat-file', '-p', borrowedBlob)).toBe('outside checkout object')
    for (const lock of staleLocks) await expect(access(join(path, '.git', lock))).rejects.toThrow()
    for (const state of staleGitState) await expect(access(join(path, '.git', state))).rejects.toThrow()
    for (const state of ['CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REVERT_HEAD']) await expect(access(join(path, '.git', state))).rejects.toThrow()
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(twoSha)
    expect(await git(path, 'branch', '--show-current')).toBe('two')
    expect(await readFile(join(path, 'file'), 'utf8')).toBe('two')
    await expect(access(join(path, 'node_modules/marker'))).rejects.toThrow()
    await mkdir(join(path, 'node_modules'), { recursive: true })
    await writeFile(join(path, 'node_modules/marker'), 'warm')
    await expect(access(join(path, 'untracked'))).rejects.toThrow()
    expect(await readFile(join(path, '.git/info/exclude'), 'utf8')).toBe('')
    await expect(access(join(path, '.git/hooks/post-checkout'))).rejects.toThrow()
    await expect(access(join(path, '.vitehub'))).rejects.toThrow()
    await expect(access(`${path}.meta.json`)).rejects.toThrow()
    await expect(git(path, 'config', 'core.fsmonitor')).rejects.toThrow()
    expect(await git(path, 'config', 'remote.origin.pushurl')).toBe('https://github.com/base--owner/repo--name.git')
  })
  await restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 1, headSha: twoSha }, async ({ path }) => {
    expect(await realpath(path)).toBe(firstPath)
    expect(await readFile(join(path, 'node_modules/marker'), 'utf8')).toBe('warm')
  })
  // A callback can rename its directory to impersonate another PR before restart.
  const impersonated = firstPath.replace('-pr-1-', '-pr-3-')
  await rename(firstPath, impersonated)
  const nextHost = createGitHubHost(options)
  await nextHost.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 3, headSha: oneSha }, async ({ path }) => {
    expect(await realpath(path)).toBe(impersonated)
    await expect(access(join(path, 'node_modules/marker'))).rejects.toThrow()
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(oneSha)
  })
  await rename(impersonated, firstPath)
  await restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 1, headSha: twoSha }, async () => {})
  await mkdir(join(firstPath, 'node_modules'), { recursive: true })
  await writeFile(join(firstPath, 'node_modules/marker'), 'warm')
  let secondPath = ''
  await restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 2, headSha: oneSha }, async ({ path }) => {
    secondPath = await realpath(path)
    expect(path).not.toBe(firstPath)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(oneSha)
    await expect(access(join(path, 'node_modules/marker'))).rejects.toThrow()
    expect(await git(path, 'config', 'remote.origin.pushurl')).toMatch(/^disabled:/)
    await expect(git(path, 'config', 'remote.origin.push')).rejects.toThrow()
  })

  // A hard-linked object must not make an outside store available on reuse.
  const linkedObject = join(outsideObjects, '.git/objects', borrowedBlob.slice(0, 2), borrowedBlob.slice(2))
  const objectDirectory = join(secondPath, '.git/objects', borrowedBlob.slice(0, 2))
  await mkdir(objectDirectory, { recursive: true })
  await link(linkedObject, join(objectDirectory, borrowedBlob.slice(2)))
  const callback = vi.fn()
  await expect(restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 2, headSha: oneSha }, callback)).rejects.toThrow('unsafe Git metadata')
  expect(callback).not.toHaveBeenCalled()
  expect(await git(outsideObjects, 'cat-file', '-p', borrowedBlob)).toBe('outside checkout object')
  await restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 2, headSha: oneSha }, async ({ path }) => { secondPath = await realpath(path) })

  // Pooled cleanup must reject tampered Git metadata instead of following a symlink.
  await rename(join(secondPath, '.git'), join(secondPath, '.git-real'))
  await symlink(join(secondPath, '.git-real'), join(secondPath, '.git'))
  await expect(restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 2, headSha: oneSha }, async () => {
    throw new Error('must not run')
  })).rejects.toThrow('unsafe Git metadata')

  // Cleanup must not traverse a linked checkout or an intermediate metadata directory.
  for (const [index, component] of ['checkout', 'info', 'objects', 'objects/pack'].entries()) {
    const number = index + 3
    let checkoutPath = ''
    await restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number, headSha: oneSha }, async ({ path }) => {
      checkoutPath = await realpath(path)
    })
    const outside = join(root, `outside-${component.replaceAll('/', '-')}`)
    const replaced = component === 'checkout' ? checkoutPath : join(checkoutPath, '.git', component)
    await mkdir(replaced, { recursive: true })
    await rename(replaced, outside)
    await writeFile(join(outside, 'exclude'), 'keep me')
    await symlink(outside, replaced)
    const outsideEntries = await readdir(outside, { recursive: true })
    await expect(restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number, headSha: twoSha, headRepository: 'base--owner/repo--name', headRef: 'two' }, async () => {
      throw new Error('must not run')
    })).rejects.toThrow('unsafe Git metadata')
    expect(await readFile(join(outside, 'exclude'), 'utf8')).toBe('keep me')
    expect(await readdir(outside, { recursive: true })).toEqual(outsideEntries)
    if (component === 'checkout') expect(await git(outside, 'rev-parse', 'HEAD')).toBe(oneSha)
    await expect(access(checkoutPath)).rejects.toThrow()
  }

  // A checkout without a verified head leaves the pool.
  await expect(restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 2, headSha: twoSha, headRepository: 'base--owner/repo--name', headRef: 'one' }, async () => {
    throw new Error('must not run')
  })).rejects.toThrow('head changed')
  await expect(access(secondPath)).rejects.toThrow()
  expect(await readdir(pool)).toHaveLength(1)

  // A callback-created HEAD symlink must be discarded so the reset can recover.
  const outsideHead = join(root, 'outside-head')
  await writeFile(outsideHead, 'ref: refs/heads/one\n')
  await rm(join(firstPath, '.git/HEAD'))
  await symlink(outsideHead, join(firstPath, '.git/HEAD'))
  await restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 1, headSha: twoSha }, async ({ path }) => {
    expect(await realpath(path)).toBe(firstPath)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(twoSha)
  })
  expect(await readFile(outsideHead, 'utf8')).toBe('ref: refs/heads/one\n')

  // Reject a linked parent during both reset and failure cleanup.
  const outsidePool = join(root, 'outside-pool')
  await rename(pool, outsidePool)
  await symlink(outsidePool, pool)
  await expect(restarted.withPullRequestCheckout({ repository: 'base--owner/repo--name', number: 1, headSha: twoSha }, async () => {
    throw new Error('must not run')
  })).rejects.toThrow('unsafe Git metadata')
  expect(await git(firstPath, 'rev-parse', 'HEAD')).toBe(twoSha)
  expect(await readFile(join(firstPath, 'node_modules/marker'), 'utf8')).toBe('warm')
}, 30_000)

it('keeps reset Git operations private when the checkout path is replaced', async () => {
  const { root, source, head } = await fixture()
  const pool = join(root, 'pool')
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'marker'), 'untouched')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  await git(root, 'config', '--file', config, `url.file://${source}.insteadOf`, 'https://github.com/acme/base.git')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  const host = createGitHubHost({
    checkouts: { root: pool },
    credentials: () => ({ token: 'test-token', rateLimitKey: 'offline-test' }),
  })
  const pullRequest = { repository: 'acme/base', number: 1, headSha: head }
  let checkout = ''
  await host.withPullRequestCheckout(pullRequest, async ({ path }) => { checkout = await realpath(path) })
  const bin = join(root, 'bin')
  await mkdir(bin)
  const realGit = (await exec('which', ['git'])).stdout.trim()
  const commandLog = join(root, 'commands.jsonl')
  // A background process replaces the public checkout path while reset is in
  // flight. All Git commands must stay private, including fetch and cleanup.
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { appendFileSync, rmSync, symlinkSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + '\\n');
if (args.includes('init')) {
  rmSync(${JSON.stringify(checkout)}, { recursive: true, force: true });
  symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(checkout)});
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  await expect(host.withPullRequestCheckout(pullRequest, async () => {
    throw new Error('must not run')
  })).rejects.toThrow()
  const commands: string[][] = (await readFile(commandLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(commands.some(args => args.includes('init'))).toBe(true)
  expect(commands.some(args => args.includes('fetch'))).toBe(true)
  expect(commands.some(args => args.includes('clean'))).toBe(true)
  for (const args of commands) expect(args[1]).toMatch(/^\/proc\/\d+\/fd\/\d+\/(?:replacement-|checkout)/)
  expect(await readdir(outside)).toEqual(['marker'])
  expect(await readFile(join(outside, 'marker'), 'utf8')).toBe('untouched')
  expect(await readdir(pool)).toEqual([])
}, 30_000)

it('cleans the retained reset directory without deleting a replacement root', async () => {
  const { root, source, head } = await fixture()
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  await git(root, 'config', '--file', config, `url.file://${source}.insteadOf`, 'https://github.com/acme/base.git')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  const host = createGitHubHost({
    checkouts: { root: join(root, 'pool') },
    credentials: () => ({ token: 'test-token', rateLimitKey: 'offline-test' }),
  })
  const pullRequest = { repository: 'acme/base', number: 1, headSha: head }
  await host.withPullRequestCheckout(pullRequest, async () => {})
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const displaced = join(root, 'displaced-reset')
  let resetRoot = ''
  vi.mocked(rename).mockImplementation(async (from, to) => {
    const restoring = basename(String(from)) === 'checkout'
    if (restoring) resetRoot = await realpath(dirname(String(from)))
    await fs.rename(from, to)
    if (restoring) {
      await fs.rename(resetRoot, displaced)
      await mkdir(resetRoot)
      roots.push(resetRoot)
      await writeFile(join(resetRoot, 'marker'), 'untouched')
      await writeFile(join(displaced, 'retained-object'), 'must be removed')
    }
  })
  try {
    await host.withPullRequestCheckout(pullRequest, async ({ path }) => {
      expect(await git(path, 'rev-parse', 'HEAD')).toBe(head)
    })
  }
  finally {
    vi.mocked(rename).mockImplementation(fs.rename)
  }
  expect(resetRoot).not.toBe('')
  expect(await readdir(displaced)).toEqual([])
  expect(await readFile(join(resetRoot, 'marker'), 'utf8')).toBe('untouched')
}, 30_000)

it('rejects a checkout swapped for a symlink immediately before relocation', async () => {
  const { root, source, head } = await fixture()
  const pool = join(root, 'pool')
  const outside = join(root, 'outside')
  await mkdir(outside)
  await git(outside, 'init')
  const outsideHead = await readFile(join(outside, '.git/HEAD'), 'utf8')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  await git(root, 'config', '--file', config, `url.file://${source}.insteadOf`, 'https://github.com/acme/base.git')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  const host = createGitHubHost({
    checkouts: { root: pool },
    credentials: () => ({ token: 'test-token', rateLimitKey: 'offline-test' }),
  })
  const pullRequest = { repository: 'acme/base', number: 1, headSha: head }
  let checkout = ''
  await host.withPullRequestCheckout(pullRequest, async ({ path }) => { checkout = await realpath(path) })
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    expect(await realpath(from)).toBe(checkout)
    await fs.rename(checkout, join(root, 'displaced'))
    await symlink(outside, checkout)
    await fs.rename(from, to)
  })
  await expect(host.withPullRequestCheckout(pullRequest, async () => {
    throw new Error('must not run')
  })).rejects.toThrow('unsafe Git metadata')
  expect(await readFile(join(outside, '.git/HEAD'), 'utf8')).toBe(outsideHead)
  expect(await readdir(outside)).toEqual(['.git'])
  expect(await readdir(pool)).toEqual([])
}, 30_000)

it.each(['before allocation', 'during allocation'])('rejects a replaced pool root %s for a different PR', async (timing) => {
  const { root, source, head } = await fixture()
  const pool = join(root, 'pool')
  const displaced = join(root, 'displaced-pool')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  await git(root, 'config', '--file', config, `url.file://${source}.insteadOf`, 'https://github.com/acme/base.git')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  const credentials = vi.fn(() => ({ token: 'test-token', rateLimitKey: 'offline-test' }))
  const host = createGitHubHost({ checkouts: { root: pool }, credentials })
  await host.withPullRequestCheckout({ repository: 'acme/base', number: 1, headSha: head }, async () => {})
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const replace = async () => {
    await fs.rename(pool, displaced)
    await mkdir(pool)
    await writeFile(join(pool, 'marker'), 'untouched')
  }
  if (timing === 'before allocation') await replace()
  else vi.mocked(mkdtemp).mockImplementationOnce(async (prefix, options) => {
    await replace()
    return await fs.mkdtemp(prefix, options)
  })
  credentials.mockClear()
  const callback = vi.fn(async () => {})
  await expect(host.withPullRequestCheckout({ repository: 'acme/base', number: 2, headSha: head }, callback)).rejects.toThrow('root was replaced')
  expect(callback).not.toHaveBeenCalled()
  if (timing === 'before allocation') expect(credentials).not.toHaveBeenCalled()
  expect(await readdir(pool)).toEqual(['marker'])
  expect(await readFile(join(pool, 'marker'), 'utf8')).toBe('untouched')
  expect((await readdir(displaced)).filter(name => name.includes('-pr-2-'))).toEqual([])
}, 30_000)

it('keeps relocation in the retained pool when its parent is replaced by a directory', async () => {
  const { root, source, head } = await fixture()
  const pool = join(root, 'pool')
  const displaced = join(root, 'displaced-pool')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  await git(root, 'config', '--file', config, `url.file://${source}.insteadOf`, 'https://github.com/acme/base.git')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  const host = createGitHubHost({
    checkouts: { root: pool },
    credentials: () => ({ token: 'test-token', rateLimitKey: 'offline-test' }),
  })
  const pullRequest = { repository: 'acme/base', number: 1, headSha: head }
  let checkout = ''
  await host.withPullRequestCheckout(pullRequest, async ({ path }) => { checkout = await realpath(path) })
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    await fs.rename(pool, displaced)
    await mkdir(pool)
    // Mirror the visible checkout in the replacement parent. Path-based
    // relocation would use this directory and reset the replacement checkout.
    await cp(join(displaced, basename(checkout)), checkout, { recursive: true })
    await writeFile(join(checkout, 'untracked-marker'), 'untouched')
    await fs.rename(from, to)
  })
  const callback = vi.fn(async () => {})
  await expect(host.withPullRequestCheckout(pullRequest, callback)).rejects.toThrow('root was replaced')
  expect(callback).not.toHaveBeenCalled()
  expect(await readFile(join(checkout, 'untracked-marker'), 'utf8')).toBe('untouched')
  expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(head)
  expect(await readdir(displaced)).toEqual([])
}, 30_000)

it('clears initialized submodules when a pooled checkout changes its gitlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-checkout-submodule-'))
  roots.push(root)
  const source = join(root, 'source')
  const dependency = join(root, 'dependency')
  const remote = join(root, 'remote.git')
  for (const path of [source, dependency]) {
    await mkdir(path)
    await git(path, 'init', '-b', 'main')
    await git(path, 'config', 'user.name', 'Test')
    await git(path, 'config', 'user.email', 'test@example.com')
  }
  await writeFile(join(dependency, 'file'), 'one')
  await git(dependency, 'add', '.')
  await git(dependency, 'commit', '-m', 'one')
  const firstDependencySha = await git(dependency, 'rev-parse', 'HEAD')
  await writeFile(join(dependency, 'file'), 'two')
  await git(dependency, 'commit', '-am', 'two')
  const secondDependencySha = await git(dependency, 'rev-parse', 'HEAD')
  await git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'nested')
  await git(join(source, 'nested'), 'checkout', firstDependencySha)
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'one')
  const firstSha = await git(source, 'rev-parse', 'HEAD')
  await git(join(source, 'nested'), 'checkout', secondDependencySha)
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'two')
  const secondSha = await git(source, 'rev-parse', 'HEAD')
  await writeFile(join(source, '.gitmodules'), '[submodule "broken"\n')
  await git(source, 'add', '.gitmodules')
  await git(source, 'commit', '-m', 'malformed submodule config')
  const malformedSha = await git(source, 'rev-parse', 'HEAD')
  await git(source, 'checkout', secondSha, '--', '.gitmodules')
  await git(source, 'rm', '-f', 'nested')
  await writeFile(join(source, '.gitignore'), 'nested/\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'remove and ignore submodule')
  const removedSha = await git(source, 'rev-parse', 'HEAD')
  await git(root, 'clone', '--bare', source, remote)
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  await git(root, 'config', '--file', config, `url.file://${remote}.insteadOf`, 'https://github.com/acme/submodules.git')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
  const host = createGitHubHost({ checkouts: { root: join(root, 'pool') }, credentials: () => ({ token: 'test-token', rateLimitKey: 'offline-test' }) })
  let firstPath = ''
  await host.withPullRequestCheckout({ repository: 'acme/submodules', number: 1, headSha: firstSha }, async ({ path }) => {
    firstPath = await realpath(path)
    await git(path, 'submodule', 'update', '--init', '--recursive')
    expect(await git(join(path, 'nested'), 'rev-parse', 'HEAD')).toBe(firstDependencySha)
    await writeFile(join(path, 'nested/file'), 'dirty')
    await writeFile(join(path, 'nested/untracked'), 'stale')
  })
  await host.withPullRequestCheckout({ repository: 'acme/submodules', number: 1, headSha: secondSha }, async ({ path }) => {
    expect(await realpath(path)).toBe(firstPath)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(secondSha)
    expect(await readdir(join(path, 'nested'))).toEqual([])
    await expect(access(join(path, '.git/modules'))).rejects.toThrow()
    await git(path, 'submodule', 'update', '--init', '--recursive')
    expect(await git(join(path, 'nested'), 'rev-parse', 'HEAD')).toBe(secondDependencySha)
    expect(await readFile(join(path, 'nested/file'), 'utf8')).toBe('two')
    await expect(access(join(path, 'nested/untracked'))).rejects.toThrow()
    await writeFile(join(path, 'nested/untracked'), 'stale again')
  })
  await host.withPullRequestCheckout({ repository: 'acme/submodules', number: 1, headSha: malformedSha }, async ({ path }) => {
    expect(await realpath(path)).toBe(firstPath)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(malformedSha)
    expect(await readdir(join(path, 'nested'))).toEqual([])
    await expect(access(join(path, '.git/modules'))).rejects.toThrow()
  })
  await host.withPullRequestCheckout({ repository: 'acme/submodules', number: 1, headSha: removedSha }, async ({ path }) => {
    expect(await realpath(path)).toBe(firstPath)
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(removedSha)
    await expect(access(join(path, 'nested'))).rejects.toThrow()
  })
}, 30_000)

it('rejects an empty checkout pool root', () => {
  expect(() => createGitHubHost({ checkouts: { root: ' ' }, credentials: () => ({ token: 'test-token' }) })).toThrow('checkouts.root must be a directory path')
})
