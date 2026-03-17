/**
 * runner.test.js — Tests for the core orchestration loop.
 *
 * Uses _setExecutor to inject mock task results without hitting the Anthropic API.
 * Covers: happy path, failure + cascade, retry, and session resume.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runSessionTasks } from '../src/runner.js'
import { _setExecutor, _resetExecutor } from '../src/runner.js'
import { createSession, loadSession, saveSession, _configure } from '../src/state.js'
import { _reset as resetHooks } from '../src/hooks.js'

// ─── Setup ────────────────────────────────────────────────────────────────────

const CALENDAR_TASKS = [
  { id: 'task_1', title: 'Project scaffold',    description: 'Init npm project',        dependencies: [],              complexity: 'low',    docker_image: 'node:22-alpine', completion_criteria: [], tests: [] },
  { id: 'task_2', title: 'Event data model',    description: 'Define Event class',       dependencies: ['task_1'],      complexity: 'medium', docker_image: 'node:22-alpine', completion_criteria: [], tests: [] },
  { id: 'task_3', title: 'Add / list events',   description: 'Implement add and list',   dependencies: ['task_2'],      complexity: 'medium', docker_image: 'node:22-alpine', completion_criteria: [], tests: [] },
  { id: 'task_4', title: 'Delete / edit events',description: 'Implement delete and edit',dependencies: ['task_2'],      complexity: 'medium', docker_image: 'node:22-alpine', completion_criteria: [], tests: [] },
  { id: 'task_5', title: 'CLI entry point',     description: 'Wire up commander.js',     dependencies: ['task_3', 'task_4'], complexity: 'high', docker_image: 'node:22-alpine', completion_criteria: [], tests: [] },
]

/** Mock executor that returns canned output per task id. */
function makeExecutor(overrides = {}) {
  const defaults = {
    task_1: () => '## Summary\nInitialized Node.js project. package.json created.',
    task_2: () => '## Summary\nDefined Event class with id, title, date fields.',
    task_3: () => '## Summary\nImplemented add and list commands.',
    task_4: () => '## Summary\nImplemented delete and edit commands.',
    task_5: () => '## Summary\nWired up CLI with commander.js. All commands work.',
  }
  const fns = { ...defaults, ...overrides }
  return async (session, task) => {
    const fn = fns[task.id]
    if (!fn) throw new Error(`No mock for task ${task.id}`)
    return fn(task, session)
  }
}

let sessionsDir, logsDir

beforeEach(() => {
  resetHooks()
  const base = mkdtempSync(join(tmpdir(), 'orch-runner-'))
  sessionsDir = join(base, 'sessions')
  logsDir = join(base, 'logs')
  _configure({ sessionsDir, logsDir })
})

afterEach(() => {
  _resetExecutor()
})

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('happy path — all tasks succeed', () => {
  it('session status is "completed" when all tasks pass', async () => {
    _setExecutor(makeExecutor())
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    assert.equal(final.status, 'completed')
  })

  it('all 5 tasks end up with status "completed"', async () => {
    _setExecutor(makeExecutor())
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    for (const task of Object.values(final.dag.tasks)) {
      assert.equal(task.status, 'completed', `${task.id} should be completed`)
    }
  })

  it('each task result contains the mocked output', async () => {
    _setExecutor(makeExecutor())
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    assert.ok(final.dag.tasks.task_1.result.includes('package.json'))
    assert.ok(final.dag.tasks.task_5.result.includes('commander'))
  })

  it('tasks respect topological order (task_1 completes before task_2)', async () => {
    const completionOrder = []
    _setExecutor(async (session, task) => {
      completionOrder.push(task.id)
      return `## Summary\nDone.`
    })
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    assert.ok(completionOrder.indexOf('task_1') < completionOrder.indexOf('task_2'))
    assert.ok(completionOrder.indexOf('task_2') < completionOrder.indexOf('task_3'))
    assert.ok(completionOrder.indexOf('task_2') < completionOrder.indexOf('task_4'))
    assert.ok(completionOrder.indexOf('task_3') < completionOrder.indexOf('task_5'))
    assert.ok(completionOrder.indexOf('task_4') < completionOrder.indexOf('task_5'))
  })

  it('each task records attempts=1', async () => {
    _setExecutor(makeExecutor())
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    for (const task of Object.values(final.dag.tasks)) {
      assert.equal(task.attempts, 1, `${task.id} should have 1 attempt`)
    }
  })

  it('sets session.completed_at timestamp', async () => {
    _setExecutor(makeExecutor())
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    assert.ok(final.completed_at)
    assert.ok(!isNaN(new Date(final.completed_at).getTime()))
  })
})

// ─── Task failure + cascade ───────────────────────────────────────────────────

describe('task failure — cascade skips dependents', () => {
  it('session status is "failed" when a task throws', async () => {
    _setExecutor(makeExecutor({
      task_3: () => { throw new Error('Claude timed out') },
    }))
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    assert.equal(final.status, 'failed')
  })

  it('failed task has status "failed"', async () => {
    _setExecutor(makeExecutor({
      task_3: () => { throw new Error('model error') },
    }))
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    assert.equal(loadSession(session.id).dag.tasks.task_3.status, 'failed')
  })

  it('task_5 is skipped because task_3 (its dep) failed', async () => {
    _setExecutor(makeExecutor({
      task_3: () => { throw new Error('model error') },
    }))
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    // task_5 depends on task_3 AND task_4; task_3 fails → task_5 skipped
    assert.equal(loadSession(session.id).dag.tasks.task_5.status, 'skipped')
  })

  it('independent task_4 still completes even though task_3 fails', async () => {
    // task_4 only depends on task_2, not on task_3
    _setExecutor(makeExecutor({
      task_3: () => { throw new Error('model error') },
    }))
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    assert.equal(loadSession(session.id).dag.tasks.task_4.status, 'completed')
  })

  it('tasks before the failure all complete normally', async () => {
    _setExecutor(makeExecutor({
      task_3: () => { throw new Error('model error') },
    }))
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    assert.equal(final.dag.tasks.task_1.status, 'completed')
    assert.equal(final.dag.tasks.task_2.status, 'completed')
  })
})

// ─── Retry a failed task ──────────────────────────────────────────────────────

describe('retry — re-run a failed task then complete the session', () => {
  it('task_3 retried successfully: status becomes "completed"', async () => {
    // First run: task_3 fails
    _setExecutor(makeExecutor({
      task_3: () => { throw new Error('transient error') },
    }))
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)

    // Second run: retry task_3 only — now it succeeds
    _setExecutor(makeExecutor())
    await runSessionTasks(loadSession(session.id), { targetTaskId: 'task_3' })
    assert.equal(loadSession(session.id).dag.tasks.task_3.status, 'completed')
  })

  it('after retrying task_3, resuming the session completes the whole thing', async () => {
    // First run: task_3 fails, task_5 skipped
    _setExecutor(makeExecutor({
      task_3: () => { throw new Error('transient error') },
    }))
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)

    // Retry task_3
    _setExecutor(makeExecutor())
    await runSessionTasks(loadSession(session.id), { targetTaskId: 'task_3' })

    // Un-skip task_5 and resume
    const s = loadSession(session.id)
    s.dag.tasks.task_5.status = 'pending'
    saveSession(s)

    await runSessionTasks(loadSession(session.id))

    const final = loadSession(session.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.dag.tasks.task_5.status, 'completed')
  })

  it('increments attempts counter on retry', async () => {
    _setExecutor(makeExecutor({
      task_3: () => { throw new Error('error') },
    }))
    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    await runSessionTasks(session)

    _setExecutor(makeExecutor())
    await runSessionTasks(loadSession(session.id), { targetTaskId: 'task_3' })

    // task_3 ran twice: once failed, once succeeded
    assert.equal(loadSession(session.id).dag.tasks.task_3.attempts, 2)
  })
})

// ─── Session resume ───────────────────────────────────────────────────────────

describe('resume — pick up a partially-completed session', () => {
  it('skips already-completed tasks and only runs the remaining ones', async () => {
    const executed = []
    _setExecutor(async (session, task) => {
      executed.push(task.id)
      return '## Summary\nDone.'
    })

    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)

    // Pre-complete task_1 and task_2 as if a previous run already did them
    session.dag.tasks.task_1.status = 'completed'
    session.dag.tasks.task_1.result = '## Summary\nDone before.'
    session.dag.tasks.task_2.status = 'completed'
    session.dag.tasks.task_2.result = '## Summary\nDone before.'
    saveSession(session)

    await runSessionTasks(loadSession(session.id))

    // Only tasks 3, 4, 5 should have been executed
    assert.ok(!executed.includes('task_1'), 'task_1 should not be re-run')
    assert.ok(!executed.includes('task_2'), 'task_2 should not be re-run')
    assert.ok(executed.includes('task_3'))
    assert.ok(executed.includes('task_4'))
    assert.ok(executed.includes('task_5'))
  })

  it('session reaches "completed" after resuming', async () => {
    _setExecutor(makeExecutor())

    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    session.dag.tasks.task_1.status = 'completed'
    session.dag.tasks.task_1.result = '## Summary\nDone.'
    session.dag.tasks.task_2.status = 'completed'
    session.dag.tasks.task_2.result = '## Summary\nDone.'
    saveSession(session)

    await runSessionTasks(loadSession(session.id))
    assert.equal(loadSession(session.id).status, 'completed')
  })

  it('does nothing when all tasks are already completed', async () => {
    _setExecutor(makeExecutor())

    const session = createSession('Build a calendar CLI app', CALENDAR_TASKS)
    for (const task of Object.values(session.dag.tasks)) {
      task.status = 'completed'
      task.result = '## Summary\nPre-done.'
    }
    session.status = 'completed'
    saveSession(session)

    // Should not throw, and session should still be completed
    await runSessionTasks(loadSession(session.id))
    assert.equal(loadSession(session.id).status, 'completed')
  })
})
