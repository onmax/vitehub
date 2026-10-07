<script setup lang="ts">
import { computed, inject, onMounted, ref, useTemplateRef } from "vue";
import type { Ref, VNode } from "vue";
import { useIntersectionObserver } from "@vueuse/core";

const props = defineProps<{
  /** Add the child block(s) to the tree on mount instead of waiting for intersection. */
  default?: boolean;
  /** Register the code blocks without rendering the slot a second time on mobile. */
  registerOnly?: boolean;
}>();

const slots = defineSlots<{ default?: () => VNode[] }>();

type CodeTreeItem = { label: string; component: VNode };
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

function findCodeBlock(slot: VNode): VNode | null {
  if (propString(slot, "filename") || propString(slot, "label")) return slot;

  for (const child of defaultChildren(slot)) {
    const found = findCodeBlock(child);
    if (found) return found;
  }

  return null;
}

function collectCodeBlocks(slot: VNode, index = 0): CodeTreeItem[] {
  if (typeof slot.type === "symbol") {
    return defaultChildren(slot).flatMap((child, childIndex) => collectCodeBlocks(child, childIndex));
  }

  const codeBlock = findCodeBlock(slot);
  if (!codeBlock) return [];

  return [{
    label: propString(codeBlock, "filename") || propString(codeBlock, "label") || `${index}`,
    component: codeBlock,
  }];
}

const children = computed(() => (slots.default?.() || []).flatMap((node, index) => collectCodeBlocks(node, index)));
const registered = ref(false);

function register() {
  if (registered.value) return;
  registered.value = true;

  for (const child of children.value) {
    let label = child.label;
    let suffix = 2;
    while (tree.value[label]) label = `${child.label} (${suffix++})`;
    tree.value[label] = child.component;
    activePath.value = label;
  }
}

onMounted(() => {
  if (props.default) return register();
  const rect = target.value?.getBoundingClientRect();
  if (rect && rect.top < window.innerHeight * 0.5) register();
});

useIntersectionObserver(
  target,
  ([entry]) => {
    if (entry?.isIntersecting) register();
  },
  { rootMargin: "0px 0px -60% 0px" },
);
</script>

<template>
  <div ref="target" class="lg:-my-2.5 lg:h-px">
    <div v-if="!registerOnly" class="lg:hidden">
      <slot />
    </div>
  </div>
</template>
