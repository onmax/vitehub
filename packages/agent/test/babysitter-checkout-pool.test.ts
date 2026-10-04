import { expect, it, vi } from 'vitest'
import { createGitHubHost } from '../src/server/github-host.ts'
import { createBabysitterProcessHost } from '../src/presets/babysitter/host.ts'

vi.mock('../src/channel-env.ts', () => ({ channelEnv: async () => ({ appId: 1, appPrivateKey: 'test-key' }) }))
vi.mock('../src/server/github-host.ts', () => ({
  createGitHubAppCredentials: () => ({
    credentials: () => ({ token: 'test-token' }),
    identity: async () => ({ login: 'test-bot', email: 'test@example.com' }),
  }),
  createGitHubHost: vi.fn(() => { throw new Error('host construction observed') }),
}))

it('enables a persistent checkout pool in each Babysitter host directory', async () => {
  for (const name of ['first', 'second']) {
    await expect(createBabysitterProcessHost({
      agentName: name,
      agent: { options: { concurrency: 1, filter: { repository: { allow: ['acme/app'] } } } },
      dataDir: `/data/${name}`,
      state: { extension: () => { throw new Error('must not open state') } },
    })).rejects.toThrow('host construction observed')
    expect(createGitHubHost).toHaveBeenLastCalledWith(expect.objectContaining({ checkouts: { root: `/data/${name}/checkouts` } }))
  }
})
