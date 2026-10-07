<script setup lang="ts">
import { computed, inject, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from "vue";
import type { Ref, VNode } from "vue";

const props = defineProps<{
  /** Add the child block(s) to the tree on mount instead of waiting for intersection. */
  default?: boolean;
  /** Register the code blocks without rendering the slot a second time on mobile. */
  registerOnly?: boolean;
}>();

const slots = defineSlots<{ default?: () => VNode[] }>();

type CodeTreeItem = { baseLabel: string; label: string; component: VNode };
type SlotRecord = { default?: () => unknown };

const target = useTemplateRef<HTMLDivElement>("target");

const tree = inject<Ref<Record<string, unknown>>>("codeTree", ref({}));
const activePath = inject<Ref<string>>("codeTreeActive", ref(""));

function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function defaultChildren(slot: VNode): VNode[] {
  const children = slot.children;
  if (Array.isArray(children)) return children.filter(isVNode);
  if (typeof children !== "object" || children === null) return [];

  const renderDefault = (children as SlotRecord).default;
  if (typeof renderDefault !== "function") return [];

  const rendered = renderDefault();
  return Array.isArray(rendered) ? rendered.filter(isVNode) : [];
}

function propString(slot: VNode, name: "filename" | "label") {
  const value = slot.props?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectCodeBlocks(slot: VNode): CodeTreeItem[] {
  const baseLabel = propString(slot, "filename") || propString(slot, "label");
  if (baseLabel) {
    return [{ baseLabel, label: baseLabel, component: slot }];
  }

  return defaultChildren(slot).flatMap((child) => collectCodeBlocks(child));
}

const children = computed(() => (slots.default?.() || []).flatMap((node) => collectCodeBlocks(node)));
const records = shallowRef<CodeTreeItem[]>([]);
const markerElements: HTMLElement[] = [];
let observer: IntersectionObserver | undefined;

function resolveRecords() {
  if (records.value.length === children.value.length) return records.value;

  const labels = new Set(Object.keys(tree.value));
  records.value = children.value.map((child, index) => {
    const previous = records.value[index];
    if (previous && previous.baseLabel === child.baseLabel) {
      labels.add(previous.label);
      return { ...child, label: previous.label };
    }

    let label = child.baseLabel;
    let suffix = 2;
    while (labels.has(label)) label = `${child.baseLabel} (${suffix++})`;
    labels.add(label);
    return { ...child, label };
  });

  return records.value;
}

function activate(index: number) {
  const child = resolveRecords()[index];
  if (!child) return;
  if (!tree.value[child.label]) tree.value[child.label] = markRaw(child.component);
  activePath.value = child.label;
}

function registerAll() {
  for (const [index] of resolveRecords().entries()) activate(index);
  const first = resolveRecords()[0];
  if (first) activePath.value = first.label;
}

function addMarkers() {
  const section = target.value?.parentElement;
  const records = resolveRecords();
  if (!section || !records.length) return false;

  const blocks = section.querySelectorAll<HTMLElement>(".code-block-wrapper").length > 0
    ? section.querySelectorAll<HTMLElement>(".code-block-wrapper")
    : section.querySelectorAll<HTMLElement>("pre:has(code)");
  if (!blocks.length) return false;

  for (const [index, block] of [...blocks].entries()) {
    const child = records[index];
    if (!child) break;

    const marker = document.createElement("span");
    marker.className = "vh-tutorial-code-marker";
    marker.dataset.vhTutorialCodeIndex = String(index);
    marker.setAttribute("aria-hidden", "true");
    block.before(marker);
    markerElements.push(marker);
    observer?.observe(marker);

    const rect = marker.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.5 && rect.bottom > 0) activate(index);
  }

  return markerElements.length > 0;
}

onMounted(async () => {
  await nextTick();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target === target.value) {
        if (markerElements.length === 0) activate(0);
        continue;
      }

      const index = Number((entry.target as HTMLElement).dataset.vhTutorialCodeIndex);
      if (Number.isInteger(index)) activate(index);
    }
  }, { rootMargin: "0px 0px -60% 0px" });

  if (target.value) observer.observe(target.value);
  if (props.default) registerAll();
  else if (!addMarkers()) registerAll();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  for (const marker of markerElements) marker.remove();
  markerElements.length = 0;
  observer = undefined;
});
</script>

<template>
  <div ref="target" class="lg:-my-2.5 lg:h-px">
    <div v-if="!registerOnly" class="lg:hidden">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.vh-tutorial-code-marker {
  display: block;
  height: 1px;
  margin: 0;
  pointer-events: none;
  visibility: hidden;
}
</style>
