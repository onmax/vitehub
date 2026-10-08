---
title: Code Host Channels
description: Run an Agent on GitLab, Forgejo, and Codeberg pull request events.
navigation.order: 40.6
navigation.group: Connect
icon: i-lucide-git-pull-request
---

`gitlab()` and `forgejo()` connect pull requests to an Agent. GitLab merge requests use the same pull request context. The merge request `iid` is the pull request number, including projects in nested groups.

These Channels share filters, mentions, reconcile triggers, reply delivery, commit statuses, and managed activity comments with [`github()`](/docs/agents/channels#reconcile-github-pull-requests). Call `pullRequest.read(invocation)` to inspect the request. Its `provider` is `gitlab` or `forgejo`, and `instance` identifies the host.

## Add a Channel

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { forgejo, gitlab } from 'vite-hub/agent/channels'

export default defineAgent({
  channels: {
    gitlab: gitlab({
      pullRequest: { reconcile: { mentions: ['@review-bot'] } },
      activity: true,
    }),
    codeberg: forgejo({ pullRequest: true }),
  },
  driver: { model: 'openai/gpt-5.1-mini' },
})
```

`forgejo()` uses Codeberg by default. Set `baseUrl` to the instance root for self-managed GitLab or Forgejo. The Channel adds the API path.

Enable `pullRequest` to accept slash commands. Configure `reconcile.mentions` to accept mentions, `reconcile.comments` to accept comments without a command, or `reconcile.triggers` for event-specific filters and mentions. Comment trigger events are `comment`, `review`, and `review_comment`. Lifecycle events are `opened`, `reopened`, `synchronize`, and `ready_for_review`. `reconcile: true` enables these lifecycle events.

The final reply is a pull request comment. Set `pullRequest.reply: false` to stop that reply. Delivery effects can add reactions, update the triggering comment, or report commit statuses. `statusContext` defaults to `ViteHub Agent`. `activity: true` keeps one managed comment with session links and status. The authenticated account owns that comment.

## Server Env

Explicit options take precedence over Server Env. The Channel reads the host variables when Server Env does not declare the field.

| Server Env field | Host variable | Default or use |
| --- | --- | --- |
| `gitlab.baseUrl` | `GITLAB_BASE_URL` | `https://gitlab.com` |
| `gitlab.token` | `GITLAB_TOKEN` | Token for metadata and writes. |
| `gitlab.webhookSecret` | `GITLAB_WEBHOOK_SECRET` | Required webhook secret. |
| `forgejo.baseUrl` | `FORGEJO_BASE_URL` | `https://codeberg.org` |
| `forgejo.token` | `FORGEJO_TOKEN` | Token for metadata and writes. |
| `forgejo.webhookSecret` | `FORGEJO_WEBHOOK_SECRET` | Required webhook secret. |

The matching options are `baseUrl`, `token`, and `webhookSecret`. Each accepts a runtime callback. Tokens and secrets also accept a Server Env secret value with `unseal()`.

## Configure webhooks

Create the project or repository webhook for the generated Agent Channel route. Set the secret to the same value as `webhookSecret` or its Server Env field.

| Host | Events to enable |
| --- | --- |
| GitLab | Comments, Merge request events |
| Forgejo or Codeberg | Pull Request, Pull Request Comment, Review |

GitLab sends its secret in `X-Gitlab-Token`. Forgejo signs the body. A wrong signature or token returns HTTP 401. A missing secret fails with `AGENT_R0946`, and the message names the option and env variable. Delivery IDs prevent duplicate Invocations. Reconcile runs use the shared pull request concurrency limit, which defaults to one.

## Limits

These Channels do not provide `pullRequest.workspace` checkout, artifacts, or `authorAssociation` filters. `webhookSecret: false` is not supported. Configure a Workspace through the Agent's other Capabilities if needed.

GitLab supports approval reviews through its API. A review body or a comment review is not supported there. Use a reply comment for review text. Forgejo supports native reviews, but its CI runs, jobs, and check reruns are not available through these Channels.

Metadata reads have limits. Set `maxBodyLength`, `maxCommentBodyLength`, `maxComments`, and `maxFiles` on `pullRequest` to change them. The context reports omitted items and unavailable metadata. Activity lookup scans at most 500 comments after a restart.
