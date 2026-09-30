import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { defineAuth } from "@vite-hub/auth"
import type { AuthResolvedDefinitionOptions } from "@vite-hub/auth"

import { defineConsoleAuth, type ConsoleAuthDefinition } from "./auth.ts"
import { resolveInlineConsoleAuthGates, type InlineConsoleAuth } from "./auth-inline-config.ts"

export { resolveInlineConsoleAuthGates, type InlineConsoleAuth } from "./auth-inline-config.ts"

type GitHubProviderOptions = Exclude<NonNullable<NonNullable<AuthResolvedDefinitionOptions["socialProviders"]>["github"]>, (...args: never[]) => unknown>
type GitHubProfile = NonNullable<Awaited<ReturnType<NonNullable<GitHubProviderOptions["getUserInfo"]>>>>["data"]

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new TypeError(`[vitehub] Console Auth requires ${name}.`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- GitHub responses are untrusted JSON.
  return value !== null && typeof value === "object"
}

function isVerifiedEmail(value: unknown): value is { email: string, primary?: unknown } {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- GitHub responses are untrusted JSON.
  return isRecord(value) && value.verified === true && typeof value.email === "string" && value.email !== ""
}

// SAFETY: A GitHub /user response with a login and a numeric id. Better Auth keeps it as profile data.
function isGitHubProfile(value: unknown): value is GitHubProfile {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- GitHub responses are untrusted JSON.
  return isRecord(value) && typeof value.login === "string" && typeof value.id === "number"
}

async function githubGet(path: string, accessToken: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "vitehub-console",
      "x-github-api-version": "2022-11-28",
    },
  })
  return response.ok ? await response.json() : undefined
}

/** Admit an active member of one of `orgs` with a verified email. A primary email is preferred. */
async function githubOrgUserInfo(orgs: readonly string[], accessToken: string | undefined) {
  if (!accessToken) return null
  const profile = await githubGet("/user", accessToken)
  if (!isGitHubProfile(profile)) return null
  const memberships = await Promise.all(orgs.map(org => githubGet(`/user/memberships/orgs/${org}`, accessToken)))
  if (!memberships.some(membership => isRecord(membership) && membership.state === "active")) return null
  const emails = await githubGet("/user/emails", accessToken)
  const verified = Array.isArray(emails) ? emails.filter(isVerifiedEmail) : []
  const email = (verified.find(item => item.primary === true) ?? verified[0])?.email
  if (!email) return null
  return {
    data: profile,
    user: { email, emailVerified: true, image: profile.avatar_url, name: profile.name || profile.login },
  }
}

export function createInlineConsoleAuth(config: InlineConsoleAuth): ConsoleAuthDefinition {
  const { allowedEmails, databasePath, orgs } = resolveInlineConsoleAuthGates(config)
  mkdirSync(dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  // The database holds sessions and OAuth tokens.
  chmodSync(databasePath, 0o600)
  return defineConsoleAuth({
    auth: defineAuth(({ requestOrigin }) => {
      const github: GitHubProviderOptions = {
        clientId: requiredEnv(config.clientIdEnv ?? "GITHUB_CLIENT_ID"),
        clientSecret: requiredEnv(config.clientSecretEnv ?? "GITHUB_CLIENT_SECRET"),
      }
      if (orgs.length) github.getUserInfo = token => githubOrgUserInfo(orgs, token.accessToken)
      return {
        appName: "ViteHub Console",
        baseURL: config.baseURL ?? process.env.CONSOLE_AUTH_BASE_URL ?? requestOrigin,
        database,
        secret: requiredEnv(config.secretEnv ?? "BETTER_AUTH_SECRET"),
        session: { expiresIn: config.session?.expiresIn },
        socialProviders: { github },
      }
    }),
    // Organization membership is checked at sign-in. The session ends membership access at expiry.
    authorize: ({ user }) => user.emailVerified === true
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Better Auth user fields are extensible, so verify email is a string before comparing it with the allowlist.
      && typeof user.email === "string"
      && (!allowedEmails || allowedEmails.has(user.email.toLowerCase())),
    signIn: { provider: "github", scopes: orgs.length ? ["read:org", "user:email"] : ["user:email"] },
  })
}
