function getWysiwygRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '.vditor-wysiwyg .vditor-reset'
  )
}

function closeOpenSourcePanels(): void {
  const root = getWysiwygRoot()
  if (!root) return
  root
    .querySelectorAll<HTMLElement>('.vditor-wysiwyg__preview')
    .forEach((preview) => {
      const source = preview.previousElementSibling as HTMLElement | null
      if (source && source.style.display !== 'none') {
        source.style.display = 'none'
      }
    })
}

/** Closes a native code/formula source panel when the user clicks outside it. */
export function installWysiwygSourcePanelAutoClose(): void {
  document.addEventListener(
    'mousedown',
    (event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      const root = getWysiwygRoot()
      if (!root || root.contains(target)) return
      closeOpenSourcePanels()
    },
    true
  )
}
