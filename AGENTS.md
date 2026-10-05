# ViteHub

This is the repository for ViteHub. ViteHub gives developers Server Primitives and portable Agents with one API for every Vite host. Define an Agent in one file and run it in your own cloud.

## Current status

ViteHub is early (`vite-hub` 0.0.x). The public API still changes. Prefer the final contract over compatibility with old releases, but find the real callers before you remove a path.

## A letter from Maxi

I love to build. I try to build complex things as simply as possible. ViteHub is how I want to build Agents: simple configuration that is powerful for any task, without a heavy developer experience.

We are building this together, and I build it for you as much as for developers. Agents write most ViteHub apps. If an Agent cannot use a ViteHub API correctly on the first try, the API is wrong.

This is an ambitious project. We are building the missing server layer for the UnJS ecosystem. Do not settle for a workaround when the primitive is missing. Propose the primitive.

**Glossary**

- _you_: the coding agent that reads this file
- _we_, _us_: Maxi and the ViteHub contributors
- _developers_: our users
- _Agents_: the Agents that developers define with ViteHub

## One API for every host

We use the same standards that we use for HTTP, but we remove the network layer. A schedule, a queue, or an Agent works in any cloud. Host and provider differences belong in ViteHub, not in the developer's code.

## Lego pieces

Build pieces that fit together and that developers can enable or disable easily. When a fix helps more than one channel, host, or template, make it a ViteHub primitive and keep consumers thin. Do not build product workflows that a developer's Agent can build from our primitives.

## Fight for the obvious solution

Avoid clever code. The best API is the one an Agent would guess. Prefer inferred types, native `Response`, and the existing Vite, Nuxt, Vue, and pnpm stack. Delete wrappers and compatibility layers that do not earn their place.

## Make everything inspectable

Every runtime feature must be inspectable through code, the CLI, or the Console. The Console will be the central place for production debugging. Keep authority explicit through Capabilities, Workspace access, and Sources. Never hide durability, isolation, security, or production readiness.

## Prove it where developers feel it

A change is done when it works end to end, not when it compiles. Reproduce the failure first. Measure before and after. Test the host, provider, and configuration forms that the change affects.

## General rules

- Write short, plain English. Use ASD-STE100 language. Do not use em dashes.
- Keep one concern per change. Prefer the smallest change that makes the public contract better.
- Put shared behavior in the package that owns it. Console code inspects runtime behavior but does not own it.
- Do not use `any`.
- Work in an isolated worktree. Preserve other people's changes and inspect collisions before you edit.
- A direct request to fix, implement, commit, or open a pull request authorizes that action. Do not ask again.
- Merge, force push, deploy, or use production systems only when the task explicitly grants that action.
- Report what changed, what you verified, and what remains unverified. Use prose unless the user asks for another format.

## Read when needed

- Setup, focused checks, design, UI, releases, and pull requests: [CONTRIBUTING.md](CONTRIBUTING.md)
- Package contracts: the README of the package that you change
- Public API and examples: [vitehub.dev/llms.txt](https://vitehub.dev/llms.txt)
