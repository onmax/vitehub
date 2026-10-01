/** Keep confirmed deletions excluded while route and list requests settle. */
export function createConsoleInvocationDeletion() {
  const deleted = new Set<string>()
  return {
    has: (id: string) => deleted.has(id),
    exclude: <T extends { id: string }>(invocations: readonly T[]): readonly T[] => invocations.filter(invocation => !deleted.has(invocation.id)),
    async remove(id: string, actions: {
      clearSelection: () => void
      navigate: () => Promise<unknown>
      removeFromList: () => void
      refresh: () => Promise<unknown>
    }): Promise<void> {
      deleted.add(id)
      actions.clearSelection()
      try {
        await actions.navigate()
      }
      finally {
        actions.removeFromList()
        try { await actions.refresh() }
        finally { actions.removeFromList() }
      }
    },
  }
}
