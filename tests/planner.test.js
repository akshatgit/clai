import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { planDAG, _setClient, PLAN_SCHEMA } from '../src/planner.js'

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const VALID_PLAN = {
  tasks: [
    {
      id: 'task_1', title: 'Setup', description: 'Init the project repo',
      dependencies: [], complexity: 'low', docker_image: 'node:22-alpine',
      completion_criteria: ['package.json exists'], tests: ['node --version'],
    },
    {
      id: 'task_2', title: 'Build', description: 'Write the main module',
      dependencies: ['task_1'], complexity: 'medium', docker_image: 'node:22-alpine',
      completion_criteria: ['src/index.js exists'], tests: ['node src/index.js'],
    },
    {
      id: 'task_3', title: 'Test', description: 'Write and run unit tests',
      dependencies: ['task_2'], complexity: 'low', docker_image: 'node:22-alpine',
      completion_criteria: ['tests pass'], tests: ['npm test'],
    },
  ],
}

let lastParams = null

function mockClient(responseContent) {
  return {
    messages: {
      create: async (params) => {
        lastParams = params
        return { content: responseContent }
      },
    },
  }
}

function textResponse(plan) {
  return [{ type: 'text', text: JSON.stringify(plan) }]
}

function thinkingAndTextResponse(plan) {
  return [
    { type: 'thinking', thinking: 'Let me think about this goal carefully...' },
    { type: 'text', text: JSON.stringify(plan) },
  ]
}

beforeEach(() => {
  lastParams = null
  _setClient(mockClient(thinkingAndTextResponse(VALID_PLAN)))
})

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('planDAG — happy path', () => {
  it('returns an array', async () => {
    const tasks = await planDAG('build a CLI app')
    assert.ok(Array.isArray(tasks))
  })

  it('returns the correct number of tasks', async () => {
    const tasks = await planDAG('goal')
    assert.equal(tasks.length, VALID_PLAN.tasks.length)
  })

  it('each task has id, title, description, dependencies, complexity', async () => {
    const tasks = await planDAG('goal')
    for (const t of tasks) {
      assert.ok(t.id, 'missing id')
      assert.ok(t.title, 'missing title')
      assert.ok(t.description, 'missing description')
      assert.ok(Array.isArray(t.dependencies), 'dependencies not array')
      assert.ok(['low', 'medium', 'high'].includes(t.complexity), `bad complexity: ${t.complexity}`)
    }
  })

  it('preserves task order from response', async () => {
    const tasks = await planDAG('goal')
    assert.equal(tasks[0].id, 'task_1')
    assert.equal(tasks[1].id, 'task_2')
    assert.equal(tasks[2].id, 'task_3')
  })

  it('uses claude-opus-4-6 model', async () => {
    await planDAG('goal')
    assert.equal(lastParams.model, 'claude-opus-4-6')
  })


  it('includes the goal in the user message', async () => {
    await planDAG('my specific goal string')
    const userContent = lastParams.messages[0].content
    assert.ok(userContent.includes('my specific goal string'))
  })

  it('sends a structured output format config', async () => {
    await planDAG('goal')
    assert.equal(lastParams.output_config?.format?.type, 'json_schema')
  })
})

// ─── Thinking callback ────────────────────────────────────────────────────────

describe('planDAG — onThinking callback', () => {
  it('calls onThinking with thinking block content', async () => {
    const thoughts = []
    await planDAG('goal', t => thoughts.push(t))
    assert.equal(thoughts.length, 1)
    assert.ok(thoughts[0].includes('think'))
  })

  it('does not call onThinking when response has no thinking block', async () => {
    _setClient(mockClient(textResponse(VALID_PLAN)))
    const thoughts = []
    await planDAG('goal', t => thoughts.push(t))
    assert.equal(thoughts.length, 0)
  })

  it('works fine when onThinking is not provided', async () => {
    await assert.doesNotReject(planDAG('goal'))
  })
})

// ─── Validation ───────────────────────────────────────────────────────────────

describe('planDAG — validation', () => {
  it('throws when response has no text block', async () => {
    _setClient(mockClient([{ type: 'thinking', thinking: 'only thinking, no text' }]))
    await assert.rejects(planDAG('goal'), /no text block/i)
  })

  it('throws when response text is not valid JSON', async () => {
    _setClient(mockClient([{ type: 'text', text: 'this is definitely not json {{{}' }]))
    await assert.rejects(planDAG('goal'))
  })

  it('throws when a task references an unknown dependency', async () => {
    const badPlan = {
      tasks: [{
        id: 'task_1', title: 'T', description: 'D',
        dependencies: ['ghost_task_99'], complexity: 'low',
        docker_image: 'node:22-alpine', completion_criteria: [], tests: [],
      }],
    }
    _setClient(mockClient(textResponse(badPlan)))
    await assert.rejects(planDAG('goal'), /unknown dependency/i)
  })

  it('throws when text block contains an empty object', async () => {
    _setClient(mockClient([{ type: 'text', text: '{}' }]))
    await assert.rejects(planDAG('goal'))
  })

  it('accepts a plan with no inter-task dependencies (all independent)', async () => {
    const parallelPlan = {
      tasks: [
        { id: 't1', title: 'A', description: 'D', dependencies: [], complexity: 'low', docker_image: 'node:22-alpine', completion_criteria: [], tests: [] },
        { id: 't2', title: 'B', description: 'D', dependencies: [], complexity: 'low', docker_image: 'node:22-alpine', completion_criteria: [], tests: [] },
      ],
    }
    _setClient(mockClient(textResponse(parallelPlan)))
    const tasks = await planDAG('goal')
    assert.equal(tasks.length, 2)
  })
})

// ─── Error propagation ────────────────────────────────────────────────────────

describe('planDAG — error propagation', () => {
  it('propagates API errors from the client', async () => {
    _setClient({ messages: { create: async () => { throw new Error('API rate limit exceeded') } } })
    await assert.rejects(planDAG('goal'), /API rate limit exceeded/)
  })

  it('propagates network-style errors', async () => {
    _setClient({ messages: { create: async () => { throw new Error('ECONNREFUSED') } } })
    await assert.rejects(planDAG('goal'), /ECONNREFUSED/)
  })
})

// ─── Schema validation ────────────────────────────────────────────────────────

describe('PLAN_SCHEMA', () => {
  function checkAdditionalProperties(schema, path = 'PLAN_SCHEMA') {
    if (schema.type === 'object') {
      assert.equal(
        schema.additionalProperties, false,
        `${path} is missing additionalProperties: false — Anthropic API will reject it`
      )
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      checkAdditionalProperties(child, `${path}.${key}`)
    }
    if (schema.items) checkAdditionalProperties(schema.items, `${path}[]`)
  }

  it('every object type has additionalProperties: false', () => {
    checkAdditionalProperties(PLAN_SCHEMA)
  })
})
