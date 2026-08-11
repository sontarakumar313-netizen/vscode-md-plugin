export interface HostUpdateSafetyState {
  isComposing: boolean
  pendingEditCount: number
}

/**
 * Host content may replace Vditor's editable DOM once composition and posted
 * edits have settled. Focus itself is not a blocker because the caller restores
 * the caret after rebuilding the DOM.
 */
export function canApplyHostUpdate(
  state: HostUpdateSafetyState
): boolean {
  return !state.isComposing && state.pendingEditCount === 0
}

export function keepNewestHostUpdate<
  T extends { documentVersion: number }
>(current: T | null, incoming: T): T {
  return !current || incoming.documentVersion >= current.documentVersion
    ? incoming
    : current
}
