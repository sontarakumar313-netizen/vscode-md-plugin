const assert = require('assert')
const {
  applyEol,
  documentEol,
  toLf,
} = require('../out/eol')
const {
  computeMinimalTextEdit,
  computeTextChanges,
  mergeThreeWayText,
  mergeThreeWayTextPreferringLocal,
  reconcileCanonicalisedEdit,
} = require('../out/text-sync')

assert.strictEqual(toLf('one\r\ntwo\rthree\n'), 'one\ntwo\nthree\n')
assert.strictEqual(applyEol('one\r\ntwo\n', '\n'), 'one\ntwo\n')
assert.strictEqual(applyEol('one\ntwo\n', '\r\n'), 'one\r\ntwo\r\n')
assert.strictEqual(documentEol({ eol: 1 }), '\n')
assert.strictEqual(documentEol({ eol: 2 }), '\r\n')

assert.deepStrictEqual(computeMinimalTextEdit('abc', 'abXYc'), {
  start: 2,
  end: 2,
  text: 'XY',
})
assert.strictEqual(computeMinimalTextEdit('same', 'same'), undefined)
assert.deepStrictEqual(computeMinimalTextEdit('abcXYZ', 'abc'), {
  start: 3,
  end: 6,
  text: '',
})

assert.deepStrictEqual(
  mergeThreeWayText(
    'alpha beta gamma',
    'alpha brave beta gamma',
    'alpha beta GAMMA'
  ),
  { kind: 'merged', content: 'alpha brave beta GAMMA' }
)

assert.deepStrictEqual(
  mergeThreeWayText('one two three', 'ONE two three', 'one two THREE'),
  { kind: 'merged', content: 'ONE two THREE' }
)

assert.deepStrictEqual(
  mergeThreeWayText(
    'first\nsecond\nthird\n',
    'FIRST\nsecond\nthird\nlocal tail\n',
    'first\nsecond remote\nthird\n'
  ),
  {
    kind: 'merged',
    content: 'FIRST\nsecond remote\nthird\nlocal tail\n',
  }
)

assert.deepStrictEqual(
  mergeThreeWayText('ab', 'a-local-b', 'ab-remote'),
  { kind: 'merged', content: 'a-local-b-remote' }
)

// A second local keystroke may still advertise an older acknowledged version.
// Rebasing it from the previous unmerged local result must retain a new remote
// change that arrived between the two host applications.
assert.deepStrictEqual(
  mergeThreeWayText(
    'table cell B\nfooter',
    'table cell C\nfooter',
    'table cell B\nexternal footer'
  ),
  { kind: 'merged', content: 'table cell C\nexternal footer' }
)

assert.deepStrictEqual(
  mergeThreeWayText('base', 'base', 'remote'),
  { kind: 'merged', content: 'remote' }
)

assert.strictEqual(
  mergeThreeWayText('hello world', 'hello local', 'hello remote').kind,
  'conflict'
)

assert.strictEqual(
  mergeThreeWayText('ab', 'a-local-b', 'a-remote-b').kind,
  'conflict'
)

assert.deepStrictEqual(
  mergeThreeWayTextPreferringLocal('base', 'same change', 'same change'),
  {
    kind: 'merged',
    content: 'same change',
    discardedRemoteChanges: [],
  }
)

const overlappingWordMerge = mergeThreeWayTextPreferringLocal(
  'hello world',
  'hello local',
  'hello remote'
)
assert.strictEqual(overlappingWordMerge.kind, 'merged')
assert.strictEqual(overlappingWordMerge.content, 'hello local')
assert.ok(overlappingWordMerge.discardedRemoteChanges.length > 0)

const separatedLineMerge = mergeThreeWayTextPreferringLocal(
  'header\nremote base\nseparator\nshared base\nfooter\n',
  'header\nremote base\nseparator\nshared local\nfooter\n',
  'header\nremote changed\nseparator\nshared remote\nfooter\n'
)
assert.strictEqual(
  separatedLineMerge.content,
  'header\nremote changed\nseparator\nshared local\nfooter\n'
)
assert.ok(separatedLineMerge.discardedRemoteChanges.length > 0)

assert.deepStrictEqual(
  mergeThreeWayTextPreferringLocal('ab', 'a-local-b', 'a-remote-b'),
  {
    kind: 'merged',
    content: 'a-local-b',
    discardedRemoteChanges: [{ start: 1, end: 1, text: '-remote-' }],
  }
)

assert.deepStrictEqual(
  mergeThreeWayTextPreferringLocal('abcdef', 'abXdef', 'AbYdef'),
  {
    kind: 'merged',
    content: 'AbXdef',
    discardedRemoteChanges: [{ start: 2, end: 3, text: 'Y' }],
  },
  'an independent remote edit on the same line must survive a local overlap'
)

assert.deepStrictEqual(
  mergeThreeWayTextPreferringLocal(
    'abcdefghi',
    'abXdefYhi',
    'AbZdefYhI'
  ),
  {
    kind: 'merged',
    content: 'AbXdefYhI',
    discardedRemoteChanges: [{ start: 2, end: 3, text: 'Z' }],
  },
  'same-line remote edits must be retained independently and deduplicated'
)

assert.deepStrictEqual(
  mergeThreeWayTextPreferringLocal('a😀b', 'a😎b', 'A😀b'),
  {
    kind: 'merged',
    content: 'A😎b',
    discardedRemoteChanges: [],
  },
  'code-point refinement must preserve UTF-16 surrogate-pair boundaries'
)
assert.deepStrictEqual(computeTextChanges('a😀b', 'a😎b'), [
  { start: 1, end: 3, text: '😎' },
])
assert.deepStrictEqual(computeTextChanges('a😀b', 'a😎b', 0), [
  { start: 1, end: 3, text: '😎' },
])

const fallbackTarget = 'b'.repeat(64)
assert.deepStrictEqual(
  computeTextChanges('a'.repeat(64), fallbackTarget, 0),
  [{ start: 0, end: 64, text: fallbackTarget }],
  'a disabled refinement budget must deterministically use one coarse hunk'
)

const applyChanges = (base, changes) => {
  let cursor = 0
  let content = ''
  for (const change of changes) {
    content += base.slice(cursor, change.start)
    content += change.text
    cursor = change.end
  }
  return content + base.slice(cursor)
}

for (let lineCount = 2; lineCount <= 24; lineCount += 1) {
  const before = Array.from(
    { length: lineCount },
    (_, index) => `line ${index} 😀 old\n`
  ).join('')
  const after = Array.from(
    { length: lineCount },
    (_, index) => `line ${index} 😎 new\n`
  ).join('')
  const changes = computeTextChanges(before, after, 0)
  assert.strictEqual(
    applyChanges(before, changes),
    after,
    `line fallback failed reconstruction for ${lineCount} lines`
  )
  assert.ok(
    changes.every(
      (change) =>
        !(/[\uD800-\uDBFF]/.test(before[change.start - 1] || '') &&
          /[\uDC00-\uDFFF]/.test(before[change.start] || '')) &&
        !(/[\uD800-\uDBFF]/.test(before[change.end - 1] || '') &&
          /[\uDC00-\uDFFF]/.test(before[change.end] || '')) &&
        !/^[\uDC00-\uDFFF]/.test(change.text) &&
        !/[\uD800-\uDBFF]$/.test(change.text)
    ),
    `line fallback split a UTF-16 surrogate pair for ${lineCount} lines`
  )
}
assert.deepStrictEqual(
  computeTextChanges('abcdef', 'AbYdef', 30),
  [{ start: 0, end: 3, text: 'AbY' }],
  'partial Myers work must be discarded when the shared budget is exhausted'
)

const granularTaskBefore =
  Array.from({ length: 20 }, () => '* [x] done').join('\n') + '\n'
const granularTaskAfter =
  Array.from({ length: 20 }, () => '- [X]  done').join('\n') + '\n'
assert.strictEqual(
  computeTextChanges(granularTaskBefore, granularTaskAfter, 0).length,
  1,
  'general merges must keep the conservative coarse budget fallback'
)
const granularTaskChanges = computeTextChanges(
  granularTaskBefore,
  granularTaskAfter,
  0,
  true
)
assert.strictEqual(
  granularTaskChanges.length,
  20,
  'semantically corresponding task lines did not receive granular fallback hunks'
)
assert.strictEqual(
  applyChanges(granularTaskBefore, granularTaskChanges),
  granularTaskAfter,
  'granular task fallback did not reconstruct the target'
)

// Equal line counts alone are not correspondence: this local edit inserts at
// the start and deletes at the end, shifting every alternating line. The input
// is large enough to exhaust the default capped refinement budget immediately.
const shiftedLineCount = 130001
const shiftedBaseLines = Array.from(
  { length: shiftedLineCount },
  (_, index) => (index % 2 === 0 ? '    code' : 'code')
)
const shiftedBase = `${shiftedBaseLines.join('\n')}\n`
const shiftedLocal = `code\n${shiftedBaseLines.slice(0, -1).join('\n')}\n`
const shiftedRemoteLines = shiftedBaseLines.slice()
shiftedRemoteLines[100000] += ' remote'
const shiftedRemote = `${shiftedRemoteLines.join('\n')}\n`
const shiftedMerge = mergeThreeWayTextPreferringLocal(
  shiftedBase,
  shiftedLocal,
  shiftedRemote
)
assert.strictEqual(
  shiftedMerge.content,
  shiftedLocal,
  'an external edit was attached to the wrong line after a structural shift'
)
assert.ok(
  !shiftedMerge.content.includes('remote'),
  'unsafe positional fallback misplaced an independent external edit'
)
assert.strictEqual(
  shiftedMerge.discardedRemoteChanges.length,
  1,
  'the conservative fallback did not report the overlapped external hunk'
)

const canonicalPreservationCases = [
  {
    name: 'compact table',
    origin: '| a | b |\n| - | - |\n| 1 | 2 |\n\nsentinel old\n',
    baseline:
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nsentinel old\n',
  },
  {
    name: 'task marker',
    origin: '* [x] done\n\nsentinel old\n',
    baseline: '- [X]  done\n\nsentinel old\n',
  },
  {
    name: 'blank lines and hard break',
    origin: 'alpha\n\n\n\nbeta  \nnext\n\nsentinel old\n',
    baseline: 'alpha\n\nbeta\nnext\n\nsentinel old\n',
  },
  {
    name: 'indented code and list',
    origin: '    code\n\n- parent\n    - child\n\nsentinel old\n',
    baseline: 'code\n\n- parent\n  - child\n\nsentinel old\n',
  },
  {
    name: 'separator and bare URL',
    origin: '***\n\nhttps://example.com\n\nsentinel old\n',
    baseline:
      '---\n\n[https://example.com](https://example.com)\n\nsentinel old\n',
  },
  {
    name: 'Unicode source',
    origin: '标题 😀   \n\nsentinel old\n',
    baseline: '标题 😀\n\nsentinel old\n',
  },
]
for (const fixture of canonicalPreservationCases) {
  const local = fixture.baseline.replace('sentinel old', 'sentinel new')
  assert.strictEqual(
    reconcileCanonicalisedEdit(fixture.origin, fixture.baseline, local),
    fixture.origin.replace('sentinel old', 'sentinel new'),
    `${fixture.name}: untouched formatting was not restored`
  )
}

const repeatedOrigin = Array.from({ length: 20 }, () => '* [x] done').join('\n') + '\n'
const repeatedBaseline =
  Array.from({ length: 20 }, () => '- [X]  done').join('\n') + '\n'
const repeatedLocalLines = repeatedBaseline.trimEnd().split('\n')
repeatedLocalLines[9] = '- [X]  changed'
const repeatedReconciled = reconcileCanonicalisedEdit(
  repeatedOrigin,
  repeatedBaseline,
  repeatedLocalLines.join('\n') + '\n'
)
assert.strictEqual(
  repeatedReconciled.split('\n').filter((line) => line === '* [x] done').length,
  19,
  'budget exhaustion canonicalized untouched repeated lines'
)
assert.strictEqual(
  repeatedReconciled.split('\n')[9],
  '* [x] changed',
  'the edited repeated line content did not remain editor-preferred'
)

assert.strictEqual(
  reconcileCanonicalisedEdit('original formatting', 'canonical', 'canonical'),
  'original formatting',
  'an unchanged editor projection must return the document origin'
)
assert.strictEqual(
  reconcileCanonicalisedEdit(
    'first\n\n\n\nsecond\n',
    'first\n\nsecond\n',
    'first\n\ninserted\n\nsecond\n'
  ),
  'first\n\ninserted\n\nsecond\n',
  'an edit inside a canonicalised region must remain editor-preferred'
)

console.log('text synchronization tests passed')
