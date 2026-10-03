import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Update a staged copy, then publish it with rollback on failure or cancellation. */
export async function updateRuntimePackageDirectory(options: {
  directory: string
  signal?: AbortSignal
  update: (directory: string) => Promise<void>
}): Promise<void> {
  const stagingRoot = await mkdtemp(join(dirname(options.directory), ".vitehub-runtime-packages-"))
  const stagedDirectory = join(stagingRoot, "node_modules")
  const previousDirectory = join(stagingRoot, "previous-node_modules")
  let movedPreviousOutput = false
  let installedReplacement = false
  let cleanupStagingRoot = true

  try {
    try {
      await cp(options.directory, stagedDirectory, { recursive: true })
    }
    catch (error) {
      // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await mkdir(stagedDirectory, { recursive: true })
    await options.update(stagedDirectory)
    options.signal?.throwIfAborted()

    try {
      await rename(options.directory, previousDirectory)
      movedPreviousOutput = true
      // Retain the only previous output if restoring it later fails.
      cleanupStagingRoot = false
    }
    catch (error) {
      // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    try {
      options.signal?.throwIfAborted()
      await rename(stagedDirectory, options.directory)
      installedReplacement = true
      options.signal?.throwIfAborted()
      cleanupStagingRoot = true
    }
    catch (error) {
      if (installedReplacement) await rm(options.directory, { force: true, recursive: true })
      if (movedPreviousOutput) await rename(previousDirectory, options.directory)
      cleanupStagingRoot = true
      throw error
    }
  }
  finally {
    if (cleanupStagingRoot) await rm(stagingRoot, { force: true, recursive: true })
  }
}
