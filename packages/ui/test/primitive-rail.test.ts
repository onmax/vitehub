import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { PrimitiveIcon, PrimitiveRail, PrimitiveRailGroup, PrimitiveRailItem, primitiveIconNames } from "../src/primitive-rail.ts";

const render = (component: () => ReturnType<typeof h>) => renderToString(createSSRApp({ render: component }));

describe("primitive rail", () => {
  it("draws a distinct square icon for every name", async () => {
    const icons = await Promise.all(primitiveIconNames.map((name) => render(() => h(PrimitiveIcon, { name }))));
    for (const icon of icons) {
      expect(icon).toContain('viewBox="0 0 24 24"');
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain('stroke="currentColor"');
    }
    const drawings = icons.map((icon) => icon.replace(/ data-icon="[^"]+"/, ""));
    expect(new Set(drawings).size).toBe(primitiveIconNames.length);
  });

  it("names the landmark and every icon-only target", async () => {
    const link = defineComponent({
      props: { to: { required: true, type: String } },
      setup: (props, { slots }) => () => h("a", { href: props.to }, slots.default?.()),
    });
    const html = await render(() => h(PrimitiveRail, { label: "Docs sections" }, {
      default: () => [
        h(PrimitiveRailGroup, () => [
          h(PrimitiveRailItem, { as: link, current: true, icon: "kv", label: "KV", to: "/docs/kv" }),
          h(PrimitiveRailItem, { as: link, icon: "queue", label: "Queue", to: "/docs/queue" }),
        ]),
      ],
      footer: () => [h(PrimitiveRailItem, { label: "Retry" }, () => h("i", "retry"))],
    }));
    expect(html).toContain('<nav aria-label="Docs sections" class="vh-primitive-rail">');
    expect(html).toMatch(/<a href="\/docs\/kv" aria-current="page" aria-label="KV" class="vh-primitive-rail__item"><svg[^>]*data-icon="kv"/);
    expect(html).toMatch(/<a href="\/docs\/queue" aria-label="Queue" class="vh-primitive-rail__item">/);
    // A plain item is a button that does not submit a surrounding form, and its slot replaces the icon.
    expect(html).toContain('<button aria-label="Retry" class="vh-primitive-rail__item" type="button"><i>retry</i></button>');
  });
});
