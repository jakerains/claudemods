// POWERTRAY's look: an 80s console box. Chrome cyan into hot magenta on deep
// navy, a red grid for the rules. Colours and single-width glyphs only, so it
// draws as fast as plain text.

import type { TrayKind } from '../types'

export const NAME = 'POWERTRAY'

export const THEME = {
  chrome: '#5ce1e6',
  accent: '#ff4fd8',
  onAccent: '#0b1033',
  picked: '#1d1f4a',
  sub: '#b9bdf0',
  faint: '#6b6f9e',
  rule: '#3b3f8f',
  grid: '#ff3b5c',
  go: '#39ff88',
  stop: '#ff3b5c',
}

/** One colour per letter of the name, chrome cyan to magenta. */
export const NAME_COLORS = ['#5ce1e6', '#5cc8f0', '#6aa8ff', '#7c8cff', '#8b7bff', '#a46cff', '#c25cf5', '#e052e6', '#ff4fd8']

export const ICONS: Record<TrayKind, string> = {
  video: '▶', audio: '♪', image: '▣', page: '◧', doc: '≡', folder: '▤', url: '↗', other: '·',
}

export const KIND_COLORS: Record<TrayKind, string> = {
  video: '#ff4fd8',
  audio: '#5ce1e6',
  image: '#ffd23f',
  page: '#6aa8ff',
  doc: '#c9d1ff',
  folder: '#39ff88',
  url: '#5cc8f0',
  other: '#8a8fbf',
}
