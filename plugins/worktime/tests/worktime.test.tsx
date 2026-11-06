import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60e3

const T0 = Date.UTC(2026, 10, 6, 1, 0, 0)

function engine(on: On, stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored)
  on('session.id', () => ({ value: 'sess-1234abcd' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__worktime__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('fs.write', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return clock
}

test('counts only working time across two turns, minus a question wait', async ($, on) => {
  const clock = engine(on)
  on('tool.call', async (_, e) => {
    if (e.tool === 'AskUserQuestion') await clock.advance(3 * MIN)
    return { result: {} }
  })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })

  // Turn 1: 10 minutes of work.
  await $.turn.start({ text: 'first prompt', turnId: 't1' })
  await clock.advance(10 * MIN)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 0, isAborted: false, turnId: 't' })

  // 10 minutes idle: not counted.
  await clock.advance(10 * MIN)

  // Turn 2: 23 minutes wall time, 3 of them waiting on a question.
  await $.turn.start({ text: 'follow up', turnId: 't2' })
  await clock.advance(5 * MIN)
  await $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [] } as never)
  await clock.advance(15 * MIN)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 0, isAborted: false, turnId: 't' })

  const got = await $.tool.call({ tool: 'mcp__worktime__get_worktime' } as never)
  const r = got.result as { effectiveMs: number; waitExcludedMs: number; unloggedMs: number; turns: unknown[] }
  expect(r.turns.length).toBe(2)
  expect(r.effectiveMs).toBe(30 * MIN)
  expect(r.waitExcludedMs).toBe(3 * MIN)
  expect(r.unloggedMs).toBe(30 * MIN)

  // Manual adjust, exclude, and logging.
  const adj = await $.command.run({ command: 'worktime', args: 'adjust +15m review' } as never)
  expect(adj.text).toBe('Adjusted by 15m 00s.')
  await $.command.run({ command: 'worktime', args: 'exclude 1' } as never)
  const after = (await $.tool.call({ tool: 'mcp__worktime__get_worktime' } as never)).result as { effectiveMs: number }
  expect(after.effectiveMs).toBe(35 * MIN)

  const marked = await $.tool.call({ tool: 'mcp__worktime__mark_logged', target: 'clickup', ref: 'te_1' } as never)
  expect(marked.text).toBe('Marked 35m 00s as logged to clickup (te_1).')
  const again = await $.tool.call({ tool: 'mcp__worktime__mark_logged', target: 'clickup' } as never)
  expect(again.deny).toBeDefined()

  const csv = (await $.tool.call({ tool: 'mcp__worktime__get_worktime', format: 'csv' } as never)).text ?? ''
  expect(csv.split('\n').length).toBe(4)

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'worktime', component: 'Pane', requestId: 'worktime', surface,
      props: { title: 'Worktime', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    } as never)
    expect((await ui.find({ type: 'Text', text: /^35m 00s$/ }))?.text).toBe('35m 00s')
    await ui.unmount()
  }
})

test('a turn left open when the app closed is closed at the last moment seen', async ($, on) => {
  // What an earlier run stored: a turn opened at T0-60m, last seen alive 20 s later.
  const start = T0 - 60 * MIN
  engine(on, {
    'session:sess-1234abcd': {
      sessionId: 'sess-1234abcd', nextId: 2, adjusts: [], logs: [], lastSeen: start + 20e3,
      spans: [{ id: 1, start, waitMs: 0, pauseKeys: [], prompt: 'long job' }],
    },
  })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const r = (await $.tool.call({ tool: 'mcp__worktime__get_worktime' } as never)).result as { effectiveMs: number; isWorkingNow: boolean }
  expect(r.isWorkingNow).toBe(false)
  expect(r.effectiveMs).toBe(20e3)
})
