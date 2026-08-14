export interface VditorImageViewerController {
  dispose(): void
}

/** Replaces Vditor's CSP-blocked inline close handler for its image viewer. */
export function installVditorImageViewerClose(): VditorImageViewerController {
  const handleClick = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    const closeButton = target?.closest<HTMLElement>(
      '.vditor-img__bar .vditor-img__btn:not([data-deg])'
    )
    const viewer = closeButton?.closest<HTMLElement>('.vditor-img')
    if (!closeButton || !viewer) return

    event.preventDefault()
    event.stopImmediatePropagation()
    viewer.remove()
    if (!document.querySelector('.vditor-img')) {
      document.body.style.overflow = ''
    }
  }

  document.addEventListener('click', handleClick, true)
  return {
    dispose(): void {
      document.removeEventListener('click', handleClick, true)
    },
  }
}
