<script setup lang="ts">
import { computed, inject, markRaw, onMounted, ref, shallowRef, useTemplateRef } from "vue";
import type { Ref, VNode } from "vue";
import { useIntersectionObserver } from "@vueuse/core";

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

function register() {
  const records = resolveRecords();

  for (const child of records) {
    if (!tree.value[child.label]) {
      tree.value[child.label] = markRaw(child.component);
    }
  }

  // A step can introduce several files. Show the first file in document order
  // so the code pane follows the prose instead of jumping to the last fence.
  // Set it on every intersection, including when scrolling upward through a
  // step whose files are already registered.
  if (records[0]) activePath.value = records[0].label;
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
