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

/** The sound playing in the tray: a film's audio or an audio file. */
export type NowPlaying = {
  target: string
  label: string
  /** Seconds into the file where the current stretch started (or where it is paused). */
  offset: number
  /** When the current stretch started playing; null while paused. */
  startedAt: number | null
  /** The file's length in seconds, when ffprobe could tell. */
  duration: number | null
}

/** One plain-words recap of a stretch of work. */
export type Recap = {
  at: number
  did: string[]
  /** What the person has to do before the work can go on. */
  waiting: string[]
  next: string
  /** Asked for with "recap now", rather than written after a big move. */
  isAsked: boolean
}

export type Recaps = {
  /** Newest first. */
  list: Recap[]
  /** Which recap the tab shows: an index into list. */
  view: number
  isWriting: boolean
  /** When the recap being written was started; 0 when none is. */
  startedAt: number
  /** A recap the person has not looked at yet. */
  isNew: boolean
  /** Ticked to-dos, as "<recap at>:<index>". */
  ticked: string[]
}

/** The work since the last recap: what makes a stretch a big move. */
export type Work = {
  agents: number
  files: string[]
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
      tab: 'tray' | 'recap'
      playing: NowPlaying | null
      /** Ticks once a second while something plays, so the pane redraws its clock. */
      tick: number
      /** Steps the "writing recap" bar has moved: ticks only while one is written. */
      spin: number
      recaps: Recaps
      work: Work
    }
  }
}
