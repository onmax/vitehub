#!/usr/bin/env node
import { spawn } from "node:child_process"
import { constants } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_NODE_OPTIONS = "--max-old-space-size=4096"

export function typecheckEnvironment(environment = process.env) {
  return {
    ...environment,
    ...(environment.NODE_OPTIONS === undefined ? { NODE_OPTIONS: DEFAULT_NODE_OPTIONS } : {}),
  }
}

function signalExitCode(signal) {
  return 128 + (constants.signals[signal] ?? 0)
}

function run(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: "inherit" })
    child.once("error", reject)
    child.once("close", (code, signal) => resolve(signal ? signalExitCode(signal) : (code ?? 1)))
  })
}

export async function runTypecheck(environment = process.env, execute = run) {
  const childEnvironment = typecheckEnvironment(environment)
  const vp = fileURLToPath(new URL("./bin/vp", import.meta.resolve("vite-plus/package.json")))
  const steps = [
    [process.execPath, [vp, "run", "build"]],
    [process.execPath, [vp, "run", "--filter", "vitehub-docs", "--ignore-depends-on", "typecheck"]],
    [process.execPath, ["test/run-package-task.mjs", "typecheck"]],
  ]

  for (const [command, args] of steps) {
    const exitCode = await execute(command, args, childEnvironment)
    if (exitCode !== 0) return exitCode
  }
  return 0
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    process.exitCode = await runTypecheck()
  }
  catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
