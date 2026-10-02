---
title: Gmail
description: Let an Agent search and read Gmail and create unsent drafts through a Google Connection.
navigation.title: Gmail
navigation.order: 96
navigation.group: External context
icon: i-lucide-mail-search
---

`gmail()` gives an Agent structured tools to search Gmail, read messages, and create unsent drafts. The tools call the Gmail REST API through a Google [Connection](/docs/server-primitives/connections). The Connection holds the OAuth grant, checks access for each call, and records activity. No tool can send a message.

The Capability uses only `fetch`, so it runs on Node and Workers. It does not need a Workspace, a CLI, or a Skill.

Use [`email()`](/docs/capabilities/email) for application-owned transactional email through the Email primitive. Use `gmail()` for an operator-owned Gmail account and structured Gmail tools. To run an Agent on each new message and label it, use the [Gmail Channel](/docs/agents/gmail).

## Configure the Agent

::steps{level="3"}

### Define the Google Connection

Enable [Connections](/docs/server-primitives/connections#quick-start) and define a Connection with the `google()` preset. `gmail.readonly` covers search and read. `gmail.compose` covers drafts.

```ts [server/connections/google.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineConnection } from 'vite-hub/connections'
import { google } from 'vite-hub/connections/google'

export default defineConnection({
  provider: google({
    client: ({ event }) => useServerEnv(event).google,
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
  }),
  access: {
    agents: {
      inbox: { approve: ['gmail.drafts.create'] },
    },
  },
})
```

The key in `access.agents` is the Agent name. Reads are allowed without a rule. `gmail.drafts.create` is a write, so it needs `allow` or `approve`.

### Add the Capability

```ts [server/agents/inbox.ts]
import { defineAgent } from 'vite-hub/agent'
import { gmail } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    gmail({ operations: ['search', 'read', 'draft'] }),
  ],
})
```

### Connect the account

Open the Console, select **Connections**, and select **Connect** for `google`. Or run `vitehub connections connect google`.

::

## Tools

| Tool | Operation | Connection Operation ids | Effect |
| --- | --- | --- | --- |
| `gmail_search` | `search` | `gmail.messages.list`, `gmail.messages.get` | read |
| `gmail_read` | `read` | `gmail.messages.get`, `gmail.messages.attachments.get` | read |
| `gmail_draft` | `draft` | `gmail.drafts.create`, and `gmail.messages.get` for a reply | write |

`gmail_search` returns sender, recipients, subject, date, labels, and snippet for each message. The default query is `in:inbox`. `gmail_read` returns the headers, the decoded text body up to `maxChars`, and attachment names. Gmail stores large bodies as attachments; `gmail_read` fetches them. `gmail_draft` creates a plain-text draft with `to`, `subject`, and `body`. The result always has `sent: false`.

Set `replyTo` to a Gmail message id to create a reply draft. The tool reads that message and sets the thread id, `In-Reply-To`, `References`, and `Re: <original subject>`, so Gmail adds the draft to the thread. Omit `subject` for a reply. A different subject fails.

The following Agent-visible definitions are resolved from the real Capability during the docs build.

### Default operations

::agent-capability-tools{name="gmail" variant="read"}
::

### With drafts

::agent-capability-tools{name="gmail" variant="draft"}
::

Message content is untrusted external data. The tool descriptions tell the Agent to treat it as data, not instructions.

## Access and approval

Before a tool runs, ViteHub checks each of its Operation ids against the Agent rule in the Connection. The rules are the [Connection access rules](/docs/server-primitives/connections#access-rules): `deny` wins, then `approve`, then `allow`. Without a match, reads are allowed and writes are denied.

| Rule for `gmail.drafts.create` | `gmail_draft` result |
| --- | --- |
| `allow` | Creates the draft. |
| `approve` | Asks for tool approval. In a provider Agent session, the user can approve the call and the draft is created. Otherwise it fails with `APPROVAL_REQUIRED`. Durable approval is not available yet. |
| `deny` or no match | Fails with `CAPABILITY_DENIED`. |

To block a read tool, deny its Operation, for example `deny: ['gmail.messages.*']`.

The access rules limit the calls. The OAuth scopes limit the grant. `gmail_draft` cannot send, but the `gmail.compose` and `gmail.modify` scopes also permit sending. Server code that uses the same Connection can send through `fetch` when its `server` or `routes` rule allows that write.

## Activity

Each Agent tool call is recorded as Connection activity, reads included. An entry has the Agent name as actor, the Operation id, the outcome, the provider status, the duration, the run id, the Invocation trace id, and the tool name. Denied and approval-required calls are also recorded. Activity never contains message bodies, headers, or tokens.

See activity in the Console under **Connections**, or run `vitehub connections activity google`.

## Verify Gmail access

Run `vitehub agent info --agent inbox --json` and inspect the resolved tools. The default lists `gmail_search` and `gmail_read`. With `draft`, it also lists `gmail_draft`.

Start with a test Gmail account. Search for `in:inbox`, create a draft, and make sure in Gmail that the message stays in Drafts and was not sent. Then check the activity entries for the Agent.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connection` | `string` | `"google"` | Name of the Google Connection in `server/connections/`. |
| `operations` | `Array<"search" \| "read" \| "draft">` | `["search", "read"]` | Tools to expose. `"draft"` adds `gmail_draft`. |

## Migrate from `mode`

This is a breaking change. `gmail()` no longer uses the `gog` CLI, a Workspace, or a bundled Gmail Skill.

| Before | After |
| --- | --- |
| `gmail()` | `gmail()` |
| `gmail({ mode: 'draft' })` | `gmail({ operations: ['search', 'read', 'draft'] })` and `allow` or `approve` for `gmail.drafts.create` |
| `gog` OAuth client, keyring, and `GOG_KEYRING_PASSWORD` | A Google OAuth client in Server Env and a Connection in `server/connections/` |
| `gmail_auth` tool | Connect the account in the Console or with `vitehub connections connect` |
| `workspace: { mode: 'write' }` for Gmail | Not required |

Remove the `gog` installation and its state directories after you migrate.

## Related pages

- [Connections](/docs/server-primitives/connections)
- [Email Capability](/docs/capabilities/email)
