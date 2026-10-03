interface BrowserTimeoutOptions {
  timeoutMs?: number
  onTimeout?: (error: Error) => void
}

/** Bounds one provider operation and releases its timer after either outcome. */
export async function withBrowserTimeout<TResult>(
  operation: Promise<TResult>,
  timeoutError: () => Error,
  options: BrowserTimeoutOptions = {},
): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = timeoutError()
          options.onTimeout?.(error)
          reject(error)
        }, options.timeoutMs ?? 30_000)
      }),
    ])
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}
