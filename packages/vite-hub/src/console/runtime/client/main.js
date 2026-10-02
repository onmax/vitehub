import ConsoleEnv from "../components/console-env.vue";
import ConsoleOAuthConnections from "../components/console-oauth-connections.vue";
import "./styles.css";
import "@vite-hub/ui/styles.css";

import ui from "@nuxt/ui/vue-plugin";
import { createViteHubUI } from "@vite-hub/ui";
import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

import ConsoleApp from "../components/console-app.vue";
import ConsoleBlob from "../components/console-blob.vue";
import ConsoleDatabase from "../components/console-database.vue";
import ConsoleDefinitions from "../components/console-definitions.vue";
import ConsoleHome from "../components/console-home.vue";
import ConsoleKv from "../components/console-kv.vue";
import {
  consoleMountBase,
  consoleDatabaseSchemaPath,
  consoleDatabaseTablePath,
  consoleDatabasesSchemaPath,
  consoleDatabasesTablePath,
} from "../console-route";
import { consoleSectionRouteName, isConsoleSectionId } from "../sections";
import App from "./app.vue";
import { createConsoleSectionLoader, loadConsoleNavigation, subscribeConsoleNavigation } from "./sections";
import { deferLucideIcons } from "./icons";

const hostBase = consoleMountBase(window.location.pathname);
const sectionsBase = `${hostBase}/api/_vitehub/console/sections`;
const capabilitiesBase = `${hostBase}/api/_vitehub/console/invocation-capabilities`;

const router = createRouter({
  history: createWebHistory(`${hostBase}/_vitehub/`),
  routes: [
    { component: ConsoleEnv, name: "vitehub-console-env", path: "/env", meta: { consoleSection: "env", title: "Env · ViteHub Console" }, props: { agentsBase: `${hostBase}/api/_vitehub/console/agents`, definitionsBase: `${hostBase}/api/_vitehub/console/definitions`, kvBase: `${hostBase}/api/_vitehub/console/kv`, envBase: `${hostBase}/api/_vitehub/console/env`, managementBase: `${hostBase}/_vitehub/env/manage`, searchBase: `${hostBase}/api/_vitehub/console/search`, sectionsBase } },
    { component: ConsoleOAuthConnections, name: "vitehub-console-connections", path: "/connections", meta: { consoleSection: "connections", title: "Connections · ViteHub Console" }, props: { agentsBase: `${hostBase}/api/_vitehub/console/agents`, definitionsBase: `${hostBase}/api/_vitehub/console/definitions`, kvBase: `${hostBase}/api/_vitehub/console/kv`, managementBase: `${hostBase}/_vitehub/connections/manage`, searchBase: `${hostBase}/api/_vitehub/console/search`, sectionsBase } },
    {
      component: ConsoleHome,
      name: "vitehub-console",
      path: "/",
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
      },
      meta: { title: "ViteHub Console" },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-agents",
      path: "/agents",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        apiBase: `${hostBase}/api/_vitehub/console/invocations`,
        capabilitiesBase,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        hostBase,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
        usageBase: `${hostBase}/api/_vitehub/console/usage`,
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-agent",
      path: "/agents/:agent",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        apiBase: `${hostBase}/api/_vitehub/console/invocations`,
        capabilitiesBase,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        hostBase,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
        usageBase: `${hostBase}/api/_vitehub/console/usage`,
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-invocation",
      path: "/agents/:agent/invocations/:invocation",
      meta: { consoleSection: "agents", title: "Agents · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        apiBase: `${hostBase}/api/_vitehub/console/invocations`,
        capabilitiesBase,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        hostBase,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
        usageBase: `${hostBase}/api/_vitehub/console/usage`,
      },
    },
    {
      component: ConsoleBlob,
      name: "vitehub-console-blob",
      path: "/blob",
      meta: { consoleSection: "blob", title: "Blob · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        blobBase: `${hostBase}/api/_vitehub/console/blob`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
      },
    },
    {
      component: ConsoleDatabase,
      name: "vitehub-console-database-schema",
      path: consoleDatabaseSchemaPath,
      meta: { consoleSection: "database", title: "Schema · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        databaseBase: `${hostBase}/api/_vitehub/console/database`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
        view: "schema",
      },
    },
    {
      component: ConsoleDatabase,
      name: "vitehub-console-database",
      path: consoleDatabaseTablePath,
      meta: { consoleSection: "database", title: "Database · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        databaseBase: `${hostBase}/api/_vitehub/console/database`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
        view: "data",
      },
    },
    {
      component: ConsoleKv,
      name: "vitehub-console-kv",
      path: "/kv",
      meta: { consoleSection: "kv", title: "KV · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
      },
    },
    {
      component: ConsoleApp,
      name: "vitehub-console-usage",
      path: "/usage",
      meta: { consoleSection: "usage", title: "Usage · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        apiBase: `${hostBase}/api/_vitehub/console/invocations`,
        capabilitiesBase,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        hostBase,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
        usageBase: `${hostBase}/api/_vitehub/console/usage`,
      },
    },
    {
      component: ConsoleDatabase,
      name: "vitehub-console-databases-schema",
      path: consoleDatabasesSchemaPath,
      meta: { consoleSection: "databases", title: "Schema · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        databaseBase: `${hostBase}/api/_vitehub/console/database`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        section: "databases",
        sectionsBase,
        view: "schema",
      },
    },
    {
      component: ConsoleDatabase,
      name: "vitehub-console-databases",
      path: consoleDatabasesTablePath,
      meta: { consoleSection: "databases", title: "Databases · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        databaseBase: `${hostBase}/api/_vitehub/console/database`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        section: "databases",
        sectionsBase,
      },
    },
    {
      component: ConsoleDefinitions,
      name: "vitehub-console-workflows",
      path: "/workflows",
      meta: { consoleSection: "workflows", title: "Workflows · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        section: "workflows",
        sectionsBase,
      },
    },
    {
      component: ConsoleDefinitions,
      name: "vitehub-console-workspaces",
      path: "/workspaces",
      meta: { consoleSection: "workspaces", title: "Workspaces · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        section: "workspaces",
        sectionsBase,
      },
    },
    {
      component: ConsoleDefinitions,
      name: "vitehub-console-sandboxes",
      path: "/sandboxes",
      meta: { consoleSection: "sandboxes", title: "Sandboxes · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        section: "sandboxes",
        sectionsBase,
      },
    },
    {
      component: ConsoleDefinitions,
      name: "vitehub-console-rate-limits",
      path: "/rate-limits",
      meta: { consoleSection: "rate-limits", title: "Rate Limits · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        section: "rate-limits",
        sectionsBase,
      },
    },
    {
      component: ConsoleDefinitions,
      name: "vitehub-console-queues",
      path: "/queues",
      meta: { consoleSection: "queues", title: "Queues · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        section: "queues",
        sectionsBase,
      },
    },
    {
      component: ConsoleDefinitions,
      name: "vitehub-console-schedules",
      path: "/schedules",
      meta: { consoleSection: "schedules", title: "Schedules · ViteHub Console" },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        scheduleRunBase: `${hostBase}/_vitehub/schedules/run`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        section: "schedules",
        sectionsBase,
      },
    },
  ],
});

const loadSections = createConsoleSectionLoader(sectionsBase);

/** Adds one route for each installed section contributed by an owner package. */
function addContributedRoutes(navigation) {
  for (const section of navigation.sections) {
    const details = navigation.contributions[section];
    const name = consoleSectionRouteName(section);
    if (!details || router.hasRoute(name)) continue;
    router.addRoute({
      component: ConsoleDefinitions,
      name,
      path: `/${section}`,
      meta: { consoleSection: section, title: `${details.label} · ViteHub Console` },
      props: {
        agentsBase: `${hostBase}/api/_vitehub/console/agents`,
        definitionsBase: `${hostBase}/api/_vitehub/console/definitions`,
        details,
        kvBase: `${hostBase}/api/_vitehub/console/kv`,
        scheduleRunBase: `${hostBase}/_vitehub/schedules/run`,
        searchBase: `${hostBase}/api/_vitehub/console/search`,
        sectionsBase,
      },
    });
  }
}
subscribeConsoleNavigation(sectionsBase, addContributedRoutes);

const preferredColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyPreferredColorScheme = ({ matches }) => {
  document.documentElement.classList.toggle("dark", matches);
};
applyPreferredColorScheme(preferredColorScheme);
preferredColorScheme.addEventListener("change", applyPreferredColorScheme);

router.beforeEach(async (to) => {
  if (to.matched.length === 0) {
    const navigation = await loadConsoleNavigation(sectionsBase);
    if (navigation) addContributedRoutes(navigation);
    return router.resolve(to.fullPath).matched.length > 0 ? to.fullPath : { name: "vitehub-console" };
  }
  const section = to.meta.consoleSection;
  if (!isConsoleSectionId(section)) return;
  void loadSections().then((installed) => {
    if (
      installed &&
      !installed.includes(section) &&
      router.currentRoute.value.fullPath === to.fullPath
    ) {
      void router.replace({ name: "vitehub-console" });
    }
  });
});

router.afterEach((to) => {
  document.title = String(to.meta.title ?? "ViteHub Console");
});
deferLucideIcons();
createApp(App)
  .use(router)
  .use(ui, { router: () => router.currentRoute.value })
  .use(createViteHubUI())
  .mount("#app");

// KaTeX styles embed their fonts. Load them after the first render instead of in the blocking stylesheet.
const loadMathStyles = () => void import("katex/dist/katex.min.css");
if ("requestIdleCallback" in window) window.requestIdleCallback(loadMathStyles, { timeout: 2_000 });
else setTimeout(loadMathStyles, 0);
