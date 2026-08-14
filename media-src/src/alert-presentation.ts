import { normalizeAlertType } from './quote-format'
import type { AlertType } from './quote-format'

export const ALERT_CLASS = 'vmd-alert'
export const ALERT_MARKER_CLASS = 'vmd-alert-marker'
export const ALERT_TITLE_CLASS = 'vmd-alert-title'
export const ALERT_MARKER_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\r\n]*))?(?:\r?\n|$)/i
export const ALERT_MARKER_TYPE_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i

export const ALERT_ICONS: Record<AlertType, string> = {
  NOTE: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 7v4M8 4.5h.01"/></svg>',
  TIP: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.4 11h5.2M6 13h4M8 2.2a4.2 4.2 0 0 0-2.5 7.6c.5.4.8.8.9 1.2h3.2c.1-.4.4-.8.9-1.2A4.2 4.2 0 0 0 8 2.2Z"/></svg>',
  IMPORTANT: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7 14 5v6l-6 3.3L2 11V5l6-3.3ZM8 5v3.5M8 11h.01"/></svg>',
  WARNING: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 14.3 14H1.7L8 1.8ZM8 6v3.5M8 12h.01"/></svg>',
  CAUTION: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 1.7-3.3 3.3v6L5 14.3h6l3.3-3.3V5L11 1.7H5ZM8 5v3.5M8 11h.01"/></svg>',
}

export interface ParsedAlertMarker {
  customTitle: string | null
  matchLength: number
  type: AlertType
}

export function alertType(value: unknown): AlertType | null {
  return normalizeAlertType(value)
}

export function alertTitle(type: AlertType): string {
  return type[0] + type.slice(1).toLowerCase()
}

export function parseAlertMarker(value: string): ParsedAlertMarker | null {
  const match = ALERT_MARKER_PATTERN.exec(value)
  const type = alertType(match?.[1])
  if (!match || !type) return null
  return {
    customTitle: match[2]?.trim() || null,
    matchLength: match[0].length,
    type,
  }
}
