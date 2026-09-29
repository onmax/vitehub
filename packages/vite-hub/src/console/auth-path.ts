export function consoleAuthMountBase(baseURL: string): string {
  const segments = baseURL.split("/").filter(Boolean)
  return segments.length ? `/${segments.join("/")}` : ""
}

export function consoleAuthPath(baseURL: string, path: string): string {
  return `${consoleAuthMountBase(baseURL)}${path}`
}

/** Normalize a team domain or issuer URL to the Access issuer origin. */
export function cloudflareAccessIssuer(teamDomain: string): string | undefined {
  const value = teamDomain.trim().replace(/\/+$/, "")
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`)
  }
  catch {
    return undefined
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return undefined
  return url.origin
}
