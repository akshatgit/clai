import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { on, emit, _reset } from '../src/hooks.js'
import { _configure } from '../src/state.js'

let logsDir

beforeEach(() => {
  _reset()
  logsDir = mkdtempSync(join(tmpdir(), 'orch-hooks-'))
  _configure({ logsDir })
})

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true })
})

// ─── on + emit ────────────────────────────────────────────────────────────────

describe('on + emit', () => {
  it('calls a registered handler when event is emitted', () => {
    let received = null
    on('test:ev', data => { received = data })
    emit('test:ev', { sessionId: 's1', x: 42 })
    assert.equal(received.x, 42)
  })

  it('passes event name in the emitted data', () => {
    let received = null
    on('my:event', d => { received = d })
    emit('my:event', { sessionId: 's1' })
    assert.equal(received.event, 'my:event')
  })

  it('adds an ISO timestamp to every emitted entry', () => {
    let received = null
    on('ev', d => { received = d })
    emit('ev', { sessionId: 's1' })
    assert.ok(received.ts)
    assert.ok(!isNaN(new Date(received.ts).getTime()))
  })

  it('calls all handlers registered for an event', () => {
    const calls = []
    on('ev', () => calls.push('a'))
    on('ev', () => calls.push('b'))
    on('ev', () => calls.push('c'))
    emit('ev', { sessionId: 's1' })
    assert.deepEqual(calls, ['a', 'b', 'c'])
  })

  it('does not call handlers for a different event', () => {
    let called = false
    on('event:a', () => { called = true })
    emit('event:b', { sessionId: 's1' })
    assert.equal(called, false)
  })

  it('handler receives all extra fields passed to emit', () => {
    let received = null
    on('ev', d => { received = d })
    emit('ev', { sessionId: 's1', taskId: 't1', error: 'boom', duration: 42 })
    assert.equal(received.taskId, 't1')
    assert.equal(received.error, 'boom')
    assert.equal(received.duration, 42)
  })

  it('wildcard * handler is called for every event', () => {
    const seen = []
    on('*', d => seen.push(d.event))
    emit('event:a', { sessionId: 's1' })
    emit('event:b', { sessionId: 's1' })
    emit('event:c', { sessionId: 's1' })
    assert.deepEqual(seen, ['event:a', 'event:b', 'event:c'])
  })

  it('wildcard and specific handlers both fire', () => {
    const calls = []
    on('*', () => calls.push('wildcard'))
    on('ev', () => calls.push('specific'))
    emit('ev', { sessionId: 's1' })
    assert.ok(calls.includes('wildcard'))
    assert.ok(calls.includes('specific'))
  })

  it('a throwing handler does not prevent subsequent handlers from running', () => {
    let secondCalled = false
    on('ev', () => { throw new Error('handler error') })
    on('ev', () => { secondCalled = true })
    assert.doesNotThrow(() => emit('ev', { sessionId: 's1' }))
    assert.equal(secondCalled, true)
  })

  it('emitting the same event twice calls handler twice', () => {
    let count = 0
    on('ev', () => count++)
    emit('ev', { sessionId: 's1' })
    emit('ev', { sessionId: 's1' })
    assert.equal(count, 2)
  })
})

// ─── File logging ─────────────────────────────────────────────────────────────

describe('file logging', () => {
  it('creates a JSONL file named <sessionId>.jsonl in logsDir', () => {
    emit('session:created', { sessionId: 'sess_abc', goal: 'test' })
    assert.ok(existsSync(join(logsDir, 'sess_abc.jsonl')))
  })

  it('appends one JSON line per emit call', () => {
    emit('task:started', { sessionId: 'sess_x', taskId: 't1' })
    emit('task:completed', { sessionId: 'sess_x', taskId: 't1' })
    emit('task:started', { sessionId: 'sess_x', taskId: 't2' })
    const lines = readFileSync(join(logsDir, 'sess_x.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 3)
  })

  it('every line is valid parseable JSON', () => {
    emit('task:failed', { sessionId: 'sess_x', taskId: 't1', error: 'oops' })
    emit('session:completed', { sessionId: 'sess_x', stats: {} })
    const lines = readFileSync(join(logsDir, 'sess_x.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean)
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `Invalid JSON: ${line}`)
    }
  })

  it('log entry contains event name and ts', () => {
    emit('task:failed', { sessionId: 'sess_x', error: 'boom' })
    const entry = JSON.parse(readFileSync(join(logsDir, 'sess_x.jsonl'), 'utf8').trim())
    assert.equal(entry.event, 'task:failed')
    assert.ok(entry.ts)
  })

  it('log entry contains extra payload fields', () => {
    emit('task:completed', { sessionId: 'sess_x', taskId: 't1', duration: 1234 })
    const entry = JSON.parse(readFileSync(join(logsDir, 'sess_x.jsonl'), 'utf8').trim())
    assert.equal(entry.taskId, 't1')
    assert.equal(entry.duration, 1234)
  })

  it('does not create a file when sessionId is absent', () => {
    emit('internal:event', { value: 1 })
    assert.equal(readdirSync(logsDir).length, 0)
  })

  it('separates logs per session into individual files', () => {
    emit('task:started', { sessionId: 'sess_1', taskId: 't1' })
    emit('task:started', { sessionId: 'sess_2', taskId: 't1' })
    assert.ok(existsSync(join(logsDir, 'sess_1.jsonl')))
    assert.ok(existsSync(join(logsDir, 'sess_2.jsonl')))
    // Each file has exactly one entry
    const lines1 = readFileSync(join(logsDir, 'sess_1.jsonl'), 'utf8').trim().split('\n')
    const lines2 = readFileSync(join(logsDir, 'sess_2.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines1.length, 1)
    assert.equal(lines2.length, 1)
  })

  it('log file grows with each subsequent emit for the same session', () => {
    for (let i = 0; i < 5; i++) {
      emit('tick', { sessionId: 'sess_x', i })
    }
    const lines = readFileSync(join(logsDir, 'sess_x.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 5)
  })
})

// ─── _reset ───────────────────────────────────────────────────────────────────

describe('_reset', () => {
  it('clears all registered handlers', () => {
    let called = false
    on('ev', () => { called = true })
    _reset()
    emit('ev', { sessionId: 's1' })
    assert.equal(called, false)
  })

  it('clears wildcard handlers too', () => {
    let called = false
    on('*', () => { called = true })
    _reset()
    emit('anything', { sessionId: 's1' })
    assert.equal(called, false)
  })

  it('allows re-registering after reset', () => {
    on('ev', () => {})
    _reset()
    let called = false
    on('ev', () => { called = true })
    emit('ev', { sessionId: 's1' })
    assert.equal(called, true)
  })

  it('does not affect file logging (file logging is always active)', () => {
    _reset()
    emit('session:created', { sessionId: 'sess_x', goal: 'test' })
    assert.ok(existsSync(join(logsDir, 'sess_x.jsonl')))
  })
})
