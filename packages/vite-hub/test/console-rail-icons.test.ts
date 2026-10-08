// @vitest-environment ./test/support/client-renderer-environment.ts
import { createRenderer, defineComponent, h, nextTick } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@nuxt/ui/composables", () => ({ defineShortcuts: vi.fn() }))
vi.mock("@vite-hub/auth/vue", () => ({ createAuthClient: vi.fn() }))
vi.mock("vue-router", () => ({
  useRoute: () => ({ name: "vitehub-console", params: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock("../src/console/runtime/client/request", () => ({
  requestConsole: async () => ({
    auth: false,
    contributions: [{
      description: "Inspect custom definitions.",
      icon: "i-lucide-sparkles",
      id: "custom",
      label: "Custom",
      view: { kind: "definition-catalog", notice: "Read-only." },
    }],
    sections: ["kv", "custom"],
  }),
}))

import Rail from "../src/console/runtime/components/console-rail.vue"

/** A host node that records the rendered tree, so the test reads what the rail really renders. */
interface TestNode {
  children: TestNode[]
  parent?: TestNode
  props: Record<string, unknown>
  tag: string
  text?: string
}

const node = (tag: string, text?: string): TestNode => ({ children: [], props: {}, tag, text })

function detach(child: TestNode): void {
  const siblings = child.parent?.children
  if (siblings) siblings.splice(siblings.indexOf(child), 1)
  child.parent = undefined
}

const renderer = createRenderer<TestNode, TestNode>({
  createComment: text => node("#comment", text),
  createElement: tag => node(tag),
  createText: text => node("#text", text),
  insert(child, parent, anchor) {
    detach(child)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index >= 0) parent.children.splice(index, 0, child)
    else parent.children.push(child)
    child.parent = parent
  },
  nextSibling(target) {
    const siblings = target.parent?.children ?? []
    return siblings[siblings.indexOf(target) + 1] ?? null
  },
  parentNode: target => target.parent ?? null,
  patchProp(element, key, _previous, next) { element.props[key] = next },
  remove: detach,
  setElementText(element, text) {
    element.children = text ? [{ ...node("#text", text), parent: element }] : []
  },
  setText(target, text) { target.text = text },
})

function find(root: TestNode, match: (candidate: TestNode) => boolean): TestNode | undefined {
  if (match(root)) return root
  for (const child of root.children) {
    const found = find(child, match)
    if (found) return found
  }
  return undefined
}

afterEach(() => { vi.unstubAllGlobals() })

describe("Console rail icons", () => {
  it("renders the shared icon for a known primitive and the descriptor icon for a contributed section", async () => {
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("document", { activeElement: null })
    const root = node("root")
    const app = renderer.createApp(Rail, { sectionsBase: "/sections" })
    // Tooltips must render their default slot so the test mounts the real rail items inside them.
    app.component("UTooltip", defineComponent({
      setup(_props, { slots }) { return () => h("div", slots.default?.()) },
    }))
    // Other Nuxt UI components render as plain elements that keep their props.
    app.config.warnHandler = () => {}
    app.mount(root)
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      await nextTick()

      const kv = find(root, candidate => candidate.tag === "button" && candidate.props["aria-label"] === "KV")
      expect(kv).toBeDefined()
      const kvIcon = find(kv!, candidate => candidate.tag === "svg")
      expect(kvIcon?.props["data-icon"]).toBe("kv")
      expect(find(kv!, candidate => candidate.tag === "UIcon")).toBeUndefined()

      const custom = find(root, candidate => candidate.tag === "button" && candidate.props["aria-label"] === "Custom")
      expect(custom).toBeDefined()
      expect(find(custom!, candidate => candidate.tag === "UIcon")?.props.name).toBe("i-lucide-sparkles")
      expect(find(custom!, candidate => candidate.tag === "svg")).toBeUndefined()
    }
    finally { app.unmount() }
  })
})
