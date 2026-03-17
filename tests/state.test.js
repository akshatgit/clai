import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  generateId,
  createSession,
  saveSession,
  loadSession,
  listSessions,
  resetTask,
  _configure,
} from '../src/state.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TASKS = [
  { id: 'task_1', title: 'Setup', description: 'Init project', dependencies: [], complexity: 'low' },
  { id: 'task_2', title: 'Build', description: 'Build the app', dependencies: ['task_1'], complexity: 'high' },
]

let sessDir, logsDir

beforeEach(() => {
  sessDir = mkdtempSync(join(tmpdir(), 'orch-sess-'))
  logsDir = mkdtempSync(join(tmpdir(), 'orch-logs-'))
  _configure({ sessionsDir: sessDir, logsDir })
})

afterEach(() => {
  rmSync(sessDir, { recursive: true, force: true })
  rmSync(logsDir, { recursive: true, force: true })
})

// ─── generateId ───────────────────────────────────────────────────────────────

describe('generateId', () => {
  it('uses "sess" as the default prefix', () => {
    assert.ok(generateId().startsWith('sess_'))
  })

  it('uses a custom prefix', () => {
    assert.ok(generateId('task').startsWith('task_'))
  })

  it('generates unique IDs across many calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()))
    assert.equal(ids.size, 50)
  })

  it('has content after the underscore separator', () => {
    const id = generateId('x')
    const parts = id.split('_')
    assert.equal(parts.length, 2)
    assert.ok(parts[1].length > 0)
  })
})

// ─── createSession ────────────────────────────────────────────────────────────

describe('createSession', () => {
  it('returns an object with id, goal, status, created_at, dag', () => {
    const s = createSession('build a thing', TASKS)
    assert.ok(s.id)
    assert.equal(s.goal, 'build a thing')
    assert.equal(s.status, 'pending')
    assert.ok(s.created_at)
    assert.ok(s.dag)
  })

  it('writes a JSON file to the sessions directory', () => {
    const s = createSession('g', TASKS)
    assert.ok(existsSync(join(sessDir, `${s.id}.json`)))
  })

  it('file is valid parseable JSON', () => {
    const s = createSession('g', TASKS)
    const raw = readFileSync(join(sessDir, `${s.id}.json`), 'utf8')
    assert.doesNotThrow(() => JSON.parse(raw))
  })

  it('stores every task from input', () => {
    const s = createSession('g', TASKS)
    assert.equal(Object.keys(s.dag.tasks).length, 2)
    assert.ok(s.dag.tasks.task_1)
    assert.ok(s.dag.tasks.task_2)
  })

  it('all tasks start with status="pending"', () => {
    const s = createSession('g', TASKS)
    for (const task of Object.values(s.dag.tasks)) {
      assert.equal(task.status, 'pending')
    }
  })

  it('all tasks start with result=null, attempts=0', () => {
    const s = createSession('g', TASKS)
    for (const task of Object.values(s.dag.tasks)) {
      assert.equal(task.result, null)
      assert.equal(task.attempts, 0)
    }
  })

  it('defaults docker_image when not provided', () => {
    const s = createSession('g', TASKS)
    assert.ok(s.dag.tasks.task_1.docker_image)
  })

  it('defaults completion_criteria and tests to []', () => {
    const s = createSession('g', TASKS)
    assert.deepEqual(s.dag.tasks.task_1.completion_criteria, [])
    assert.deepEqual(s.dag.tasks.task_1.tests, [])
  })

  it('preserves completion_criteria when provided', () => {
    const tasks = [{
      id: 'task_1', title: 'T', description: 'D', dependencies: [],
      complexity: 'low', completion_criteria: ['file exists'], tests: ['npm test'],
    }]
    const s = createSession('g', tasks)
    assert.deepEqual(s.dag.tasks.task_1.completion_criteria, ['file exists'])
    assert.deepEqual(s.dag.tasks.task_1.tests, ['npm test'])
  })

  it('computes a topological order with task_1 before task_2', () => {
    const s = createSession('g', TASKS)
    assert.ok(s.dag.order.indexOf('task_1') < s.dag.order.indexOf('task_2'))
  })

  it('dag.order contains all task IDs', () => {
    const s = createSession('g', TASKS)
    assert.equal(s.dag.order.length, 2)
    assert.ok(s.dag.order.includes('task_1'))
    assert.ok(s.dag.order.includes('task_2'))
  })

  it('throws on circular dependencies', () => {
    const circular = [
      { id: 'a', title: 'A', description: '', dependencies: ['b'], complexity: 'low' },
      { id: 'b', title: 'B', description: '', dependencies: ['a'], complexity: 'low' },
    ]
    assert.throws(() => createSession('g', circular))
  })

  it('two sessions get different IDs', () => {
    const a = createSession('goal', TASKS)
    const b = createSession('goal', TASKS)
    assert.notEqual(a.id, b.id)
  })
})

// ─── saveSession / loadSession ────────────────────────────────────────────────

describe('saveSession / loadSession', () => {
  it('round-trips a session unchanged', () => {
    const s = createSession('goal', TASKS)
    const loaded = loadSession(s.id)
    assert.equal(loaded.id, s.id)
    assert.equal(loaded.goal, s.goal)
    assert.equal(loaded.status, s.status)
  })

  it('persists mutated status', () => {
    const s = createSession('g', TASKS)
    s.status = 'running'
    saveSession(s)
    assert.equal(loadSession(s.id).status, 'running')
  })

  it('persists task result', () => {
    const s = createSession('g', TASKS)
    s.dag.tasks.task_1.status = 'completed'
    s.dag.tasks.task_1.result = 'done!'
    saveSession(s)
    const loaded = loadSession(s.id)
    assert.equal(loaded.dag.tasks.task_1.status, 'completed')
    assert.equal(loaded.dag.tasks.task_1.result, 'done!')
  })

  it('overwrites previous save on repeated calls', () => {
    const s = createSession('g', TASKS)
    s.goal = 'updated goal'
    saveSession(s)
    s.goal = 'updated again'
    saveSession(s)
    assert.equal(loadSession(s.id).goal, 'updated again')
  })

  it('throws a descriptive error for missing sessions', () => {
    assert.throws(() => loadSession('sess_nonexistent'), /not found/i)
  })
})

// ─── listSessions ─────────────────────────────────────────────────────────────

describe('listSessions', () => {
  it('returns [] when no sessions exist', () => {
    assert.deepEqual(listSessions(), [])
  })

  it('returns one entry per session file', () => {
    createSession('first', TASKS)
    createSession('second', TASKS)
    assert.equal(listSessions().length, 2)
  })

  it('entry contains id, goal, status, created_at', () => {
    createSession('my goal', TASKS)
    const [entry] = listSessions()
    assert.ok(entry.id)
    assert.equal(entry.goal, 'my goal')
    assert.ok(entry.status)
    assert.ok(entry.created_at)
  })

  it('entry does not contain full dag (lightweight listing)', () => {
    createSession('g', TASKS)
    const [entry] = listSessions()
    assert.equal(entry.dag, undefined)
  })

  it('sorts newest first (descending created_at)', () => {
    const older = createSession('older', TASKS)
    older.created_at = '2020-01-01T00:00:00.000Z'
    saveSession(older)

    const newer = createSession('newer', TASKS)
    newer.created_at = '2025-06-01T00:00:00.000Z'
    saveSession(newer)

    const list = listSessions()
    assert.equal(list[0].goal, 'newer')
    assert.equal(list[1].goal, 'older')
  })

  it('handles a corrupt JSON file gracefully (skips it)', () => {
    createSession('good', TASKS)
    // Write a non-JSON file
    writeFileSync(join(sessDir, 'corrupt.json'), 'not json{{{', 'utf8')
    assert.doesNotThrow(() => listSessions())
    // Only the valid session is returned
    assert.equal(listSessions().length, 1)
  })
})

// ─── resetTask ────────────────────────────────────────────────────────────────

describe('resetTask', () => {
  it('sets task status back to pending', () => {
    const s = createSession('g', TASKS)
    s.dag.tasks.task_1.status = 'completed'
    resetTask(s, 'task_1')
    assert.equal(s.dag.tasks.task_1.status, 'pending')
  })

  it('clears task result', () => {
    const s = createSession('g', TASKS)
    s.dag.tasks.task_1.result = 'previous output'
    resetTask(s, 'task_1')
    assert.equal(s.dag.tasks.task_1.result, null)
  })

  it('clears started_at', () => {
    const s = createSession('g', TASKS)
    s.dag.tasks.task_1.started_at = new Date().toISOString()
    resetTask(s, 'task_1')
    assert.equal(s.dag.tasks.task_1.started_at, null)
  })

  it('clears completed_at', () => {
    const s = createSession('g', TASKS)
    s.dag.tasks.task_1.completed_at = new Date().toISOString()
    resetTask(s, 'task_1')
    assert.equal(s.dag.tasks.task_1.completed_at, null)
  })

  it('sets session status to running', () => {
    const s = createSession('g', TASKS)
    s.status = 'completed'
    saveSession(s)
    resetTask(s, 'task_1')
    assert.equal(s.status, 'running')
  })

  it('persists the reset to disk', () => {
    const s = createSession('g', TASKS)
    s.dag.tasks.task_1.status = 'completed'
    saveSession(s)
    resetTask(s, 'task_1')
    assert.equal(loadSession(s.id).dag.tasks.task_1.status, 'pending')
  })

  it('does not reset other tasks', () => {
    const s = createSession('g', TASKS)
    s.dag.tasks.task_2.status = 'completed'
    saveSession(s)
    resetTask(s, 'task_1')
    assert.equal(loadSession(s.id).dag.tasks.task_2.status, 'completed')
  })

  it('throws a descriptive error for unknown task id', () => {
    const s = createSession('g', TASKS)
    assert.throws(() => resetTask(s, 'task_99'), /not found/i)
  })
})
