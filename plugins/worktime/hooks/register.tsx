import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Adjust, Span, TaskPin, WorkRecord } from '../types'

// ── State ──────────────────────────────────────────────────────────────────
// The live record of this conversation is held in $.state (drawn by the pane)
// and mirrored to $.store under the session id, so a resumed conversation
// keeps adding to the same total.
const rec = atom({ plugin: 'worktime', key: 'rec' } as const, null, {
  shape: 'rec-1',
})

const PANE = 'worktime'
const TOOL_GET = 'get_worktime'
const TOOL_MARK = 'mark_logged'
const TOOL_TASK = 'set_task'
const fq = (name: string) => `mcp__worktime__${name}`

// Module variables: rebuilt on each reload by session.start.
let cwd = '.'
let lastSeenSaved = 0

// ── Pure helpers ───────────────────────────────────────────────────────────
const fresh = (sessionId: string): WorkRecord => ({
  sessionId,
  nextId: 1,
  spans: [],
  adjusts: [],
  logs: [],
})

const openSpan = (r: WorkRecord | null) => {
  const last = r?.spans[r.spans.length - 1]
  return last && last.end === undefined ? last : undefined
}

/** Effective ms of one span, as of `now` when it is still open. */
export const spanMs = (s: Span, now: number) => {
  const end = s.end ?? now
  const wait = s.waitMs + (s.pausedSince !== undefined && s.end === undefined ? now - s.pausedSince : 0)
  return Math.max(0, end - s.start - wait)
}

const loggedIds = (r: WorkRecord) => ({
  spans: new Set(r.logs.flatMap(l => l.spanIds)),
  adjusts: new Set(r.logs.flatMap(l => l.adjustIds)),
})

export const totals = (r: WorkRecord, now: number) => {
  const logged = loggedIds(r)
  let effective = 0
  let unlogged = 0
  const unloggedSpans: Span[] = []
  const unloggedAdjusts: Adjust[] = []
  for (const s of r.spans) {
    if (s.excluded) continue
    const ms = spanMs(s, now)
    effective += ms
    if (s.end !== undefined && !logged.spans.has(s.id)) {
      unlogged += ms
      unloggedSpans.push(s)
    }
  }
  for (const a of r.adjusts) {
    effective += a.ms
    if (!logged.adjusts.has(a.id)) {
      unlogged += a.ms
      unloggedAdjusts.push(a)
    }
  }
  const wait = r.spans.reduce((n, s) => n + (s.excluded ? 0 : s.waitMs), 0)
  return { effective: Math.max(0, effective), unlogged, unloggedSpans, unloggedAdjusts, wait }
}

export const fmt = (ms: number) => {
  const neg = ms < 0
  let s = Math.round(Math.abs(ms) / 1000)
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  const body = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
  return (neg ? '-' : '') + body
}

const iso = (t: number) => new Date(t).toISOString()

/** "1h30m", "15m", "-10m", "90s", "+1.5h" → ms; undefined when unreadable. */
export const parseDuration = (text: string) => {
  const m = /^([+-])?((?:\d+(?:\.\d+)?[hms])+)$/i.exec(text.trim())
  if (!m) return undefined
  let ms = 0
  for (const [, n = '0', u = 's'] of (m[2] ?? '').matchAll(/(\d+(?:\.\d+)?)([hms])/gi)) {
    const unit = u.toLowerCase()
    ms += Number(n) * (unit === 'h' ? 3600e3 : unit === 'm' ? 60e3 : 1e3)
  }
  return Math.round(m[1] === '-' ? -ms : ms)
}

const csvCell = (v: string | number | undefined) => {
  const s = v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const toCsv = (r: WorkRecord, now: number) => {
  const logged = loggedIds(r)
  const rows: (string | number | undefined)[][] = [
    ['kind', 'n', 'start', 'end', 'effective_min', 'wait_min', 'excluded', 'logged', 'end_reason', 'note'],
  ]
  r.spans.forEach((s, i) =>
    rows.push([
      'turn',
      i + 1,
      iso(s.start),
      s.end !== undefined ? iso(s.end) : '',
      (spanMs(s, now) / 60e3).toFixed(2),
      (s.waitMs / 60e3).toFixed(2),
      s.excluded ? 'yes' : '',
      logged.spans.has(s.id) ? 'yes' : '',
      s.reason ?? (s.end === undefined ? 'running' : ''),
      s.prompt,
    ]),
  )
  r.adjusts.forEach((a, i) =>
    rows.push(['adjust', i + 1, iso(a.at), '', (a.ms / 60e3).toFixed(2), '', '', logged.adjusts.has(a.id) ? 'yes' : '', '', a.note]),
  )
  return rows.map(row => row.map(csvCell).join(',')).join('\n')
}

const summaryFor = (r: WorkRecord, now: number) => {
  const t = totals(r, now)
  const logged = loggedIds(r)
  const firstUnlogged = t.unloggedSpans[0]
  const lastUnlogged = t.unloggedSpans[t.unloggedSpans.length - 1]
  return {
    sessionId: r.sessionId,
    effectiveMs: t.effective,
    effective: fmt(t.effective),
    waitExcludedMs: t.wait,
    isWorkingNow: openSpan(r) !== undefined,
    unloggedMs: t.unlogged,
    unlogged: fmt(t.unlogged),
    unloggedStart: firstUnlogged ? iso(firstUnlogged.start) : undefined,
    unloggedEnd: lastUnlogged?.end !== undefined ? iso(lastUnlogged.end) : undefined,
    pinnedTask: r.task ?? null,
    turns: r.spans.map((s, i) => ({
      n: i + 1,
      start: iso(s.start),
      end: s.end !== undefined ? iso(s.end) : null,
      effectiveMs: spanMs(s, now),
      waitMs: s.waitMs,
      excluded: !!s.excluded,
      logged: logged.spans.has(s.id),
      prompt: s.prompt,
    })),
    adjustments: r.adjusts.map(a => ({ at: iso(a.at), ms: a.ms, note: a.note, logged: logged.adjusts.has(a.id) })),
    logs: r.logs.map(l => ({ at: iso(l.at), ms: l.ms, duration: fmt(l.ms), target: l.target, ref: l.ref, note: l.note })),
  }
}

// ── Engine helpers ─────────────────────────────────────────────────────────
const storeKey = (sid: string) => `session:${sid}`

async function mutate($: EngineInterface, fn: (r: WorkRecord) => WorkRecord | undefined) {
  const sid = await $.session.id()
  let out: WorkRecord | null = null
  await update($, rec, r => {
    const base = r && r.sessionId === sid ? r : fresh(sid)
    out = fn(base) ?? base
    return out
  })
  if (out) await $.store.set(storeKey(sid), out)
  return out as WorkRecord | null
}

async function current($: EngineInterface) {
  const sid = await $.session.id()
  const r = await read($, rec)
  return r && r.sessionId === sid ? r : fresh(sid)
}

const pause = ($: EngineInterface, key: string, now: number) =>
  mutate($, r => {
    const s = openSpan(r)
    if (!s || s.pauseKeys.includes(key)) return undefined
    const span: Span = {
      ...s,
      pauseKeys: [...s.pauseKeys, key],
      pausedSince: s.pauseKeys.length === 0 ? now : s.pausedSince,
    }
    return { ...r, spans: [...r.spans.slice(0, -1), span] }
  })

const resume = ($: EngineInterface, key: string, now: number) =>
  mutate($, r => {
    const s = openSpan(r)
    if (!s || !s.pauseKeys.includes(key)) return undefined
    const keys = s.pauseKeys.filter(k => k !== key)
    const span: Span =
      keys.length > 0
        ? { ...s, pauseKeys: keys }
        : { ...s, pauseKeys: [], pausedSince: undefined, waitMs: s.waitMs + (now - (s.pausedSince ?? now)) }
    return { ...r, spans: [...r.spans.slice(0, -1), span] }
  })

/** Closes the open span at `at` (folding in any open wait). */
const closeSpan = (r: WorkRecord, at: number, reason: string): WorkRecord | undefined => {
  const s = openSpan(r)
  if (!s) return undefined
  const end = Math.max(at, s.start)
  const waitMs = s.waitMs + (s.pausedSince !== undefined ? Math.max(0, end - s.pausedSince) : 0)
  const span: Span = { ...s, end, waitMs, pausedSince: undefined, pauseKeys: [], reason }
  return { ...r, spans: [...r.spans.slice(0, -1), span] }
}

const logPrompt = (task: TaskPin | undefined) =>
  [
    'Log this conversation\'s unlogged effective work time to ClickUp.',
    `1. Call ${fq(TOOL_GET)} to get unloggedMs, unloggedStart and the pinned task.`,
    task
      ? `2. The pinned ClickUp task is ${task.id}${task.url ? ` (${task.url})` : ''}${task.name ? ` "${task.name}"` : ''}.`
      : '2. No task is pinned: ask me which ClickUp task to log against, then pin it with ' + fq(TOOL_TASK) + '.',
    '3. If unloggedMs is 0, tell me there is nothing to log and stop.',
    '4. Otherwise create ONE time entry on that task with the ClickUp connector (clickup_add_time_entry): duration = unloggedMs, start = unloggedStart, and a short description summarising what was done in the unlogged turns.',
    `5. Then call ${fq(TOOL_MARK)} with target "clickup", ref = the created time entry id, and durationMs = the duration you logged.`,
    '6. Reply with one line: the duration logged and the task.',
  ].join('\n')

const HELP = [
  '/worktime                show the effective time of this conversation',
  '/worktime pane           open the side pane',
  '/worktime csv            export turns and adjustments as CSV',
  '/worktime exclude <n>    leave turn n out of the total (include <n> undoes it)',
  '/worktime adjust <±dur> [note]   add or remove time by hand, e.g. +15m review',
  '/worktime task <id|url> [name]   pin a ClickUp task to this conversation',
  '/worktime log            ask Claude to log unlogged time to the pinned ClickUp task',
].join('\n')

const summaryText = (r: WorkRecord, now: number) => {
  const t = totals(r, now)
  const lines = [
    `Effective time: ${fmt(t.effective)}  (unlogged ${fmt(t.unlogged)}, waits excluded ${fmt(t.wait)})`,
    `Task: ${r.task ? `${r.task.name ?? r.task.id}${r.task.url ? ` ${r.task.url}` : ''}` : 'none pinned'}`,
    ...r.spans.map((s, i) => {
      const tag = s.excluded ? ' [excluded]' : s.end === undefined ? ' [running]' : ''
      return `  #${i + 1}  ${fmt(spanMs(s, now)).padStart(8)}  wait ${fmt(s.waitMs)}${tag}  ${s.prompt}`
    }),
    ...r.adjusts.map(a => `  adj ${fmt(a.ms).padStart(8)}  ${a.note}`),
    ...r.logs.map(l => `  logged ${fmt(l.ms)} → ${l.target}${l.ref ? ` (${l.ref})` : ''} at ${iso(l.at)}`),
  ]
  return lines.join('\n')
}

const parseTask = (args: string): TaskPin | undefined => {
  const [first, ...rest] = args.trim().split(/\s+/)
  if (!first) return undefined
  const url = /^https?:\/\//.test(first) ? first : undefined
  const id = url ? (/\/t\/(?:\d+\/)?([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? url) : first
  const name = rest.join(' ') || undefined
  return { id, url, name }
}

// ── Hooks ──────────────────────────────────────────────────────────────────
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'worktime',
      description: 'Effective work time of this conversation: summary, pane, csv, adjust, task, log',
      argumentHint: '[pane|csv|exclude n|include n|adjust ±15m note|task id|log]',
    })
    await $.tool.register({
      name: TOOL_GET,
      description:
        'Returns the effective work time tracked for this conversation (time Claude spent working, minus waits on the user): total, unlogged time with its start/end, the pinned timesheet task, and per-turn detail. Use before logging time to a timesheet such as ClickUp. format "csv" returns the turns as CSV text.',
      inputSchema: {
        type: 'object',
        properties: { format: { type: 'string', enum: ['json', 'csv'] } },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: TOOL_MARK,
      description:
        'Marks all currently unlogged effective time of this conversation as logged, after you created the timesheet entry (e.g. a ClickUp time entry). Pass the target system and the created entry id so nothing is logged twice.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'e.g. "clickup"' },
          ref: { type: 'string', description: 'id of the created time entry' },
          durationMs: { type: 'number', description: 'the duration you actually logged' },
          note: { type: 'string' },
        },
        required: ['target'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: TOOL_TASK,
      description: 'Pins the timesheet task (e.g. a ClickUp task id or URL) that this conversation\'s time is logged against.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, url: { type: 'string' }, name: { type: 'string' } },
        required: ['id'],
      },
    })

    // Load what an earlier run of this conversation stored, and close a turn
    // the app was closed in, at the last moment it was seen alive.
    const sid = await $.session.id()
    const stored = (await $.store.get(storeKey(sid))) as WorkRecord | undefined
    const have = await read($, rec)
    if (stored && (!have || have.sessionId !== sid)) await update($, rec, () => stored)
    await mutate($, r => {
      const s = openSpan(r)
      return s ? closeSpan(r, r.lastSeen ?? s.start, 'recovered') : undefined
    })

    // One timer for the session: redraw the pane each second while a turn
    // runs, and note "last seen alive" every 15 s for the recovery above.
    $.clock.every(1000, () => {
      void (async () => {
        const r = await read($, rec)
        if (!openSpan(r)) return
        $.ui.invalidate('ui.render')
        const t = await $.clock.now()
        if (t - lastSeenSaved >= 15e3) {
          lastSeenSaved = t
          await mutate($, x => ({ ...x, lastSeen: t }))
        }
      })().catch(() => {})
    })

    if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Worktime' })
    return next(e)
  })

  // A main-loop turn opens a span; a prompt folded into a running turn joins it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const out = await next(e)
    await mutate($, r => {
      if (openSpan(r)) return undefined
      const span: Span = { id: r.nextId, start: now, waitMs: 0, pauseKeys: [], prompt: e.text.replace(/\s+/g, ' ').slice(0, 120) }
      return { ...r, nextId: r.nextId + 1, spans: [...r.spans, span], lastSeen: now }
    })
    lastSeenSaved = now
    return out
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out
    const now = await $.clock.now()
    await mutate($, r => closeSpan(r, now, e.reason))
    $.ui.invalidate('ui.render')
    return out
  })

  // A permission the person has to answer: the clock pauses from the ask until
  // the call returns (see the tool.call hook below, which resumes it).
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.approver !== undefined && e.tool_use_id) {
      await pause($, `check:${e.tool_use_id}`, await $.clock.now())
    }
    return verdict
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? ''
    const isQuestion = e.tool === 'AskUserQuestion'
    if (isQuestion && id) await pause($, `ask:${id}`, await $.clock.now())
    try {
      return await next(e)
    } finally {
      if (id) {
        const now = await $.clock.now()
        await resume($, `check:${id}`, now)
        if (isQuestion) await resume($, `ask:${id}`, now)
      }
    }
  }).catch(($, e, next) => next(e))

  // ── Tools Claude can call ────────────────────────────────────────────────
  // The model reads a tool's result as text (a string or content blocks).
  on('tool.call', { tool: 'mcp__worktime__get_worktime' }, async ($, e) => {
    const r = await current($)
    const now = await $.clock.now()
    const format = (e as { format?: string }).format
    if (format === 'csv') {
      const csv = toCsv(r, now)
      return { result: csv, text: csv }
    }
    const summary = summaryFor(r, now)
    const text = JSON.stringify(summary, null, 2)
    return { result: text, text }
  })

  on('tool.call', { tool: 'mcp__worktime__mark_logged' }, async ($, e) => {
    const input = e as { target?: string; ref?: string; durationMs?: number; note?: string }
    const now = await $.clock.now()
    const r = await current($)
    const t = totals(r, now)
    if (t.unloggedSpans.length === 0 && t.unloggedAdjusts.length === 0) {
      return { deny: 'Nothing unlogged: every finished turn and adjustment is already logged.' }
    }
    const ms = typeof input.durationMs === 'number' ? input.durationMs : t.unlogged
    await mutate($, x => ({
      ...x,
      logs: [
        ...x.logs,
        {
          at: now,
          ms,
          target: input.target ?? 'unknown',
          ref: input.ref,
          note: input.note,
          spanIds: t.unloggedSpans.map(s => s.id),
          adjustIds: t.unloggedAdjusts.map(a => a.id),
        },
      ],
    }))
    const text = `Marked ${fmt(ms)} as logged to ${input.target ?? 'unknown'}${input.ref ? ` (${input.ref})` : ''}.`
    return { result: text, text }
  })

  on('tool.call', { tool: 'mcp__worktime__set_task' }, async ($, e) => {
    const input = e as { id?: string; url?: string; name?: string }
    if (!input.id) return { deny: 'id is required.' }
    const task: TaskPin = { id: input.id, url: input.url, name: input.name }
    await mutate($, r => ({ ...r, task }))
    const text = `Pinned task ${task.name ?? task.id}.`
    return { result: text, text }
  })

  // ── /worktime ────────────────────────────────────────────────────────────
  on('command.run', { command: 'worktime' }, async ($, e) => {
    const [sub = '', ...restParts] = e.args.trim().split(/\s+/)
    const rest = restParts.join(' ')
    const now = await $.clock.now()
    const r = await current($)

    switch (sub.toLowerCase()) {
      case '':
      case 'summary':
        return { text: summaryText(r, now) }
      case 'help':
        return { text: HELP }
      case 'pane':
      case 'open':
        await $.ui.open({ id: PANE, title: 'Worktime' })
        return { text: 'Worktime pane opened.' }
      case 'csv': {
        const csv = toCsv(r, now)
        const path = `${cwd.replace(/\/$/, '')}/worktime-${r.sessionId.slice(0, 8)}.csv`
        let saved = ''
        try {
          await $.fs.write(path, csv + '\n')
          saved = `Saved to ${path}\n`
        } catch {
          saved = ''
        }
        return { text: `${saved}\n${csv}` }
      }
      case 'exclude':
      case 'include': {
        const n = Number(rest)
        const span = r.spans[n - 1]
        if (!Number.isInteger(n) || !span) return { text: `No turn #${rest}. Turns run 1–${r.spans.length}.` }
        await mutate($, x => ({
          ...x,
          spans: x.spans.map(s => (s.id === span.id ? { ...s, excluded: sub.toLowerCase() === 'exclude' ? true : undefined } : s)),
        }))
        return { text: `Turn #${n} ${sub.toLowerCase() === 'exclude' ? 'excluded from' : 'included in'} the total.` }
      }
      case 'adjust': {
        const [dur = '', ...note] = rest.split(/\s+/)
        const ms = parseDuration(dur)
        if (ms === undefined || ms === 0) return { text: 'Usage: /worktime adjust +15m [note]  (or -10m, 1h30m, 90s)' }
        await mutate($, x => ({
          ...x,
          nextId: x.nextId + 1,
          adjusts: [...x.adjusts, { id: x.nextId, at: now, ms, note: note.join(' ') || 'manual adjustment' }],
        }))
        return { text: `Adjusted by ${fmt(ms)}.` }
      }
      case 'task': {
        const task = parseTask(rest)
        if (!task) return { text: r.task ? `Pinned: ${r.task.name ?? r.task.id} ${r.task.url ?? ''}` : 'Usage: /worktime task <ClickUp task id or URL> [name]' }
        await mutate($, x => ({ ...x, task }))
        return { text: `Pinned ClickUp task ${task.name ?? task.id}.` }
      }
      case 'log': {
        void $.prompt.submit({ text: logPrompt(r.task) })
        return { text: 'Asking Claude to log the unlogged time to ClickUp…' }
      }
      default:
        return { text: HELP }
    }
  })

  // ── Pane ─────────────────────────────────────────────────────────────────
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = (await read($, rec)) ?? fresh('')
    const now = await $.clock.now()
    const t = totals(r, now)
    const open = openSpan(r)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 14)
    const turns = r.spans.map((s, i) => ({ s, n: i + 1 })).reverse().slice(0, room)
    const logged = loggedIds(r)

    const state = !open
      ? 'Idle — waiting for your next prompt'
      : open.pausedSince !== undefined
        ? `Paused — waiting on you (${fmt(now - open.pausedSince)})`
        : `Working — this turn ${fmt(spanMs(open, now))}`

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor size="caption">EFFECTIVE TIME</Text>
          <Text size="title" weight="bold" tabular>{fmt(t.effective)}</Text>
          <Text dimColor={!open} color={open && open.pausedSince === undefined ? 'green' : undefined}>{state}</Text>
        </Box>
        <Box flexDirection="column">
          <Text>Unlogged: {fmt(t.unlogged)} · Waits excluded: {fmt(t.wait)}</Text>
          <Text dimColor>Task: {r.task ? (r.task.name ?? r.task.id) : 'none — /worktime task <id>'}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="log" label="Log to ClickUp" variant="primary" onPress={() => void (async () => {
            const x = await current($)
            await $.prompt.submit({ text: logPrompt(x.task) })
          })()} />
        </Box>
        <Box flexDirection="column">
          <Text dimColor size="caption">TURNS</Text>
          {turns.length === 0 && <Text dimColor>No turns yet.</Text>}
          {turns.map(({ s, n }) => (
            <Text dimColor={!!s.excluded || logged.spans.has(s.id)} strikethrough={!!s.excluded} wrap="truncate-end">
              #{n} {fmt(spanMs(s, now))}{s.waitMs > 0 ? ` (−${fmt(s.waitMs)} wait)` : ''}{s.end === undefined ? ' ●' : ''}{logged.spans.has(s.id) ? ' ✓' : ''} · {s.prompt || '(continuation)'}
            </Text>
          ))}
          {r.adjusts.map(a => (
            <Text dimColor={logged.adjusts.has(a.id)} wrap="truncate-end">adj {fmt(a.ms)} · {a.note}</Text>
          ))}
        </Box>
        {r.logs.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor size="caption">LOGGED</Text>
            {r.logs.map(l => (
              <Text dimColor wrap="truncate-end">{fmt(l.ms)} → {l.target}{l.ref ? ` ${l.ref}` : ''}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
