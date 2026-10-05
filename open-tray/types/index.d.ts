export type TrayKind = 'video' | 'audio' | 'image' | 'page' | 'doc' | 'folder' | 'url' | 'other'

export type TrayItem = {
  target: string
  label: string
  kind: TrayKind
  /** A short tag from the project's rules (e.g. a chapter or ticket id), or null. */
  tag: string | null
  addedAt: number
}

/** Something the tray can start for the person, e.g. a review player. */
export type TrayAction = { label: string; prompt: string }

export type RelatedGroup = { label: string; items: TrayItem[] }

/** "Related to what we're on": swapped out when the area changes. */
export type Related = {
  /** The area's key (from the rules, e.g. "ch02", or a folder), null before any work. */
  area: string | null
  label: string
  groups: RelatedGroup[]
  actions: TrayAction[]
  /** Items Claude suggested for this area; they go when the area changes. */
  suggested: TrayItem[]
}

export type ReviewPlayer = {
  url: string
  tag: string | null
  isAlive: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'open-tray': {
      items: TrayItem[]
      selected: number
      players: ReviewPlayer[]
      related: Related
      /** Recent area votes, newest last: from prompts and the files Claude touches. */
      signals: string[]
      hidden: string[]
    }
  }
}
