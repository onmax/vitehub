import { expect, it, vi } from 'vitest'
import { createGitHubHost } from '../src/server/github-host.ts'
import { createBabysitterProcessHost } from '../src/presets/babysitter/host.ts'

const createProcessAgentHost = vi.hoisted(() => vi.fn((options: { capacity: unknown }) => {
  void options
  throw new Error('process host construction observed')
}))

vi.mock('../src/channel-env.ts', () => ({ channelEnv: async () => ({ appId: 1, appPrivateKey: 'test-key' }) }))
vi.mock('../src/server/github-host.ts', () => ({
  createGitHubAppCredentials: () => ({
    credentials: () => ({ token: 'test-token' }),
    identity: async () => ({ login: 'test-bot', email: 'test@example.com' }),
  }),
  createGitHubHost: vi.fn(() => ({})),
}))
vi.mock('../src/runtime/process-host.ts', () => ({ createProcessAgentHost }))

it('enables a persistent checkout pool in each Babysitter host directory', async () => {
  for (const name of ['first', 'second']) {
    await expect(createBabysitterProcessHost({
      agentName: name,
      agent: { options: { concurrency: 1, filter: { repository: { allow: ['acme/app'] } } } },
      dataDir: `/data/${name}`,
      state: { extension: () => { throw new Error('must not open state') } },
    })).rejects.toThrow('process host construction observed')
    expect(createGitHubHost).toHaveBeenLastCalledWith(expect.objectContaining({ checkouts: { root: `/data/${name}/checkouts` } }))
    expect(createProcessAgentHost).toHaveBeenLastCalledWith(expect.objectContaining({
      capacity: {
        concurrency: 1,
        queue: { maxPending: 1, timeout: 36e5 },
      },
    }))
  }
})
