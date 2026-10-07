---
title: Render your first Markdown template
description: "Install the Markdown Template package, bind data, and return rendered Markdown."
layout: tutorial
navigation.title: Tutorial
navigation.order: 52
navigation.group: Tutorial
icon: i-lucide-rocket
---

`@vite-hub/markdown-template` renders Markdown from explicit data. Start with a
string template and one result, then move the template into a file when the
application owns a stable prompt or document.

::note
You need Node.js 24 or newer and `pnpm`. The renderer performs no filesystem or
network I/O, so this first example runs without a Vite server.
::

::tutorial-step{title="Install the package"}
## Install the package

```bash [commands/install]
pnpm add @vite-hub/markdown-template
```

The package accepts a complete template string and an explicit `data` object.
Scalar bindings are escaped Markdown text. Use `:insert` only for a fragment
that your application has already validated.
::

::tutorial-step{title="Render a document"}
## Render a document

Call `renderMarkdownTemplate()` from server code:

```ts [server/render-release.ts]
import { renderMarkdownTemplate } from "@vite-hub/markdown-template";

const markdown = await renderMarkdownTemplate(
  [
    "# Release {{ data.version }}",
    "",
    "Status: {{ data.status }}",
    "",
    ":insert{:markdown=\"data.notes\"}",
  ].join("\n"),
  {
    data: {
      version: "0.0.4",
      status: "ready",
      notes: "- Build passes\n- Preview checked",
    },
  },
);

console.log(markdown);
```

The template escapes scalar values while preserving the list supplied through
the trusted `notes` fragment.
::

::tutorial-step{title="Verify the result"}
## Verify the result

Run the module with your project's TypeScript runner. The output is Markdown:

```md [output/result.md]
# Release 0.0.4

Status: ready

- Build passes
- Preview checked
```

For a file-backed template, import a `*.template.md` file directly. The
`vitehub()` preset handles the module in a framework application, or a modular
Vite config can add `hubMarkdownTemplate()` from
`@vite-hub/markdown-template/vite`. Read [Markdown templates](/docs/reference/markdown-templates)
for conditions, file imports, and migration rules. [Agent Instructions](/docs/agents/instructions)
shows how to use rendered Markdown as durable Agent guidance.
::
