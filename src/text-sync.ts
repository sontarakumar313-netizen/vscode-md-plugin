export interface MinimalTextEdit {
  start: number
  end: number
  text: string
}

export interface TextChange extends MinimalTextEdit {}

export type ThreeWayMergeResult =
  | { kind: 'merged'; content: string }
  | { kind: 'conflict'; local: TextChange; remote: TextChange }

export interface LocalPreferredMergeResult {
  kind: 'merged'
  content: string
  discardedRemoteChanges: TextChange[]
}

interface TextLine {
  text: string
  start: number
  end: number
  index: number
}

interface LineAnchor {
  base: TextLine
  target: TextLine
}

/**
 * Computes the smallest single replacement that turns `before` into `after`.
 * VS Code positions and JavaScript string offsets both use UTF-16 code units.
 */
export function computeMinimalTextEdit(
  before: string,
  after: string
): MinimalTextEdit | undefined {
  if (before === after) return undefined

  const maxPrefix = Math.min(before.length, after.length)
  let start = 0
  while (start < maxPrefix && before[start] === after[start]) start += 1

  let beforeEnd = before.length
  let afterEnd = after.length
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }

  return {
    start,
    end: beforeEnd,
    text: after.slice(start, afterEnd),
  }
}

function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = []
  let start = 0
  let index = 0
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] !== '\n') continue
    lines.push({
      text: text.slice(start, offset + 1),
      start,
      end: offset + 1,
      index,
    })
    start = offset + 1
    index += 1
  }
  if (start < text.length) {
    lines.push({
      text: text.slice(start),
      start,
      end: text.length,
      index,
    })
  }
  return lines
}

function countLines(lines: TextLine[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    counts.set(line.text, (counts.get(line.text) || 0) + 1)
  }
  return counts
}

/**
 * Finds unchanged unique lines in the same order (a patience-diff anchor set).
 * This splits distant edits without the memory cost of a character-level LCS.
 */
function findLineAnchors(base: string, target: string): LineAnchor[] {
  const baseLines = splitLines(base)
  const targetLines = splitLines(target)
  const baseCounts = countLines(baseLines)
  const targetCounts = countLines(targetLines)
  const uniqueTarget = new Map<string, TextLine>()

  for (const line of targetLines) {
    if (targetCounts.get(line.text) === 1) uniqueTarget.set(line.text, line)
  }

  const candidates: LineAnchor[] = []
  for (const line of baseLines) {
    if (baseCounts.get(line.text) !== 1) continue
    const targetLine = uniqueTarget.get(line.text)
    if (targetLine) candidates.push({ base: line, target: targetLine })
  }
  if (candidates.length < 2) return candidates

  // Longest increasing subsequence of target line numbers keeps anchors that
  // occur in the same order on both sides.
  const predecessors = new Array<number>(candidates.length).fill(-1)
  const pileTops: number[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    const targetIndex = candidates[index].target.index
    let low = 0
    let high = pileTops.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (candidates[pileTops[middle]].target.index < targetIndex) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    if (low > 0) predecessors[index] = pileTops[low - 1]
    pileTops[low] = index
  }

  const anchors: LineAnchor[] = []
  let candidateIndex = pileTops[pileTops.length - 1]
  while (candidateIndex >= 0) {
    anchors.push(candidates[candidateIndex])
    candidateIndex = predecessors[candidateIndex]
  }
  anchors.reverse()
  return anchors
}

interface TextToken {
  value: string
  start: number
  end: number
}

interface DiffBudget {
  remaining: number
}

type DiffOperation =
  | { kind: 'equal'; value: string }
  | { kind: 'delete'; value: string }
  | { kind: 'insert'; value: string }

function tokenizeText(text: string): TextToken[] {
  const tokens: TextToken[] = []
  let offset = 0
  for (const value of text) {
    const start = offset
    offset += value.length
    tokens.push({ value, start, end: offset })
  }
  return tokens
}

function spendBudget(budget: DiffBudget): boolean {
  if (budget.remaining <= 0) return false
  budget.remaining -= 1
  return true
}

function spendBudgetAmount(budget: DiffBudget, amount: number): boolean {
  if (budget.remaining < amount) return false
  budget.remaining -= amount
  return true
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  )
}

function surrogateSafeMinimalChange(
  base: string,
  target: string
): TextChange | undefined {
  const change = computeMinimalTextEdit(base, target)
  if (!change) return undefined

  let start = change.start
  let baseEnd = change.end
  let targetEnd = change.start + change.text.length
  if (splitsSurrogatePair(base, start) || splitsSurrogatePair(target, start)) {
    start -= 1
  }
  if (splitsSurrogatePair(base, baseEnd)) baseEnd += 1
  if (splitsSurrogatePair(target, targetEnd)) targetEnd += 1
  return { start, end: baseEnd, text: target.slice(start, targetEnd) }
}

function layerValue(
  layer: Int32Array,
  distance: number,
  diagonal: number
): number {
  if (
    diagonal < -distance ||
    diagonal > distance ||
    (diagonal + distance) % 2 !== 0
  ) {
    return -1
  }
  return layer[(diagonal + distance) / 2]
}

function backtrackMyers(
  trace: Int32Array[],
  distance: number,
  base: TextToken[],
  target: TextToken[],
  budget: DiffBudget
): DiffOperation[] | undefined {
  let baseIndex = base.length
  let targetIndex = target.length
  const reversed: DiffOperation[] = []

  for (let currentDistance = distance; currentDistance > 0; currentDistance -= 1) {
    if (!spendBudget(budget)) return undefined
    const previous = trace[currentDistance - 1]
    const diagonal = baseIndex - targetIndex
    const previousDiagonal =
      diagonal === -currentDistance ||
      (diagonal !== currentDistance &&
        layerValue(previous, currentDistance - 1, diagonal - 1) <
          layerValue(previous, currentDistance - 1, diagonal + 1))
        ? diagonal + 1
        : diagonal - 1
    const previousBaseIndex = layerValue(
      previous,
      currentDistance - 1,
      previousDiagonal
    )
    const previousTargetIndex = previousBaseIndex - previousDiagonal

    while (
      baseIndex > previousBaseIndex &&
      targetIndex > previousTargetIndex
    ) {
      if (!spendBudget(budget)) return undefined
      baseIndex -= 1
      targetIndex -= 1
      reversed.push({ kind: 'equal', value: base[baseIndex].value })
    }

    if (baseIndex === previousBaseIndex) {
      targetIndex -= 1
      reversed.push({ kind: 'insert', value: target[targetIndex].value })
    } else {
      baseIndex -= 1
      reversed.push({ kind: 'delete', value: base[baseIndex].value })
    }
  }

  while (baseIndex > 0 && targetIndex > 0) {
    if (!spendBudget(budget)) return undefined
    baseIndex -= 1
    targetIndex -= 1
    reversed.push({ kind: 'equal', value: base[baseIndex].value })
  }
  if (baseIndex !== 0 || targetIndex !== 0) return undefined

  reversed.reverse()
  return reversed
}

/**
 * Computes a shortest edit script within a deterministic operation budget.
 * Code points are compared as tokens so emitted UTF-16 offsets never split a
 * surrogate pair. Trace cells, forward snakes, and backtracking all spend from
 * the same budget.
 */
function computeMyersOperations(
  base: TextToken[],
  target: TextToken[],
  budget: DiffBudget
): DiffOperation[] | undefined {
  const maximumDistance = base.length + target.length
  let previous = new Int32Array(0)
  const trace: Int32Array[] = []

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    const current = new Int32Array(distance + 1)
    current.fill(-1)

    for (let index = 0; index <= distance; index += 1) {
      if (!spendBudget(budget)) return undefined
      const diagonal = -distance + index * 2
      let baseIndex: number
      if (distance === 0) {
        baseIndex = 0
      } else if (
        diagonal === -distance ||
        (diagonal !== distance &&
          layerValue(previous, distance - 1, diagonal - 1) <
            layerValue(previous, distance - 1, diagonal + 1))
      ) {
        baseIndex = layerValue(previous, distance - 1, diagonal + 1)
      } else {
        baseIndex = layerValue(previous, distance - 1, diagonal - 1) + 1
      }
      let targetIndex = baseIndex - diagonal

      while (baseIndex < base.length && targetIndex < target.length) {
        if (!spendBudget(budget)) return undefined
        if (base[baseIndex].value !== target[targetIndex].value) break
        baseIndex += 1
        targetIndex += 1
      }
      current[index] = baseIndex

      if (baseIndex >= base.length && targetIndex >= target.length) {
        trace.push(current)
        return backtrackMyers(trace, distance, base, target, budget)
      }
    }

    trace.push(current)
    previous = current
  }

  return undefined
}

function codePointMinimalChange(
  base: string,
  target: string
): {
  change: TextChange
  baseTokens: TextToken[]
  targetTokens: TextToken[]
  prefixLength: number
  baseCoreEnd: number
  targetCoreEnd: number
} | undefined {
  if (base === target) return undefined
  const baseTokens = tokenizeText(base)
  const targetTokens = tokenizeText(target)
  const maximumPrefix = Math.min(baseTokens.length, targetTokens.length)
  let prefixLength = 0
  while (
    prefixLength < maximumPrefix &&
    baseTokens[prefixLength].value === targetTokens[prefixLength].value
  ) {
    prefixLength += 1
  }

  let baseCoreEnd = baseTokens.length
  let targetCoreEnd = targetTokens.length
  while (
    baseCoreEnd > prefixLength &&
    targetCoreEnd > prefixLength &&
    baseTokens[baseCoreEnd - 1].value ===
      targetTokens[targetCoreEnd - 1].value
  ) {
    baseCoreEnd -= 1
    targetCoreEnd -= 1
  }

  const start =
    prefixLength < baseTokens.length
      ? baseTokens[prefixLength].start
      : base.length
  const end =
    baseCoreEnd < baseTokens.length
      ? baseTokens[baseCoreEnd].start
      : base.length
  const targetStart =
    prefixLength < targetTokens.length
      ? targetTokens[prefixLength].start
      : target.length
  const targetEnd =
    targetCoreEnd < targetTokens.length
      ? targetTokens[targetCoreEnd].start
      : target.length

  return {
    change: { start, end, text: target.slice(targetStart, targetEnd) },
    baseTokens,
    targetTokens,
    prefixLength,
    baseCoreEnd,
    targetCoreEnd,
  }
}

function operationsToChanges(
  operations: DiffOperation[],
  baseTokens: TextToken[],
  baseEnd: number
): TextChange[] {
  const changes: TextChange[] = []
  let baseIndex = 0
  let pending: TextChange | undefined

  const flush = () => {
    if (!pending) return
    changes.push(pending)
    pending = undefined
  }

  for (const operation of operations) {
    if (operation.kind === 'equal') {
      flush()
      baseIndex += 1
      continue
    }

    if (!pending) {
      const start =
        baseIndex < baseTokens.length ? baseTokens[baseIndex].start : baseEnd
      pending = { start, end: start, text: '' }
    }

    if (operation.kind === 'delete') {
      pending.end = baseTokens[baseIndex].end
      baseIndex += 1
    } else {
      pending.text += operation.value
    }
  }
  flush()
  return changes
}

function markdownSemanticLineKey(line: string): string {
  const content = line.replace(/\r?\n$/, '')
  const task = content.match(/^\s*[-+*]\s+\[([ xX])\]\s*(.*?)\s*$/)
  if (task) {
    // Lute changes task-list markers, checkbox case, indentation and spacing.
    // Preserve the task body byte-for-byte: punctuation can be meaningful code
    // or prose and must never be discarded as if it were Markdown decoration.
    return JSON.stringify([
      'task',
      task[1] === ' ' ? 'unchecked' : 'checked',
      task[2],
    ])
  }

  // Outside the one syntax family whose canonicalisation is explicitly known,
  // prove only whitespace-equivalence. Keeping punctuation and letter case in
  // the key prevents structural shifts such as `x + 1` / `x - 1` from looking
  // like harmless formatting changes.
  const compact = content.replace(/\s/g, '')
  return compact ? JSON.stringify(['plain', compact]) : ''
}

function refineCorrespondingLines(
  base: string,
  target: string
): TextChange[] | undefined {
  const baseLines = splitLines(base)
  const targetLines = splitLines(target)
  if (baseLines.length < 2 || baseLines.length !== targetLines.length) {
    return undefined
  }

  const changes: TextChange[] = []
  for (let index = 0; index < baseLines.length; index += 1) {
    const baseLine = baseLines[index]
    const targetLine = targetLines[index]
    const change = surrogateSafeMinimalChange(baseLine.text, targetLine.text)
    if (!change) continue

    // Equal line counts can hide an insertion at one end and deletion at the
    // other. Positional refinement is safe only when every changed line keeps
    // the same non-empty semantic payload after Markdown formatting is removed.
    const baseKey = markdownSemanticLineKey(baseLine.text)
    if (!baseKey || baseKey !== markdownSemanticLineKey(targetLine.text)) {
      return undefined
    }
    changes.push({
      start: baseLine.start + change.start,
      end: baseLine.start + change.end,
      text: change.text,
    })
  }
  return changes
}

function refineTextSegment(
  base: string,
  target: string,
  budget: DiffBudget,
  allowCorrespondingLineFallback: boolean
): TextChange[] {
  const coarse = surrogateSafeMinimalChange(base, target)
  if (!coarse) return []
  const boundedFallback = () =>
    allowCorrespondingLineFallback
      ? refineCorrespondingLines(base, target) ?? [coarse]
      : [coarse]

  // Token objects are linear but comparatively expensive. Charge their UTF-16
  // input size against the same deterministic budget so a single giant line
  // cannot allocate an unbounded character-level diff before Myers starts.
  if (!spendBudgetAmount(budget, 2 * (base.length + target.length))) {
    return boundedFallback()
  }

  const minimal = codePointMinimalChange(base, target)
  if (!minimal) return []

  const baseCore = minimal.baseTokens.slice(
    minimal.prefixLength,
    minimal.baseCoreEnd
  )
  const targetCore = minimal.targetTokens.slice(
    minimal.prefixLength,
    minimal.targetCoreEnd
  )
  if (baseCore.length === 0 || targetCore.length === 0) {
    return [minimal.change]
  }

  const operations = computeMyersOperations(baseCore, targetCore, budget)
  if (!operations) return boundedFallback()
  return operationsToChanges(operations, baseCore, minimal.change.end)
}

export function computeTextChanges(
  base: string,
  target: string,
  maximumOperations?: number,
  allowCorrespondingLineFallback = false
): TextChange[] {
  if (base === target) return []

  const defaultBudget = Math.min(
    1_000_000,
    16 * (base.length + target.length) + 4096
  )
  const budget: DiffBudget = {
    remaining:
      maximumOperations === undefined
        ? defaultBudget
        : Number.isFinite(maximumOperations)
          ? Math.max(0, Math.floor(maximumOperations))
          : 0,
  }
  const changes: TextChange[] = []
  const anchors = findLineAnchors(base, target)
  let baseCursor = 0
  let targetCursor = 0

  const appendSegment = (baseEnd: number, targetEnd: number) => {
    const segmentChanges = refineTextSegment(
      base.slice(baseCursor, baseEnd),
      target.slice(targetCursor, targetEnd),
      budget,
      allowCorrespondingLineFallback
    )
    for (const change of segmentChanges) {
      changes.push({
        start: baseCursor + change.start,
        end: baseCursor + change.end,
        text: change.text,
      })
    }
  }

  for (const anchor of anchors) {
    appendSegment(anchor.base.start, anchor.target.start)
    baseCursor = anchor.base.end
    targetCursor = anchor.target.end
  }
  appendSegment(base.length, target.length)
  return changes
}

function sameChange(left: TextChange, right: TextChange): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.text === right.text
  )
}

function changesConflict(left: TextChange, right: TextChange): boolean {
  if (sameChange(left, right)) return false

  // Two different insertions at the same point have no unambiguous ordering.
  if (left.start === left.end && right.start === right.end) {
    return left.start === right.start
  }

  // An insertion strictly inside a replaced range conflicts with that range.
  if (left.start === left.end) {
    return left.start > right.start && left.start < right.end
  }
  if (right.start === right.end) {
    return right.start > left.start && right.start < left.end
  }

  return left.start < right.end && right.start < left.end
}

/**
 * Merges independent local and remote edits made from the same base text.
 * Overlapping edits are reported instead of silently preferring either side.
 */
export function mergeThreeWayText(
  base: string,
  local: string,
  remote: string
): ThreeWayMergeResult {
  if (local === remote) return { kind: 'merged', content: local }
  if (local === base) return { kind: 'merged', content: remote }
  if (remote === base) return { kind: 'merged', content: local }

  const localChanges = computeTextChanges(base, local)
  const remoteChanges = computeTextChanges(base, remote)

  for (const localChange of localChanges) {
    for (const remoteChange of remoteChanges) {
      if (changesConflict(localChange, remoteChange)) {
        return {
          kind: 'conflict',
          local: localChange,
          remote: remoteChange,
        }
      }
    }
  }

  const combined: Array<TextChange & { source: 'local' | 'remote' }> = []
  for (const change of localChanges) {
    combined.push({ ...change, source: 'local' })
  }
  for (const change of remoteChanges) {
    if (!localChanges.some((candidate) => sameChange(candidate, change))) {
      combined.push({ ...change, source: 'remote' })
    }
  }

  combined.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start
    if (left.end !== right.end) return left.end - right.end
    return left.source === right.source ? 0 : left.source === 'remote' ? -1 : 1
  })

  let cursor = 0
  let content = ''
  for (const change of combined) {
    if (change.start < cursor) {
      return { kind: 'conflict', local: change, remote: change }
    }
    content += base.slice(cursor, change.start)
    content += change.text
    cursor = change.end
  }
  content += base.slice(cursor)

  return { kind: 'merged', content }
}

/**
 * Merges both sides while giving the editor-owned local text priority for
 * genuinely overlapping hunks. Independent external edits are still retained.
 */
export function mergeThreeWayTextPreferringLocal(
  base: string,
  local: string,
  remote: string,
  allowRemoteCorrespondingLineFallback = false,
  preserveRemoteNewlineInsertions = false
): LocalPreferredMergeResult {
  if (local === remote) {
    return { kind: 'merged', content: local, discardedRemoteChanges: [] }
  }
  if (local === base) {
    return { kind: 'merged', content: remote, discardedRemoteChanges: [] }
  }
  if (remote === base) {
    return { kind: 'merged', content: local, discardedRemoteChanges: [] }
  }

  const localChanges = computeTextChanges(base, local)
  const remoteChanges = computeTextChanges(
    base,
    remote,
    undefined,
    allowRemoteCorrespondingLineFallback
  )
  const discardedRemoteChanges: TextChange[] = []
  const combined: Array<TextChange & { source: 'local' | 'remote' }> =
    localChanges.map((change) => ({ ...change, source: 'local' }))

  for (const remoteChange of remoteChanges) {
    if (localChanges.some((localChange) => sameChange(localChange, remoteChange))) {
      continue
    }
    const conflictingLocalChanges = localChanges.filter((localChange) =>
      changesConflict(localChange, remoteChange)
    )
    if (conflictingLocalChanges.length > 0) {
      // Canonical Markdown collapses repeated blank separators. If the user
      // inserts content at that exact projected gap, retain the origin's
      // newline-only formatting before the local insertion. Keep this opt-in
      // and restricted to a real blank-line boundary: concurrent same-position
      // insertions and ordinary single line breaks remain ambiguous.
      const isDocumentEdgeBlankRun =
        (remoteChange.start === 0 || remoteChange.start === base.length) &&
        remoteChange.text.length >= 2
      const isBlankLineBoundary =
        isDocumentEdgeBlankRun ||
        base.slice(0, remoteChange.start).endsWith('\n\n') ||
        base.slice(remoteChange.start).startsWith('\n\n')
      const isPreservableNewlineInsertion =
        preserveRemoteNewlineInsertions &&
        isBlankLineBoundary &&
        remoteChange.start === remoteChange.end &&
        /^\n+$/.test(remoteChange.text) &&
        conflictingLocalChanges.every(
          (localChange) =>
            localChange.start === localChange.end &&
            localChange.start === remoteChange.start
        )
      if (!isPreservableNewlineInsertion) {
        discardedRemoteChanges.push(remoteChange)
        continue
      }
    }
    combined.push({ ...remoteChange, source: 'remote' })
  }

  combined.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start
    if (left.end !== right.end) return left.end - right.end
    return left.source === right.source ? 0 : left.source === 'remote' ? -1 : 1
  })

  let cursor = 0
  let content = ''
  for (const change of combined) {
    content += base.slice(cursor, change.start)
    content += change.text
    cursor = change.end
  }
  content += base.slice(cursor)

  return { kind: 'merged', content, discardedRemoteChanges }
}

/**
 * Re-expresses an edit made against Lute's canonical Markdown projection in
 * the document's original formatting space. Untouched canonicalisation noise
 * is taken from `origin`, while overlapping user edits remain local-preferred.
 */
export function reconcileCanonicalisedEdit(
  origin: string,
  baseline: string,
  local: string
): string {
  if (local === baseline) return origin
  // Granular positional fallback is safe only for the known load-time
  // projection (baseline -> origin). Genuine concurrent document merges keep
  // the conservative coarse fallback so structural shifts cannot relocate an
  // independent external edit.
  return mergeThreeWayTextPreferringLocal(
    baseline,
    local,
    origin,
    true,
    true
  ).content
}
