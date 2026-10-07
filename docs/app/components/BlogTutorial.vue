<script setup lang="ts">
import { useClipboard } from "@vueuse/core";
type Chapter = {
  id: string;
  title: string;
  summary: string;
  codeLabel: string;
  code: string;
  result: string;
};

defineProps<{
  post: {
    title?: string;
    description?: string;
    authors?: Array<Record<string, unknown>>;
    date?: string;
  };
}>();

const chapters: [Chapter, ...Chapter[]] = [
  {
    id: "choose",
    title: "Choose the job",
    summary: "A Server Primitive owns one infrastructure job. Pick the package that matches the work, then keep the provider decision in Vite config.",
    codeLabel: "server/api/notes.get.ts",
    code: `import { kv } from "vite-hub/kv"\n\nexport default defineEventHandler(async () => {\n  const [error, notes] = await kv.get("notes")\n  if (error) throw error\n  return notes\n})`,
    result: "A route imports one stable runtime helper.",
  },
  {
    id: "configure",
    title: "Configure the host",
    summary: "The Vite integration selects a driver and emits host output. Your route does not import Cloudflare, Vercel, or a provider SDK.",
    codeLabel: "vite.config.ts",
    code: `import { defineConfig } from "vite"\nimport { vitehub } from "vite-hub"\n\nexport default defineConfig({\n  plugins: [vitehub({\n    preset: "node",\n    kv: { driver: "fs-lite", base: ".vitehub/data/kv" },\n  })],\n})`,
    result: "Provider choice stays at the build boundary.",
  },
  {
    id: "call",
    title: "Call it from a request",
    summary: "The first proof is a write followed by a read. Start with a local driver so the behavior is visible before you add hosted credentials.",
    codeLabel: "src/server.ts",
    code: `const [writeError] = await kv.set("settings", { theme: "system" })\nif (writeError) throw writeError\n\nconst [readError, settings] = await kv.get("settings")\nif (readError) throw readError\nreturn { settings }`,
    result: `{ "settings": { "theme": "system" } }`,
  },
  {
    id: "inspect",
    title: "Inspect the result",
    summary: "Build output and the Console show what ViteHub discovered and which provider output it generated. The UI is a view, not the only inspection path.",
    codeLabel: "Terminal",
    code: `pnpm vite build\npnpm vitehub inspect definitions\npnpm vitehub inspect provider-output`,
    result: "The definition, source file, and generated host output are inspectable.",
  },
  {
    id: "compose",
    title: "Compose primitives",
    summary: "Once one call works, compose packages by responsibility. A Schedule can enqueue a Queue job, while an Agent can use the same primitives through Capabilities.",
    codeLabel: "server/schedules/daily.ts",
    code: `import { defineSchedule } from "vite-hub/schedule"\nimport { runQueue } from "vite-hub/queue"\n\nexport default defineSchedule({\n  cron: "0 8 * * *",\n  handler: () => runQueue("daily-report", { scope: "all" }),\n})`,
    result: "Each package keeps its own contract while the app composes them.",
  },
];

const active = ref(0);
const current = computed(() => chapters[active.value] || chapters[0]);
const { copy, copied } = useClipboard({ copiedDuring: 1600, legacy: true });

function formattedDate(date?: string) {
  if (!date) return "";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(date));
}
</script>

<template>
  <main class="vh-tutorial">
    <header class="vh-tutorial-header">
      <div>
        <NuxtLink to="/blog" class="vh-tutorial-back"><UIcon name="i-lucide-arrow-left" class="size-4" /> Tutorials</NuxtLink>
        <p class="vh-tutorial-kicker">Server Primitives</p>
        <h1>{{ post.title }}</h1>
        <p class="vh-tutorial-description">{{ post.description }}</p>
      </div>
      <div class="vh-tutorial-meta">
        <span>One path, one working result</span>
        <span v-if="post.date">{{ formattedDate(post.date) }}</span>
        <span v-if="post.authors?.length">By {{ String(post.authors[0]?.name || "") }}</span>
      </div>
    </header>

    <div class="vh-tutorial-grid">
      <nav class="vh-tutorial-chapters" aria-label="Tutorial chapters">
        <p class="vh-tutorial-nav-label">Build with a Server Primitive</p>
        <button
          v-for="(chapter, index) in chapters"
          :key="chapter.id"
          type="button"
          :class="['vh-tutorial-chapter', { 'is-active': index === active }]"
          :aria-pressed="index === active"
          @click="active = index"
        >
          <span class="vh-tutorial-chapter-number">0{{ index + 1 }}</span>
          <span>{{ chapter.title }}</span>
        </button>
        <NuxtLink to="/docs" class="vh-tutorial-catalog">Browse the package docs <UIcon name="i-lucide-arrow-up-right" class="size-4" /></NuxtLink>
      </nav>

      <article class="vh-tutorial-copy">
        <p class="vh-tutorial-step">Step {{ String(active + 1).padStart(2, "0") }}</p>
        <h2>{{ current.title }}</h2>
        <p>{{ current.summary }}</p>
        <div class="vh-tutorial-result">
          <UIcon name="i-lucide-check" class="size-4 shrink-0" />
          <span>{{ current.result }}</span>
        </div>
        <div class="vh-tutorial-next">
          <span>Next</span>
          <button v-if="active < chapters.length - 1" type="button" @click="active += 1">{{ chapters[active + 1]?.title }} <UIcon name="i-lucide-arrow-right" class="size-4" /></button>
          <NuxtLink v-else to="/docs/getting-started/server-primitives">Open Server Primitives <UIcon name="i-lucide-arrow-right" class="size-4" /></NuxtLink>
        </div>
      </article>

      <aside class="vh-tutorial-code" aria-label="Code for this chapter">
        <div class="vh-tutorial-code-head">
          <span>{{ current.codeLabel }}</span>
          <button
            type="button"
            class="vh-tutorial-copy-button"
            :aria-label="copied ? 'Code copied' : 'Copy code'"
            :title="copied ? 'Code copied' : 'Copy code'"
            @click="copy(current.code)"
          >
            <UIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" class="size-4" />
          </button>
        </div>
        <pre><code>{{ current.code }}</code></pre>
      </aside>
    </div>

    <section class="vh-tutorial-full docs-content blog-content">
      <p class="vh-tutorial-step">Complete walkthrough</p>
      <h2>Build the working KV example</h2>
      <ContentRenderer :value="post" />
    </section>
  </main>
</template>

<style scoped>
.vh-tutorial { max-width: 90rem; margin: 0 auto; padding: 2rem 1rem 6rem; }
.vh-tutorial-header { display: flex; justify-content: space-between; gap: 2rem; border-bottom: 1px solid var(--ui-border); padding: 1rem 0 3rem; }
.vh-tutorial-back { display: inline-flex; align-items: center; gap: .4rem; color: var(--ui-text-muted); font-size: .8125rem; }
.vh-tutorial-kicker { margin: 2.5rem 0 .75rem; color: var(--ui-primary); font: 600 .6875rem/1 var(--font-mono, ui-monospace); letter-spacing: .12em; text-transform: uppercase; }
.vh-tutorial h1 { max-width: 14ch; margin: 0; color: var(--ui-text-highlighted); font-size: clamp(2.25rem, 5vw, 4.5rem); letter-spacing: -.045em; line-height: .98; }
.vh-tutorial-description { max-width: 42rem; margin: 1.25rem 0 0; color: var(--ui-text-muted); font-size: 1.125rem; line-height: 1.7; }
.vh-tutorial-meta { display: flex; flex-direction: column; justify-content: flex-end; gap: .35rem; color: var(--ui-text-dimmed); font-size: .75rem; text-align: right; }
.vh-tutorial-grid { display: grid; grid-template-columns: 13rem minmax(0, 1fr) minmax(20rem, 1fr); gap: 2.5rem; padding-top: 2.5rem; }
.vh-tutorial-chapters { display: flex; flex-direction: column; gap: .25rem; }
.vh-tutorial-nav-label, .vh-tutorial-step { margin: 0 0 .8rem; color: var(--ui-text-dimmed); font: 600 .6875rem/1.2 var(--font-mono, ui-monospace); letter-spacing: .1em; text-transform: uppercase; }
.vh-tutorial-chapter { display: flex; align-items: baseline; gap: .65rem; border-left: 1px solid var(--ui-border); padding: .55rem .7rem; color: var(--ui-text-muted); font-size: .8125rem; text-align: left; }
.vh-tutorial-chapter:hover, .vh-tutorial-chapter.is-active { border-left-color: var(--ui-text-highlighted); color: var(--ui-text-highlighted); }
.vh-tutorial-chapter-number { color: var(--ui-text-dimmed); font: .6875rem var(--font-mono, ui-monospace); }
.vh-tutorial-catalog { display: inline-flex; align-items: center; gap: .35rem; margin-top: 2rem; color: var(--ui-text-dimmed); font-size: .75rem; }
.vh-tutorial-copy { max-width: 38rem; padding-top: 1.5rem; }
.vh-tutorial-copy h2 { margin: 0; color: var(--ui-text-highlighted); font-size: clamp(1.75rem, 3vw, 2.5rem); letter-spacing: -.035em; }
.vh-tutorial-copy > p:not(.vh-tutorial-step) { margin: 1rem 0 0; color: var(--ui-text-muted); font-size: 1.0625rem; line-height: 1.8; }
.vh-tutorial-result { display: flex; gap: .6rem; margin-top: 2rem; border-top: 1px solid var(--ui-border); border-bottom: 1px solid var(--ui-border); padding: 1rem 0; color: var(--ui-text); font-size: .875rem; }
.vh-tutorial-result .size-4 { color: var(--ui-primary); }
.vh-tutorial-next { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 2.5rem; color: var(--ui-text-dimmed); font-size: .75rem; }
.vh-tutorial-next button, .vh-tutorial-next a { display: inline-flex; align-items: center; gap: .4rem; color: var(--ui-text-highlighted); font-size: .8125rem; }
.vh-tutorial-code { position: sticky; top: 5rem; align-self: start; overflow: hidden; border: 1px solid var(--ui-border); background: var(--ui-bg-muted); }
.vh-tutorial-code-head { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--ui-border); padding: .65rem .8rem; color: var(--ui-text-muted); font: .6875rem var(--font-mono, ui-monospace); }
.vh-tutorial-copy-button { display: inline-flex; color: var(--ui-text-dimmed); }
.vh-tutorial-copy-button:hover, .vh-tutorial-copy-button:focus-visible { color: var(--ui-text-highlighted); }
.vh-tutorial-code pre { min-height: 18rem; margin: 0; overflow: auto; padding: 1.25rem; color: var(--ui-text); font: .75rem/1.7 var(--font-mono, ui-monospace); }
.vh-tutorial-full { max-width: 54rem; margin-top: 5rem; border-top: 1px solid var(--ui-border); padding-top: 3rem; }
.vh-tutorial-full h2 { margin: 0 0 1.5rem; color: var(--ui-text-highlighted); font-size: 1.75rem; letter-spacing: -.035em; }
@media (max-width: 64rem) { .vh-tutorial-grid { grid-template-columns: 11rem minmax(0, 1fr) minmax(18rem, .9fr); gap: 1.5rem; } }
@media (max-width: 48rem) { .vh-tutorial { padding-inline: 1rem; } .vh-tutorial-header { flex-direction: column; padding-bottom: 2rem; } .vh-tutorial-meta { flex-direction: row; justify-content: flex-start; text-align: left; } .vh-tutorial-grid { grid-template-columns: 1fr; gap: 1.5rem; } .vh-tutorial-chapters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } .vh-tutorial-nav-label, .vh-tutorial-catalog { grid-column: 1 / -1; } .vh-tutorial-code { position: static; } }
</style>
