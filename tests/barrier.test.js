import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeBarrier, BARRIER_PENDING } from '../src/task-types/barrier.js'

function session(tasks = {}) {
  return { id: 'sess_test', dag: { tasks } }
}

function barrierTask(overrides = {}) {
  return {
    id: 'barrier_1',
    title: 'Sync barrier',
    type: 'barrier',
    dependencies: [],
    wait_for: [],
    ...overrides,
  }
}

describe('executeBarrier', () => {
  it('passes immediately when wait_for is empty', async () => {
    const result = await executeBarrier(session(), barrierTask({ wait_for: [] }))
    assert.ok(result.includes('passed immediately'))
  })

  it('passes when all wait_for tasks are completed', async () => {
    const s = session({
      task_1: { status: 'completed' },
      task_2: { status: 'completed' },
    })
    const result = await executeBarrier(s, barrierTask({ wait_for: ['task_1', 'task_2'] }))
    assert.ok(result.includes('completed'))
    assert.ok(result.includes('task_1'))
    assert.ok(result.includes('task_2'))
  })

  it('returns BARRIER_PENDING when some tasks are still pending', async () => {
    const s = session({
      task_1: { status: 'completed' },
      task_2: { status: 'pending' },
    })
    const result = await executeBarrier(s, barrierTask({ wait_for: ['task_1', 'task_2'] }))
    assert.equal(result, BARRIER_PENDING)
  })

  it('returns BARRIER_PENDING when some tasks are running', async () => {
    const s = session({
      task_1: { status: 'running' },
    })
    const result = await executeBarrier(s, barrierTask({ wait_for: ['task_1'] }))
    assert.equal(result, BARRIER_PENDING)
  })

  it('throws when all wait_for tasks have failed or been skipped', async () => {
    const s = session({
      task_1: { status: 'failed' },
      task_2: { status: 'skipped' },
    })
    await assert.rejects(
      () => executeBarrier(s, barrierTask({ wait_for: ['task_1', 'task_2'] })),
      /all wait_for tasks failed/
    )
  })

  it('calls onChunk with waiting info when pending', async () => {
    const s = session({ task_1: { status: 'pending' } })
    const chunks = []
    await executeBarrier(s, barrierTask({ wait_for: ['task_1'] }), c => chunks.push(c))
    assert.ok(chunks.some(c => c.includes('waiting')))
  })
})
