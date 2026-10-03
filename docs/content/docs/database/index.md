---
title: Database
navigation.title: Overview
description: Define relational data with Drizzle and query it through generated ViteHub imports.
navigation.order: 1
icon: i-lucide-database
---

Use Database when your app needs relational schemas, constraints, joins, migrations, or queryable state. You define the schema with Drizzle next to your server code. ViteHub discovers the Definition, generates Drizzle artifacts and migration config, and gives server code a typed Drizzle client by database name.

The same Definition runs on local SQLite, a hosted libSQL database, or Cloudflare D1. Database works without Agents.

::tip
Choose the storage primitive by data shape:

- [KV](/docs/kv): small values that you read and write by key, such as settings, flags, cursors, and counters.
- Database: rows with a schema, constraints, joins, and migrations.
- [Blob](/docs/blob): files and binary objects with metadata, such as uploads, media, and exports.
- [Workspace](/docs/workspace): file trees with paths, snapshots, and diffs.
::

## Connect Database to Agents

Direct Database access is for server code. To let a model inspect the schema or run guarded statements, attach the [Database Capability](/docs/database/agent-capability).

The Database Capability is not a raw Drizzle client proxy. It adds agent-facing guardrails such as schema mode, data mode, write approvals, and a single-statement SQL check. Read it before you expose database access to an Agent.
