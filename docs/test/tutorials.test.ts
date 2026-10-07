import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const docsRoot = resolve(import.meta.dirname, "..")
const fixturesRoot = resolve(docsRoot, "../../fixtures/tutorials")

function normalize(source: string) {
  return source.trim().replaceAll("\r\n", "\n")
}

function codeBlocks(source: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp("```[^\\n]*\\[" + escaped + "\\]\\n([\\s\\S]*?)\\n```", "g")

  return [...source.matchAll(pattern)].map(match => normalize(match[1] || ""))
}

async function expectPageToUseFixture(pagePath: string, fixture: string, labels: string[]) {
  const page = await readFile(resolve(docsRoot, pagePath), "utf8")

  for (const label of labels) {
    const expected = normalize(await readFile(resolve(fixturesRoot, fixture, label), "utf8"))
    expect(codeBlocks(page, label), `${pagePath} should include ${label}`).toContain(expected)
  }
}

describe("documentation tutorials", () => {
  it("uses the framework distribution as the only direct ViteHub dependency", async () => {
    for (const fixture of ["agents", "server-primitives"]) {
      const manifest = JSON.parse(await readFile(resolve(fixturesRoot, fixture, "package.json"), "utf8"))
      const dependencyNames = Object.keys(manifest.dependencies || {})

      expect(dependencyNames).toContain("vite-hub")
      expect(dependencyNames.filter(name => name.startsWith("@vite-hub/"))).toEqual([])
    }
  })

  it("gives every product its own scroll-driven tutorial", async () => {
    const docs = resolve(docsRoot, "content/docs")
    const entries = await readdir(docs, { withFileTypes: true })
    const tutorialPaths: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = resolve(docs, entry.name, "get-started.md")
      try {
        await readFile(path)
        tutorialPaths.push(path)
      } catch {
        // Some sections, such as Reference, intentionally have no package tutorial.
      }
    }

    expect(tutorialPaths.length).toBeGreaterThanOrEqual(19)

    for (const path of tutorialPaths) {
      const source = await readFile(path, "utf8")
      expect(source, path).toContain("layout: tutorial")
      expect(source, path).toContain("navigation.title: Tutorial")
      expect(source, path).toContain("::tutorial-step")
      expect(source.match(/```[^\n]*\[[^\]]+\]/g)?.length || 0, path).toBeGreaterThan(0)
    }
  })

  it("covers public packages that live outside a primitive section", async () => {
    for (const page of [
      "content/docs/ui/get-started.md",
      "content/docs/agents/box-tutorial.md",
      "content/docs/reference/markdown-template-tutorial.md",
    ]) {
      const source = await readFile(resolve(docsRoot, page), "utf8")
      expect(source, page).toContain("layout: tutorial")
      expect(source, page).toContain("navigation.title: Tutorial")
      expect(source, page).toContain("::tutorial-step")
      expect(source.match(/```[^\n]*\[[^\]]+\]/g)?.length || 0, page).toBeGreaterThan(0)
    }
  })

  it("keeps the scroll code rail reversible and stable for repeated filenames", async () => {
    const source = await readFile(resolve(docsRoot, "app/components/CodeTreeIntersection.vue"), "utf8")

    expect(source).toContain("if (entry?.isIntersecting) register()")
    expect(source).toContain("records.value")
    expect(source).toContain("while (labels.has(label))")
    expect(source).not.toContain("const registered = ref(false)")
    expect(source).not.toContain("if (registered.value) return")
  })

  it("keeps the code rail breakpoint aligned with the inline code fallback", async () => {
    const tutorial = await readFile(resolve(docsRoot, "app/components/DocsTutorial.vue"), "utf8")
    const step = await readFile(resolve(docsRoot, "app/components/TutorialStep.vue"), "utf8")

    expect(tutorial).toContain("xl:grid-cols-[minmax(0,1fr)_minmax(20rem,42%)]")
    expect(tutorial).toContain("xl:!w-full")
    expect(step).toContain("@media (min-width: 80rem)")
    expect(step).toContain("@media (max-width: 79.99rem)")
    expect(step).toContain(":deep(div:has(> pre))")
  })

  it("keeps the Agents editorial tutorial cold-rendered", async () => {
    const source = await readFile(resolve(docsRoot, "content/blog/2.agents.md"), "utf8")
    expect(source).not.toContain("::code-tree-intersection")

    for (const label of ["vite.config.ts", "server/agents/greeting.ts", "src/memo.ts", "src/server.ts"]) {
      const expected = normalize(await readFile(resolve(fixturesRoot, "agents", label), "utf8"))
      expect(codeBlocks(source, label), `content/blog/2.agents.md should render ${label} inline`).toContain(expected)
    }
  })

  it("keeps the Agents blog as the only editorial entry", async () => {
    const blogRoot = resolve(docsRoot, "content/blog")
    const entries = (await readdir(blogRoot)).filter(file => file.endsWith(".md")).sort()

    expect(entries).toEqual(["2.agents.md"])
    const source = await readFile(resolve(blogRoot, "2.agents.md"), "utf8")
    expect(source).toContain("layout: article")
    expect(source).not.toMatch(/^##?\s+Evals?\b/im)
  })

  it("keeps the standalone quickstarts on their checked fixtures", async () => {
    await expectPageToUseFixture("content/docs/getting-started/first-server-primitive.md", "server-primitives", ["vite.config.ts", "src/server.ts"])
    await expectPageToUseFixture("content/docs/getting-started/first-agent.md", "first-agent", ["vite.config.ts", "server/agents/greeting.ts", "src/server.ts"])
  })

  it("loads the model upgrade credential when restarting the Agents tutorial", async () => {
    const source = await readFile(resolve(docsRoot, "content/blog/2.agents.md"), "utf8")
    expect(source).toContain("node --env-file=.env dist/server.js")
  })

  it("initializes every standalone tutorial as an ESM package", async () => {
    for (const page of [
      "content/blog/2.agents.md",
      "content/docs/getting-started/first-server-primitive.md",
      "content/docs/getting-started/first-agent.md",
    ]) {
      const source = await readFile(resolve(docsRoot, page), "utf8")
      expect(source, `${page} should configure Node.js to load the built server as ESM`).toContain("pnpm pkg set type=module")
    }
  })
})
