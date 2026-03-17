import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cloneTask, resolveItems } from '../src/template.js'

// ─── cloneTask ────────────────────────────────────────────────────────────────

describe('cloneTask', () => {
  const base = {
    id: 'task_tmpl',
    title: 'Process {{item}}',
    description: 'Handle the item {{item}} with index {{index}}',
    completion_criteria: ['{{item}} is done'],
    tests: ['check {{item}}'],
    status: 'completed',
    result: 'old result',
    started_at: '2024-01-01',
    completed_at: '2024-01-02',
    attempts: 3,
    iteration_count: 2,
    complexity: 'medium',
    docker_image: 'node:22-alpine',
    dependencies: ['task_1'],
  }

  it('assigns the new ID', () => {
    const clone = cloneTask(base, 'task_new', {})
    assert.equal(clone.id, 'task_new')
  })

  it('substitutes variables in title', () => {
    const clone = cloneTask(base, 'task_0', { item: 'apple', index: '0' })
    assert.equal(clone.title, 'Process apple')
  })

  it('substitutes variables in description', () => {
    const clone = cloneTask(base, 'task_0', { item: 'apple', index: '0' })
    assert.equal(clone.description, 'Handle the item apple with index 0')
  })

  it('substitutes variables in completion_criteria', () => {
    const clone = cloneTask(base, 'task_0', { item: 'apple' })
    assert.deepEqual(clone.completion_criteria, ['apple is done'])
  })

  it('substitutes variables in tests', () => {
    const clone = cloneTask(base, 'task_0', { item: 'apple' })
    assert.deepEqual(clone.tests, ['check apple'])
  })

  it('resets runtime state fields', () => {
    const clone = cloneTask(base, 'task_new', {})
    assert.equal(clone.status, 'pending')
    assert.equal(clone.result, null)
    assert.equal(clone.started_at, null)
    assert.equal(clone.completed_at, null)
    assert.equal(clone.attempts, 0)
    assert.equal(clone.iteration_count, 0)
  })

  it('does not mutate the original template', () => {
    cloneTask(base, 'task_new', { item: 'changed' })
    assert.equal(base.title, 'Process {{item}}')
  })

  it('leaves unresolved placeholders intact when variable not provided', () => {
    const clone = cloneTask(base, 'task_0', {})
    assert.ok(clone.title.includes('{{item}}'))
  })

  it('preserves non-substituted fields (dependencies, complexity, docker_image)', () => {
    const clone = cloneTask(base, 'task_new', {})
    assert.deepEqual(clone.dependencies, ['task_1'])
    assert.equal(clone.complexity, 'medium')
    assert.equal(clone.docker_image, 'node:22-alpine')
  })
})

// ─── resolveItems ─────────────────────────────────────────────────────────────

describe('resolveItems', () => {
  it('returns a plain array as-is', () => {
    assert.deepEqual(resolveItems(['a', 'b', 'c'], {}), ['a', 'b', 'c'])
  })

  it('parses JSON array from task result', () => {
    const session = {
      dag: {
        tasks: {
          task_1: { result: '["x","y","z"]' },
        },
      },
    }
    assert.deepEqual(resolveItems('result_of:task_1', session), ['x', 'y', 'z'])
  })

  it('splits non-JSON result on newlines', () => {
    const session = {
      dag: {
        tasks: {
          task_1: { result: 'alpha\nbeta\ngamma' },
        },
      },
    }
    assert.deepEqual(resolveItems('result_of:task_1', session), ['alpha', 'beta', 'gamma'])
  })

  it('filters empty lines when splitting', () => {
    const session = {
      dag: {
        tasks: {
          task_1: { result: 'a\n\nb\n\nc' },
        },
      },
    }
    assert.deepEqual(resolveItems('result_of:task_1', session), ['a', 'b', 'c'])
  })

  it('throws if referenced task has no result', () => {
    const session = {
      dag: {
        tasks: {
          task_1: { result: null },
        },
      },
    }
    assert.throws(() => resolveItems('result_of:task_1', session), /has no result/)
  })

  it('throws for unknown spec format', () => {
    assert.throws(() => resolveItems('unknown_spec', {}), /cannot resolve items spec/)
  })
})
