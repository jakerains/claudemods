// The tray's own player, its plain parts: ffplay plays a film's sound or an
// audio file with no window. Pause stops the child and remembers where it
// was; play, and every jump, starts it again at that spot (`-ss`). The parts
// that run it are in register.tsx, since `$` never crosses an import.

/** Seconds into the file now. */
export function positionOf(p: { offset: number; startedAt: number | null; duration: number | null }, now: number): number {
  const at = p.startedAt === null ? p.offset : p.offset + (now - p.startedAt) / 1000
  return p.duration === null ? at : Math.min(at, p.duration)
}

/** Where a jump lands: inside the file, a second short of its end. */
export function landing(position: number, by: number, duration: number | null): number {
  const end = duration === null ? Infinity : Math.max(0, duration - 1)
  return Math.min(end, Math.max(0, position + by))
}

/** The sound alone, no window, from `offset` seconds. The path is absolute, so never read as an option. */
export function ffplayArgs(target: string, offset: number): string[] {
  return ['ffplay', '-nodisp', '-vn', '-autoexit', '-loglevel', 'error', '-ss', offset.toFixed(2), target]
}

export function ffprobeArgs(target: string): string[] {
  return ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target]
}

/** ffprobe's answer as seconds, or null. */
export function lengthIn(stdout: string): number | null {
  const seconds = Number(stdout.trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/** 0:07, 4:12, 1:02:09. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')

  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
