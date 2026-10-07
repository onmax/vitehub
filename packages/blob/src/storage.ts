import { handleCacheHeaders } from "h3"

import { toArray } from "@vite-hub/internal/arrays"

import { blobError, blobResult } from "./errors.ts"
import { handleBlobMultipartUpload, handleBlobUpload } from "./upload.ts"

// Generated provider runtime modules import the handlers from this entry.
export { handleBlobMultipartUpload, handleBlobUpload }

import type { BlobDriverAdapter, BlobDriverMultipartUpload, BlobListOptions, BlobMultipartUpload, BlobPutBody, BlobPutOptions, BlobStorage } from "./types.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"

// S3, R2, and Vercel Blob all accept part numbers 1 through 10000.
const maxPartNumber = 10_000

/** Give a driver's multipart upload the `[error, value]` result contract. */
export function toBlobMultipartUpload(upload: BlobDriverMultipartUpload, store: string): BlobMultipartUpload {
  return {
    pathname: upload.pathname,
    uploadId: upload.uploadId,
    abort: () => blobResult("multipart", store, () => upload.abort()),
    complete: parts => blobResult("multipart", store, () => upload.complete(parts)),
    uploadPart(partNumber, body) {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maxPartNumber) {
        throw blobErrorDiagnostics.BLOB_R0031({ message: `\`partNumber\` must be an integer from 1 to ${maxPartNumber}.` })
      }
      return blobResult("multipart", store, () => upload.uploadPart(partNumber, body))
    },
  }
}

function unsupportedMultipart(driver: BlobDriverAdapter<unknown>): Error {
  return blobErrorDiagnostics.BLOB_R0030({ message: `Blob driver "${driver.name}" does not support multipart uploads. Use the fs, cloudflare-r2, or vercel-blob driver.` })
}

function normalizePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, "")
  }
  catch {
    return pathname.replace(/^\/+/, "")
  }
}

function joinPath(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
}

// Expects pathname already normalized via normalizePathname.
function splitPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean)
  const filename = segments.pop() || ""
  const dotIndex = filename.lastIndexOf(".")

  return {
    dir: segments.join("/"),
    ext: dotIndex > 0 ? filename.slice(dotIndex) : "",
    name: dotIndex > 0 ? filename.slice(0, dotIndex) : filename,
  }
}

// Expects pathname already normalized via normalizePathname.
function guessContentType(pathname: string): string {
  const filename = pathname.split("/").pop() || ""
  const dotIndex = filename.lastIndexOf(".")
  const extension = dotIndex > 0 ? filename.slice(dotIndex).toLowerCase() : ""
  const known: Record<string, string> = {
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
  }
  return known[extension] || "application/octet-stream"
}

function normalizeBlobPath(pathname: string, options: BlobPutOptions) {
  const { dir, ext, name } = splitPath(pathname)
  const filename = options.addRandomSuffix
    ? `${name}-${globalThis.crypto.randomUUID().split("-")[0]}${ext}`
    : `${name}${ext}`
  const normalized = joinPath(dir, filename)
  return options.prefix
    ? joinPath(options.prefix, normalized)
    : normalized
}

export function createBlobStorage(driver: BlobDriverAdapter<any>, store: string = driver.name): BlobStorage {
  const pendingTransforms = new Map<string, Promise<Blob | undefined>>()
  const storage: BlobStorage = {
    async createMultipartUpload(pathname, options = {}) {
      if (!driver.createMultipartUpload) throw unsupportedMultipart(driver)
      const normalizedPath = normalizeBlobPath(normalizePathname(pathname), options)
      const contentType = options.contentType || guessContentType(normalizedPath)
      return blobResult("multipart", store, async () => toBlobMultipartUpload(
        await driver.createMultipartUpload!(normalizedPath, { ...options, contentType }),
        store,
      ))
    },
    handleMultipartUpload: (event, options) => handleBlobMultipartUpload(storage, event, options),
    handleUpload: (event, options) => handleBlobUpload(storage, event, options),
    async resumeMultipartUpload(pathname, uploadId) {
      if (!driver.resumeMultipartUpload) throw unsupportedMultipart(driver)
      const normalizedPath = normalizePathname(pathname)
      return blobResult("multipart", store, async () => toBlobMultipartUpload(
        await driver.resumeMultipartUpload!(normalizedPath, uploadId),
        store,
      ))
    },
    async del(pathnames: string | string[]) {
      const normalizedPathnames = toArray(pathnames).map(value => normalizePathname(value))
      return blobResult("del", store, async () => {
        await driver.delete(normalizedPathnames)
      })
    },
    async get(pathname: string) {
      const normalizedPathname = normalizePathname(pathname)
      return blobResult("get", store, () => driver.get(normalizedPathname))
    },
    async head(pathname: string) {
      const normalizedPathname = normalizePathname(pathname)
      const [error, meta] = await blobResult("head", store, () => driver.head(normalizedPathname))
      if (error) return [error, undefined]
      return meta
        ? [null, meta]
        : [blobError("BLOB_NOT_FOUND", "head", store), undefined]
    },
    async list(options: BlobListOptions = {}) {
      const normalizedPrefix = options.prefix ? normalizePathname(options.prefix) : options.prefix
      return blobResult("list", store, () => driver.list({
        ...options,
        prefix: normalizedPrefix,
      }))
    },
    async put(pathname: string, body: BlobPutBody, options: BlobPutOptions = {}) {
      const normalizedPath = normalizeBlobPath(normalizePathname(pathname), options)
      const contentType = options.contentType || (body instanceof Blob ? body.type : undefined) || guessContentType(normalizedPath)
      return blobResult("put", store, () => driver.put(normalizedPath, body, {
        ...options,
        contentType,
      }))
    },
    async sign(pathname, options) {
      if (!Number.isInteger(options.expiresIn) || options.expiresIn <= 0) {
        throw blobErrorDiagnostics.BLOB_R0024({ message: "`expiresIn` must be a positive integer." })
      }
      if (!driver.sign) {
        throw blobErrorDiagnostics.BLOB_R0025({ message: `Blob driver "${driver.name}" does not support signed requests.` })
      }
      const normalizedPathname = normalizePathname(pathname)
      return blobResult("sign", store, () => driver.sign!(normalizedPathname, options))
    },
    async serve(event, pathname: string, options = {}) {
      const normalizedPath = normalizePathname(pathname)
      const [error, payload] = await blobResult("serve", store, async () => {
        const meta = await driver.head(normalizedPath)
        if (!meta) return

        let etag = meta.httpEtag
        let cachePath: string | undefined
        if (options.transform) {
          const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
            normalizedPath, meta.httpEtag ?? meta.uploadedAt.toISOString(), meta.contentType, options.transform.key,
          ])))
          const fingerprint = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")
          etag = `"${fingerprint}"`
          cachePath = `_vitehub/derived/${fingerprint}`
        }

        event.res.headers.set("X-Content-Type-Options", "nosniff")
        const cacheControl = options.cacheControl ?? event.res.headers.get("Cache-Control") ?? "private, no-cache"
        event.res.headers.set("Cache-Control", cacheControl)
        if (etag) event.res.headers.set("ETag", etag)
        if (["GET", "HEAD"].includes(event.req.method) && handleCacheHeaders(event, {
          etag,
          cacheControls: [cacheControl],
        })) return null

        let body = await driver.get(cachePath ?? normalizedPath)
        const transform = options.transform
        if (!body && cachePath && transform) {
          const key = cachePath
          let pending = pendingTransforms.get(key)
          if (!pending) {
            pending = (async () => {
              const original = await driver.get(normalizedPath)
              if (!original) return
              const derived = await transform.run(original)
              await driver.put(key, derived, { access: "private", contentType: derived.type }).catch((error) => {
                console.error("[vitehub/blob] Transform cache write failed", error)
              })
              return derived
            })().finally(() => pendingTransforms.delete(key))
            pendingTransforms.set(key, pending)
          }
          body = await pending ?? null
        }
        if (!body) return
        event.res.headers.set("Content-Length", String(body.size))
        event.res.headers.set("Content-Type", transform
          ? body.type || "application/octet-stream"
          : meta.contentType || body.type || guessContentType(normalizedPath))
        return body.stream()
      })
      if (error) return [error, undefined]
      return payload === undefined
        ? [blobError("BLOB_NOT_FOUND", "serve", store), undefined]
        : [null, payload]
    },
    store() {
      throw blobErrorDiagnostics.BLOB_R0026({ message: "Named Blob stores are only available from the @vite-hub/blob runtime export." })
    },
  }
  return storage
}
