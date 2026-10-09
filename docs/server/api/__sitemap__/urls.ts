import { queryCollection } from "@nuxt/content/server";
import { defineEventHandler } from "h3";
import { type SitemapEntry, sitemapUrls } from "../../utils/sitemap";

interface ContentPage {
  path: string;
  modifiedAt?: string;
  sitemap?: boolean;
}

// Replaces the Docus source: ViteHub lists docs, blog, and trust pages plus its own app pages.
export default defineEventHandler(async (event) => {
  const [docs, blog, trust] = await Promise.all([
    queryCollection(event, "docs").all(),
    queryCollection(event, "blog").all(),
    queryCollection(event, "trust").all(),
  ]);
  const entries: SitemapEntry[] = [{ path: "/" }, { path: "/blog" }, { path: "/examples" }];

  for (const page of [...docs, ...blog, ...trust] as ContentPage[]) {
    if (page.sitemap === false) continue;
    entries.push({ path: page.path, lastmod: page.modifiedAt });
  }

  return sitemapUrls(entries);
});
