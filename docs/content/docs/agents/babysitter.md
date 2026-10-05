---
title: Babysitter
description: Deploy an Agent that repairs pull requests, waits for checks, and merges ready ones.
navigation.group: Configure
---

The Babysitter preset repairs selected pull requests. It addresses review feedback from people and bots, fixes failing checks, and pushes the repair. Then it waits for check and review results without another model pass. It can also merge ready pull requests.

## Add the Agent

Select the preset in a discovered Agent. The repository filter is required: the Babysitter looks for open pull requests only in these repositories.

```ts [server/agents/babysitter/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { babysitter } from 'vite-hub/agent/presets/babysitter'

export default defineAgent({
  extends: babysitter,
  options: {
    filter: {
      repository: { allow: ['acme/app'] },
      author: { allow: ['octocat'] },
    },
    merge: 'direct',
    concurrency: 2,
  },
  driver: { model: 'gpt-5.6-sol' },
})
```

Add `instructions.md` next to `agent.ts` for project-specific guidance. It fills the preset's instruction slot.

| Option | Default | Purpose |
| --- | --- | --- |
| `filter` | `{}` | Pull requests to repair, with the [GitHub Channel filter rules](/docs/agents/channels). `repository.allow` is required. |
| `driver` | `'codex'` | `'codex'` or `'claude-code'`. Set the model and provider settings with the ordinary `driver` field. |
| `merge` | `false` | `false`, `'auto'` (request GitHub auto-merge), `'direct'` (merge a ready PR on the host), or `{ strategy: 'direct', method, ready }`. |
| `reviewChecks` | `[]` | Check names, such as a review bot's check, that keep a PR waiting while they run. |
| `noFindingsReviews` | `[]` | Body prefixes of comment-only reviews that report no findings, such as `'> ✅ No new issues found.'`. They do not wake a waiting PR. |
| `ignoreFeedbackAuthors` | `[]` | Logins, such as deployment preview bots, whose comments and reviews never need an assessment. They do not block a direct merge or wake a waiting PR. |
| `deferWhilePending` | `true` | Wait for running required checks and review checks before a pass, so one pass handles CI and review results together. A failure or a conflict starts the pass at once. |
| `noProgressBudget` | `3` | Passes on one head that can end without a push or a recorded wait. Then the PR waits until its head changes or a person comments. `false` disables the budget. |
| `install` | `true` | Install dependencies on the host before the model starts. `true` detects pnpm, npm, Yarn or Bun from the lockfile and installs it frozen; `{ command, args }` overrides it; `{ cache: { directory, entries } }` configures the pnpm cache; `false` skips it. |
| `concurrency` | `1` | Pull requests repaired at the same time. |

## Configure GitHub

Create a GitHub App with read and write access to contents, pull requests, issues, and checks. Subscribe it to pull request, review, review comment, review thread, issue comment, check run, check suite, status, and push events. Set its webhook URL to `https://<host>/api/_vitehub/agents/babysitter/webhooks/github`.

Set these variables on the host, or declare them in `env.server.github`:

| Variable | Purpose |
| --- | --- |
| `GITHUB_APP_ID` | The App ID. |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` | The App private key. |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret. Deliveries without a valid signature are rejected. |
| `GITHUB_APP_INSTALLATION_ID` | Optional. Without it, each repository uses its own installation. |
| `VITEHUB_AGENT_STATE_URL` | Agent State, for example `file:/var/lib/babysitter/state.sqlite`. Production builds require it. |

The Babysitter commits as the App's bot. GitHub tokens stay on the host; the worker reaches GitHub only through tools that are bound to its pull request.

## Deploy

The Babysitter runs a long-lived process, so deploy it with the Node server preset on a host with a persistent disk, Git, and the provider CLI. The build fails with `AGENT_B0022` on Cloudflare, Vercel, Netlify, and Deno, and with `AGENT_B0023` without SQL Agent State.

ViteHub starts the Babysitter when the server starts. A development server starts it only with `VITEHUB_AGENT_PROCESS_HOSTS=1`, so it does not repair real pull requests by accident.

| Route | Purpose |
| --- | --- |
| `GET /api/_vitehub/host/health` | Health and the pull request queue: working, ready, and waiting. |
| `GET /api/_vitehub/host/drain` | Drain status: `accepting`, `draining`, or `drained`. |

To replace the process, send SIGUSR2, wait until the drain route reports `drained`, then restart. Running passes finish first.

## How it works

1. Signed webhooks update a durable pull request inbox in Agent State. Once a minute, one GraphQL query per repository lists the open pull requests; a pull request whose state changed without a delivery gets a targeted read, so lost deliveries are recovered within about a minute.
2. When a pull request needs work, the host clones its head and starts one repair pass with the Agent.
3. After a repair push, the pass ends within 3 minutes and the pull request waits on the pushed head.
4. Check results that the pass already knew, pending checks, and the push's own events keep it waiting. New feedback, a new failing check, a conflict, or an unresolved review thread wake it.
5. With `merge: 'direct'`, passing required checks also wake it. The host merges when every check passed, every review thread is resolved, and GitHub reports the pull request as clean on the default branch. It never merges into another branch.

Feedback that a pass assessed, or answered with a repair push, stays assessed on later heads. A later head needs a model pass only for new feedback, so a pull request whose push satisfied every finding merges without another pass. Bot issue comments count by identity, so a bot that edits its status comment does not cause a pass. Without required checks on the base branch, the newest run of every current-head check must finish before a merge. An earlier run of a rerun check is ignored.

A pull request that ends `noProgressBudget` passes on one head without progress waits until its head changes or a person comments. Stack parents are claimed before other work, and a restart releases the claims of the previous process. A stacked pull request whose parent merged into the default branch is moved to the default branch.

The host installs dependencies in each pass workspace before the model starts. The install gets only `PATH`, `HOME`, locale, package manager and `NODE_OPTIONS` variables, never the provider or GitHub credentials, and runs the repository's lifecycle scripts. The result is in `.git/vitehub-install.json` for the model.

On Linux, a detected pnpm install reuses the `node_modules` trees of an earlier pass with the same lockfile, workspace file, root `package.json`, `.npmrc`, patches and Node version. The host hardlinks the trees into the workspace, as pnpm links its own store, and verifies them with a frozen offline install; a failed check gets a clean install. Passes that need the same trees wait for the first install. The cache directory must be on the same filesystem as the pass workspaces. It defaults to `BABYSITTER_INSTALL_CACHE` or `vitehub-install-cache` in the temporary directory, and keeps `BABYSITTER_INSTALL_CACHE_ENTRIES` or 8 entries. Set `install: { cache: false }` to disable it.

When the process temporary directory is inside the service's working directory, the host removes pass workspaces left by an earlier process at startup.
