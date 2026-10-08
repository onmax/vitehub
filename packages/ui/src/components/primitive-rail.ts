import { defineComponent, getCurrentInstance, h, onMounted, watch, type Component, type PropType } from "vue";
import { hasRuntimeType } from "../internal/runtime-type.ts";
import { PrimitiveIcon, type PrimitiveIconName } from "./primitive-icon.ts";

/** The narrow icon rail that ViteHub docs and the Console show at the left edge. */
export const PrimitiveRail = defineComponent({
  name: "PrimitiveRail",
  props: {
    /** Accessible name of the navigation landmark. */
    label: { required: true, type: String },
  },
  setup(props, { slots }) {
    return () =>
      h("nav", { "aria-label": props.label, class: "vh-primitive-rail" }, [
        slots.header ? h("div", { class: "vh-primitive-rail__header" }, slots.header()) : null,
        h("div", { class: "vh-primitive-rail__body" }, slots.default?.()),
        slots.footer ? h("div", { class: "vh-primitive-rail__footer" }, slots.footer()) : null,
      ]);
  },
});

/**
 * Scrolls the rail body the least amount that shows the whole item, with no animation.
 * It changes only the rail's own scroll position, never the page scroll.
 */
function revealInRail(item: Element): void {
  const body = item.closest(".vh-primitive-rail__body");
  if (!body) return;
  const itemBox = item.getBoundingClientRect();
  const bodyBox = body.getBoundingClientRect();
  if (itemBox.top < bodyBox.top) body.scrollTop -= bodyBox.top - itemBox.top;
  else if (itemBox.bottom > bodyBox.bottom) body.scrollTop += itemBox.bottom - bodyBox.bottom;
}

/** A group of rail items. A short rule separates consecutive groups. */
export const PrimitiveRailGroup = defineComponent({
  name: "PrimitiveRailGroup",
  setup(_props, { slots }) {
    return () => h("div", { class: "vh-primitive-rail__group" }, slots.default?.());
  },
});

/**
 * One square rail target. It renders a button by default. Pass a link component in `as` and its props, such as `to`,
 * as attributes. The default slot replaces the primitive icon, for example with a host icon component.
 */
export const PrimitiveRailItem = defineComponent({
  name: "PrimitiveRailItem",
  props: {
    as: {
      default: "button",
      // SAFETY: Vue's runtime constructors are paired with the element name or component union.
      type: [String, Object, Function] as PropType<string | Component>,
    },
    /** Marks the item as the current page with `aria-current="page"`. */
    current: Boolean,
    icon: {
      required: false,
      // SAFETY: Vue's runtime String constructor is paired with the closed icon name union.
      type: String as PropType<PrimitiveIconName>,
    },
    /** Accessible name. The item shows only an icon. */
    label: { required: true, type: String },
  },
  setup(props, { slots }) {
    // A long rail can hide the current item below the fold. Show it after a direct visit and after each change.
    const instance = getCurrentInstance();
    const revealIfCurrent = () => {
      const element: unknown = instance?.proxy?.$el;
      if (props.current && hasRuntimeType(globalThis.Element, "function") && element instanceof Element) revealInRail(element);
    };
    onMounted(revealIfCurrent);
    watch(() => props.current, revealIfCurrent, { flush: "post" });

    const content = () => slots.default?.() ?? (props.icon ? [h(PrimitiveIcon, { name: props.icon })] : []);
    return () => {
      const attributes = {
        "aria-current": props.current ? "page" : undefined,
        "aria-label": props.label,
        class: "vh-primitive-rail__item",
      };
      return hasRuntimeType(props.as, "string")
        ? h(props.as, { ...attributes, type: props.as === "button" ? "button" : undefined }, content())
        : h(props.as, attributes, { default: content });
    };
  },
});
