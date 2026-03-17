import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { executeTask, _setClient, COMPLEXITY_MODEL_MAP } from '../src/executor.js'

// ─── Mock client ──────────────────────────────────────────────────────────────

/**
 * Returns a mock Anthropic client whose create() immediately returns
 * a single text block with stop_reason 'end_turn'.
 * Pass an Error instance to simulate an API failure.
 */
function mockClient(textOrError) {
  return {
    messages: {
      create(params) {
        if (textOrError instanceof Error) throw textOrError
        return {
          content: [{ type: 'text', text: textOrError }],
          stop_reason: 'end_turn',
        }
      },
    },
  }
}

/** Minimal session fixture. */
function session(extraTasks = {}) {
  return {
    id: 'sess_test',
    goal: 'Build a calendar CLI app',
    dag: { tasks: extraTasks, order: Object.keys(extraTasks) },
  }
}

/** Minimal task fixture. */
function task(overrides = {}) {
  return {
    id: 'task_1',
    title: 'Project scaffold',
    description: 'Init npm project',
    complexity: 'medium',
    docker_image: 'node:22-alpine',
    completion_criteria: ['package.json exists'],
    tests: ['node --version'],
    result: null,
    ...overrides,
  }
}

beforeEach(() => {
  _setClient(mockClient('## Result\nDone.\n\n## Summary\nScaffolded the project.'))
})

// ─── Model selection by complexity ───────────────────────────────────────────

describe('model selection', () => {
  for (const [complexity, expectedModel] of Object.entries(COMPLEXITY_MODEL_MAP)) {
    it(`complexity "${complexity}" uses model ${expectedModel}`, async () => {
      let usedModel
      _setClient({
        messages: {
          create(params) {
            usedModel = params.model
            return { content: [{ type: 'text', text: '## Summary\nDone.' }], stop_reason: 'end_turn' }
          },
        },
      })
      await executeTask(session(), task({ complexity }), () => {})
      assert.equal(usedModel, expectedModel)
    })
  }

  it('falls back to opus for unknown complexity', async () => {
    let usedModel
    _setClient({
      messages: {
        create(params) {
          usedModel = params.model
          return { content: [{ type: 'text', text: '## Summary\nDone.' }], stop_reason: 'end_turn' }
        },
      },
    })
    await executeTask(session(), task({ complexity: 'unknown' }), () => {})
    assert.equal(usedModel, COMPLEXITY_MODEL_MAP.high)
  })
})

// ─── Return value ─────────────────────────────────────────────────────────────

describe('return value', () => {
  it('returns the full text from a single text block', async () => {
    _setClient(mockClient('hello world'))
    const result = await executeTask(session(), task())
    assert.equal(result, 'hello world')
  })

  it('joins multiple text blocks with newline', async () => {
    _setClient({
      messages: {
        create() {
          return {
            content: [
              { type: 'text', text: 'foo' },
              { type: 'text', text: 'bar' },
              { type: 'text', text: 'baz' },
            ],
            stop_reason: 'end_turn',
          }
        },
      },
    })
    const result = await executeTask(session(), task())
    assert.equal(result, 'foo\nbar\nbaz')
  })

  it('ignores non-text blocks (thinking, tool_use)', async () => {
    _setClient({
      messages: {
        create() {
          return {
            content: [
              { type: 'thinking', thinking: 'ignore me' },
              { type: 'text', text: 'real' },
            ],
            stop_reason: 'end_turn',
          }
        },
      },
    })
    const result = await executeTask(session(), task())
    assert.equal(result, 'real')
  })

  it('collects text across multiple agentic loop turns', async () => {
    let call = 0
    _setClient({
      messages: {
        create() {
          call++
          if (call === 1) {
            return {
              content: [
                { type: 'text', text: 'thinking...' },
                { type: 'tool_use', id: 'tu_1', name: 'run_command', input: { command: 'echo hi' } },
              ],
              stop_reason: 'tool_use',
            }
          }
          return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }
        },
      },
    })
    const result = await executeTask(session(), task())
    assert.equal(result, 'thinking...\ndone')
  })
})

// ─── onChunk callback ─────────────────────────────────────────────────────────

describe('onChunk callback', () => {
  it('calls onChunk for each text block', async () => {
    _setClient({
      messages: {
        create() {
          return {
            content: [
              { type: 'text', text: 'chunk1' },
              { type: 'text', text: 'chunk2' },
            ],
            stop_reason: 'end_turn',
          }
        },
      },
    })
    const chunks = []
    await executeTask(session(), task(), c => chunks.push(c))
    assert.deepEqual(chunks, ['chunk1', 'chunk2'])
  })

  it('calls onChunk for tool_use blocks with tool name', async () => {
    let call = 0
    _setClient({
      messages: {
        create() {
          call++
          if (call === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: '/workspace/x', content: 'y' } }],
              stop_reason: 'tool_use',
            }
          }
          return { content: [], stop_reason: 'end_turn' }
        },
      },
    })
    const chunks = []
    await executeTask(session(), task(), c => chunks.push(c))
    // onChunk called for tool invocation and for tool result
    assert.ok(chunks.some(c => c.includes('write_file')))
  })

  it('works fine when onChunk is not provided', async () => {
    await assert.doesNotReject(executeTask(session(), task()))
  })
})

// ─── Prompt content ───────────────────────────────────────────────────────────

describe('prompt content', () => {
  let capturedPrompt

  beforeEach(() => {
    _setClient({
      messages: {
        create(params) {
          capturedPrompt = params.messages[0].content
          return { content: [{ type: 'text', text: '## Summary\nDone.' }], stop_reason: 'end_turn' }
        },
      },
    })
  })

  it('includes the session goal', async () => {
    await executeTask(session(), task())
    assert.ok(capturedPrompt.includes('Build a calendar CLI app'))
  })

  it('includes the task title and description', async () => {
    await executeTask(session(), task({ title: 'My Task', description: 'Do the thing' }))
    assert.ok(capturedPrompt.includes('My Task'))
    assert.ok(capturedPrompt.includes('Do the thing'))
  })

  it('includes completion_criteria when present', async () => {
    await executeTask(session(), task({ completion_criteria: ['file.js must exist'] }))
    assert.ok(capturedPrompt.includes('file.js must exist'))
  })

  it('includes test commands when present', async () => {
    await executeTask(session(), task({ tests: ['npm test', 'curl localhost:3000'] }))
    assert.ok(capturedPrompt.includes('npm test'))
    assert.ok(capturedPrompt.includes('curl localhost:3000'))
  })

  it('includes the docker_image as the runtime', async () => {
    await executeTask(session(), task({ docker_image: 'python:3.12-slim' }))
    assert.ok(capturedPrompt.includes('python:3.12-slim'))
  })

  it('includes completed-task summaries as context', async () => {
    const completedTask = {
      id: 'task_0',
      title: 'Prior Task',
      status: 'completed',
      result: '## Result\nDid something.\n\n## Summary\nBuilt the foundation.',
      completed_at: new Date().toISOString(),
      dependencies: [],
    }
    const s = session({ task_0: completedTask })
    await executeTask(s, task())
    assert.ok(capturedPrompt.includes('Built the foundation'))
  })

  it('notes previous attempt when task.result is already set (retry)', async () => {
    const retryTask = task({ result: 'previous failed attempt output' })
    await executeTask(session(), retryTask)
    assert.ok(capturedPrompt.includes('previously attempted'))
    assert.ok(capturedPrompt.includes('previous failed attempt output'))
  })
})

// ─── Error propagation ────────────────────────────────────────────────────────

describe('error propagation', () => {
  it('propagates API errors thrown by create()', async () => {
    _setClient(mockClient(new Error('API quota exceeded')))
    await assert.rejects(executeTask(session(), task()), /API quota exceeded/)
  })

  it('propagates errors thrown by create() in subsequent loop iterations', async () => {
    let call = 0
    _setClient({
      messages: {
        create() {
          call++
          if (call === 1) {
            return {
              content: [{ type: 'tool_use', id: 'tu_1', name: 'run_command', input: { command: 'echo hi' } }],
              stop_reason: 'tool_use',
            }
          }
          throw new Error('stream interrupted')
        },
      },
    })
    await assert.rejects(executeTask(session(), task()), /stream interrupted/)
  })
})
