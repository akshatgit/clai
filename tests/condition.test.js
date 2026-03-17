import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectConditionMode, evaluateCondition, _setClient } from '../src/condition.js'

// ─── detectConditionMode ──────────────────────────────────────────────────────

describe('detectConditionMode', () => {
  it('detects shell mode from "exit:" prefix', () => {
    assert.equal(detectConditionMode('exit: echo hi'), 'shell')
  })

  it('detects js mode from "js:" prefix', () => {
    assert.equal(detectConditionMode('js: result.length > 0'), 'js')
  })

  it('detects natural language for anything else', () => {
    assert.equal(detectConditionMode('all tests are passing'), 'natural')
    assert.equal(detectConditionMode('the deployment succeeded'), 'natural')
  })
})

// ─── shell mode ───────────────────────────────────────────────────────────────

describe('evaluateCondition — shell mode', () => {
  it('returns true when command exits 0', async () => {
    const result = await evaluateCondition('exit: true', { session: {dag:{tasks:{}}}, task: {}, lastResult: '' })
    assert.equal(result, true)
  })

  it('returns false when command exits non-zero', async () => {
    const result = await evaluateCondition('exit: false', { session: {dag:{tasks:{}}}, task: {}, lastResult: '' })
    assert.equal(result, false)
  })
})

// ─── JS mode ─────────────────────────────────────────────────────────────────

describe('evaluateCondition — JS mode', () => {
  const ctx = { session: { dag: { tasks: {} } }, task: {}, lastResult: 'hello' }

  it('evaluates truthy expressions', async () => {
    assert.equal(await evaluateCondition('js: result.length > 0', ctx), true)
  })

  it('evaluates falsy expressions', async () => {
    assert.equal(await evaluateCondition('js: result.length === 0', ctx), false)
  })

  it('provides result variable in scope', async () => {
    assert.equal(await evaluateCondition('js: result === "hello"', ctx), true)
  })

  it('throws on syntax error', async () => {
    await assert.rejects(
      () => evaluateCondition('js: )(((', ctx),
      /JS condition eval failed/
    )
  })
})

// ─── natural language mode ────────────────────────────────────────────────────

describe('evaluateCondition — natural language mode', () => {
  it('returns true when Claude says "true"', async () => {
    _setClient({
      messages: {
        create() {
          return { content: [{ type: 'text', text: 'true' }] }
        },
      },
    })
    const result = await evaluateCondition('the build succeeded', {
      session: { dag: { tasks: {} } },
      task: {},
      lastResult: '',
    })
    assert.equal(result, true)
  })

  it('returns false when Claude says "false"', async () => {
    _setClient({
      messages: {
        create() {
          return { content: [{ type: 'text', text: 'false' }] }
        },
      },
    })
    const result = await evaluateCondition('tests are all passing', {
      session: { dag: { tasks: {} } },
      task: {},
      lastResult: '',
    })
    assert.equal(result, false)
  })

  it('is case-insensitive (True → true)', async () => {
    _setClient({
      messages: {
        create() {
          return { content: [{ type: 'text', text: 'True' }] }
        },
      },
    })
    const result = await evaluateCondition('checks passed', {
      session: { dag: { tasks: {} } },
      task: {},
      lastResult: '',
    })
    assert.equal(result, true)
  })
})
