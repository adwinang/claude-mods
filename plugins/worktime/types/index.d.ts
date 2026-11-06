/** One turn of Claude's work: from the turn's start to its end. */
export type Span = {
  id: number
  start: number
  end?: number
  /** Time inside the turn spent waiting on the person (approvals, questions). */
  waitMs: number
  /** Set while a wait is open: when it began, and which calls hold it. */
  pausedSince?: number
  pauseKeys: string[]
  /** Why the turn ended: answer, aborted, refusal, error, or recovered. */
  reason?: string
  prompt: string
  excluded?: true
}

/** Time added or removed by hand. */
export type Adjust = { id: number; at: number; ms: number; note: string }

/** One push of time to a timesheet (e.g. a ClickUp time entry). */
export type LogEntry = {
  at: number
  ms: number
  target: string
  ref?: string
  note?: string
  spanIds: number[]
  adjustIds: number[]
}

export type TaskPin = { id: string; url?: string; name?: string }

export type WorkRecord = {
  sessionId: string
  nextId: number
  spans: Span[]
  adjusts: Adjust[]
  logs: LogEntry[]
  task?: TaskPin
  lastSeen?: number
}

declare module 'claude-code' {
  interface PluginState {
    worktime: { rec: Shaped<WorkRecord | null> }
  }
}
