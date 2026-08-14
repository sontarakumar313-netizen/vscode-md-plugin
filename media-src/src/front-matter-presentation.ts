import { parseFrontMatter } from './front-matter'
import type { FrontMatterEntry, FrontMatterValue } from './front-matter'

const TABLE_CLASS = 'vmd-front-matter'

function scalarLabel(
  value: Extract<FrontMatterValue, { kind: 'scalar' }>
): string {
  if (value.type === 'null' && value.text === '') return ''
  return value.text
}

/** Flattens a value into rows, indenting nested keys with a path prefix. */
function appendRows(
  body: HTMLElement,
  entries: FrontMatterEntry[],
  depth: number
): void {
  for (const entry of entries) {
    const row = document.createElement('tr')
    const keyCell = document.createElement('td')
    keyCell.className = 'vmd-front-matter__key'
    if (depth > 0) {
      keyCell.classList.add(`vmd-front-matter__key--depth-${Math.min(depth, 3)}`)
    }
    keyCell.textContent = entry.key
    row.appendChild(keyCell)

    const valueCell = document.createElement('td')
    valueCell.className = 'vmd-front-matter__value'
    const value = entry.value

    if (value.kind === 'scalar') {
      valueCell.textContent = scalarLabel(value)
      valueCell.classList.add(`vmd-front-matter__value--${value.type}`)
      row.appendChild(valueCell)
      body.appendChild(row)
      continue
    }

    if (
      value.kind === 'list' &&
      value.items.every((item) => item.kind === 'scalar')
    ) {
      // A flat list reads better on one line than as one row per element.
      const list = document.createElement('ul')
      list.className = 'vmd-front-matter__list'
      for (const item of value.items) {
        const listItem = document.createElement('li')
        listItem.textContent = scalarLabel(
          item as Extract<FrontMatterValue, { kind: 'scalar' }>
        )
        list.appendChild(listItem)
      }
      valueCell.appendChild(list)
      row.appendChild(valueCell)
      body.appendChild(row)
      continue
    }

    valueCell.classList.add('vmd-front-matter__value--nested')
    row.appendChild(valueCell)
    body.appendChild(row)

    if (value.kind === 'map') {
      appendRows(body, value.entries, depth + 1)
      continue
    }

    value.items.forEach((item, index) => {
      if (item.kind === 'map') {
        appendRows(
          body,
          [{ key: `[${index}]`, value: { kind: 'map', entries: [] } }],
          depth + 1
        )
        appendRows(body, item.entries, depth + 2)
        return
      }
      appendRows(body, [{ key: `[${index}]`, value: item }], depth + 1)
    })
  }
}

/** Builds the shared read-only Front Matter table/error presentation. */
export function buildFrontMatterTable(source: string): HTMLElement {
  const { entries, error } = parseFrontMatter(source)

  if (error) {
    // Invalid YAML must show its raw projection clearly rather than silently
    // presenting an empty or partially parsed table.
    const notice = document.createElement('div')
    notice.className = `${TABLE_CLASS} ${TABLE_CLASS}--error`
    const heading = document.createElement('div')
    heading.className = 'vmd-front-matter__error'
    heading.textContent = `Front Matter 解析失败：${error}`
    const raw = document.createElement('pre')
    raw.className = 'vmd-front-matter__raw'
    raw.textContent = source
    notice.appendChild(heading)
    notice.appendChild(raw)
    return notice
  }

  if (entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = `${TABLE_CLASS} ${TABLE_CLASS}--empty`
    empty.textContent = 'Front Matter（空）'
    return empty
  }

  const table = document.createElement('table')
  table.className = TABLE_CLASS
  const caption = document.createElement('caption')
  caption.textContent = 'Front Matter'
  table.appendChild(caption)
  const body = document.createElement('tbody')
  appendRows(body, entries, 0)
  table.appendChild(body)
  return table
}
