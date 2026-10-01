import { Markdown, type MarkdownProps } from "@comark/vue";
import { defineComponent, h, onServerPrefetch, shallowRef, Suspense, type PropType } from "vue";
import { markdownMath } from "../internal/markdown-math.ts";
import { useViteHubUI } from "../config.ts";
import { ImagePreview } from "../internal/image-preview.ts";

type Katex = typeof import("katex").default;

let katexModule: Promise<Katex> | undefined;

// KaTeX is large, so load it with the first formula instead of with every page that renders Markdown.
function loadKatex(): Promise<Katex> {
  katexModule ??= import("katex").then(module => module.default, (error: unknown) => {
    katexModule = undefined;
    throw error;
  });
  return katexModule;
}

function renderMath(katex: Katex, content: string, displayMode: boolean): string | undefined {
  try {
    return katex.renderToString(content, { displayMode, throwOnError: true, trust: false, maxExpand: 1000 });
  } catch {
    return undefined;
  }
}

const AgentMath = defineComponent({
  name: "AgentMath",
  props: { content: { default: "", type: String }, class: { default: "", type: String } },
  setup(props) {
    const katex = shallowRef<Katex>();
    const loading = loadKatex().then(module => {
      katex.value = module;
      return module;
    }).catch(() => undefined);
    onServerPrefetch(async () => {
      await loading;
    });
    return () => {
      const displayMode = props.class.includes("block");
      const html = katex.value ? renderMath(katex.value, props.content, displayMode) : undefined;
      return html === undefined
        ? h(displayMode ? "pre" : "code", { class: "vh-math-fallback" }, props.content)
        : h(displayMode ? "div" : "span", { class: props.class, innerHTML: html });
    };
  },
});

export const AgentMarkdown = defineComponent({
  name: "AgentMarkdown",
  inheritAttrs: false,
  props: {
    components: { type: Object as PropType<MarkdownProps["components"]> },
    options: { type: Object as PropType<MarkdownProps["options"]> },
    plugins: { type: Array as PropType<MarkdownProps["plugins"]> },
    streaming: { default: false, type: Boolean },
    value: { default: "", type: String },
  },
  setup(props, { attrs }) {
    const defaults = useViteHubUI();
    return () => {
      return h(Suspense, null, {
        default: () => h(Markdown, {
          ...attrs,
          class: [defaults.markdown.class, attrs.class],
          components: { img: ImagePreview, math: AgentMath, ...props.components },
          plugins: [markdownMath, ...(props.plugins ?? [])],
          options: { ...props.options, html: false },
          streaming: props.streaming,
          value: props.value,
        }),
      });
    };
  },
});
