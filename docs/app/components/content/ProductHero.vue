<script setup lang="ts">
// `::product-hero` opens a product landing page. The copy comes from the page frontmatter and the
// section manifest. The default slot renders in the right column: a `::code-group` with the real
// examples that prove the claims on the page, or an interactive component.
import { docsManifest, getDocsPageByPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { getDocsSectionForPath, getDocsSectionSubpages } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const props = defineProps<{
  /** One sentence of 20 words or fewer, shown instead of the frontmatter description. */
  tagline?: string;
  /** Comma-separated providers or hosts the primitive runs on, in the order the docs list them. */
  providers?: string;
}>();

const route = useRoute();
const page = computed(() => getDocsPageByPath(route.path));
const section = computed(() => getDocsSectionForPath(docsManifest.sections, route.path));
const subpages = computed(() => section.value ? getDocsSectionSubpages(section.value) : []);
const getStarted = computed(() => subpages.value.find(candidate => candidate.id === "get-started") ?? subpages.value[0]);
const serverApi = computed(() => subpages.value.find(candidate => candidate.id === "server-api"));

/** Brand icons for the providers row. Unknown names get a neutral mark. */
const providerIcons = new Map([
  ["cloudflare", "i-simple-icons-cloudflare"],
  ["cloudflare d1", "i-simple-icons-cloudflare"],
  ["cloudflare r2", "i-simple-icons-cloudflare"],
  ["cloudflare kv", "i-simple-icons-cloudflare"],
  ["durable objects", "i-simple-icons-cloudflare"],
  ["vercel", "i-simple-icons-vercel"],
  ["vercel blob", "i-simple-icons-vercel"],
  ["netlify", "i-simple-icons-netlify"],
  ["netlify blobs", "i-simple-icons-netlify"],
  ["deno", "i-simple-icons-deno"],
  ["deno kv", "i-simple-icons-deno"],
  ["node", "i-simple-icons-nodedotjs"],
  ["docker", "i-simple-icons-docker"],
  ["upstash", "i-simple-icons-upstash"],
  ["sqlite", "i-simple-icons-sqlite"],
  ["libsql", "i-simple-icons-turso"],
  ["turso", "i-simple-icons-turso"],
  ["s3", "i-simple-icons-amazons3"],
  ["google cloud storage", "i-simple-icons-googlecloud"],
  ["azure blob storage", "i-simple-icons-microsoftazure"],
  ["supabase", "i-simple-icons-supabase"],
  ["supabase storage", "i-simple-icons-supabase"],
  ["resend", "i-simple-icons-resend"],
  ["github", "i-simple-icons-github"],
  ["slack", "i-simple-icons-slack"],
  ["discord", "i-simple-icons-discord"],
  ["telegram", "i-simple-icons-telegram"],
  ["teams", "i-simple-icons-microsoftteams"],
  ["gmail", "i-simple-icons-gmail"],
  ["google", "i-simple-icons-google"],
  ["openai", "i-simple-icons-openai"],
  ["codex", "i-simple-icons-openai"],
  ["claude code", "i-simple-icons-anthropic"],
  ["nuxt", "i-simple-icons-nuxt"],
  ["vite", "i-simple-icons-vite"],
  ["mcp", "i-lucide-plug"],
  ["http", "i-lucide-globe"],
  ["web chat", "i-lucide-message-square"],
  ["local", "i-lucide-hard-drive"],
  ["file system", "i-lucide-hard-drive"],
  ["fs", "i-lucide-hard-drive"],
  ["memory", "i-lucide-cpu"],
  ["process", "i-lucide-cpu"],
]);

const providers = computed(() =>
  (props.providers ?? "")
    .split(",")
    .map(name => name.trim())
    .filter(Boolean)
    .map(name => ({ name, icon: providerIcons.get(name.toLowerCase()) ?? "i-lucide-box" })),
);
</script>

<template>
  <header class="not-prose vh-hero">
    <div class="vh-hero-copy">
      <h1 class="vh-hero-title">{{ page?.sourceTitle || page?.title }}</h1>
      <p class="vh-hero-tagline">{{ tagline || page?.description }}</p>

      <div class="vh-hero-actions">
        <NuxtLink v-if="getStarted" :to="getStarted.path" class="vh-hero-cta group">
          {{ getStarted.title }}
          <UIcon name="i-lucide-arrow-right" class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink v-if="serverApi" :to="serverApi.path" class="vh-hero-secondary">
          {{ serverApi.title }}
        </NuxtLink>
      </div>

      <ul v-if="providers.length" class="vh-hero-providers" aria-label="Runs on">
        <li v-for="provider in providers" :key="provider.name" class="vh-hero-provider">
          <UIcon :name="provider.icon" class="size-3.5 shrink-0" aria-hidden="true" />
          <span>{{ provider.name }}</span>
        </li>
      </ul>
    </div>

    <div class="vh-hero-panel">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.vh-hero {
  display: grid;
  gap: 2.5rem;
  align-items: center;
  padding: 2.5rem 0 1.5rem;
}

@media (min-width: 64rem) {
  .vh-hero {
    grid-template-columns: minmax(20rem, 0.75fr) minmax(0, 1.25fr);
    gap: 4rem;
    padding: 4rem 0 2rem;
  }
}

.vh-hero-title {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: clamp(3rem, 5vw, 4.5rem);
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1;
  text-wrap: balance;
}

.vh-hero-tagline {
  max-width: 42ch;
  margin: 1.5rem 0 0;
  color: var(--ui-text-muted);
  font-size: 1.125rem;
  line-height: 1.75rem;
  text-wrap: pretty;
}

.vh-hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1.25rem;
  margin-top: 2rem;
}

.vh-hero-cta {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  gap: 0.375rem;
  background: var(--ui-text-highlighted);
  padding: 0 1rem;
  color: var(--ui-bg);
  font-size: 0.875rem;
  font-weight: 500;
  transition: transform 120ms ease;
}

.vh-hero-cta:active {
  transform: scale(0.96);
}

.vh-hero-cta:hover .landing-cta-arrow {
  transform: translateX(0.25rem);
}

.vh-hero-secondary {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  font-weight: 500;
  transition: color 150ms ease;
}

.vh-hero-secondary:hover {
  color: var(--ui-text-highlighted);
}

/* Providers read as a fact row: mono, muted, no chips. */
.vh-hero-providers {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  margin: 2rem 0 0;
  padding: 0;
  list-style: none;
}

.vh-hero-provider {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.vh-hero-panel {
  min-width: 0;
}

.vh-hero-panel :deep(> *) {
  margin: 0;
}

.vh-hero-panel :deep(pre) {
  font-size: 0.8125rem;
  line-height: 1.75;
}

@media (prefers-reduced-motion: reduce) {
  .vh-hero-cta {
    transition: none;
  }
}
</style>
