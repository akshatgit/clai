import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { executeTask, _setClient, COMPLEXITY_MODEL_MAP } from '../src/executor.js'

// ─── Mock streaming client ────────────────────────────────────────────────────

/**
 * Returns a mock Anthropic client whose stream() yields the given text as a
 * single text_delta event, then calls finalMessage().
 * Pass an Error instance to simulate an API failure.
 */
function mockClient(textOrError) {
  return {
    messages: {
      stream(params) {
        if (textOrError instanceof Error) throw textOrError
        const text = textOrError
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text } }
          },
          finalMessage: async () => ({}),
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
          stream(params) {
            usedModel = params.model
            return {
              [Symbol.asyncIterator]: async function* () {
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '## Summary\nDone.' } }
              },
              finalMessage: async () => ({}),
            }
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
        stream(params) {
          usedModel = params.model
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '## Summary\nDone.' } }
            },
            finalMessage: async () => ({}),
          }
        },
      },
    })
    await executeTask(session(), task({ complexity: 'unknown' }), () => {})
    assert.equal(usedModel, COMPLEXITY_MODEL_MAP.high)
  })
})

// ─── Return value ─────────────────────────────────────────────────────────────

describe('return value', () => {
  it('returns the full streamed text', async () => {
    _setClient(mockClient('hello world'))
    const result = await executeTask(session(), task())
    assert.equal(result, 'hello world')
  })

  it('concatenates multiple text chunks', async () => {
    _setClient({
      messages: {
        stream() {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'foo' } }
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'bar' } }
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'baz' } }
            },
            finalMessage: async () => ({}),
          }
        },
      },
    })
    const result = await executeTask(session(), task())
    assert.equal(result, 'foobarbaz')
  })

  it('ignores non-text_delta events', async () => {
    _setClient({
      messages: {
        stream() {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'content_block_start', index: 0 }
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'real' } }
              yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'ignore me' } }
              yield { type: 'message_delta', usage: {} }
            },
            finalMessage: async () => ({}),
          }
        },
      },
    })
    const result = await executeTask(session(), task())
    assert.equal(result, 'real')
  })
})

// ─── onChunk streaming ────────────────────────────────────────────────────────

describe('onChunk callback', () => {
  it('calls onChunk for each text chunk as it arrives', async () => {
    _setClient({
      messages: {
        stream() {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk1' } }
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk2' } }
            },
            finalMessage: async () => ({}),
          }
        },
      },
    })
    const chunks = []
    await executeTask(session(), task(), c => chunks.push(c))
    assert.deepEqual(chunks, ['chunk1', 'chunk2'])
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
        stream(params) {
          capturedPrompt = params.messages[0].content
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '## Summary\nDone.' } }
            },
            finalMessage: async () => ({}),
          }
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
  it('propagates API errors thrown by stream()', async () => {
    _setClient(mockClient(new Error('API quota exceeded')))
    await assert.rejects(executeTask(session(), task()), /API quota exceeded/)
  })

  it('propagates errors thrown inside the async iterator', async () => {
    _setClient({
      messages: {
        stream() {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }
              throw new Error('stream interrupted')
            },
            finalMessage: async () => ({}),
          }
        },
      },
    })
    await assert.rejects(executeTask(session(), task()), /stream interrupted/)
  })
})
