---
title: ViteHub documentation
description: Server Primitives and Agents for Vite applications, one product section each, deployed on the host you select.
navigation: false
icon: i-lucide-book-open
---

ViteHub adds server features to Vite applications. Each **Server Primitive** is
one product with one import, one configuration, and one docs section. Trusted
application code calls it directly. An **Agent** can receive selected
operations from a primitive through its Agent capability page.

```bash [Terminal]
pnpm add vite-hub
```

Register `vitehub()` in `vite.config.ts`, select the primitives the application
uses, then call the documented import from server code. The
[installation guide](/docs/getting-started/installation) covers Vite, Nuxt, and
the owner packages.

Every product section uses the same pages in the same order: Overview, Get
started, Configure, Server API, Agent capability when the primitive has one,
Hosts, and Limits and errors. Open a product below, or press the search key to
jump to any page.

::docs-catalog
::
