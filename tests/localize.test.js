import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { localizeIssue } from '../src/localize.js'
import { _setClient } from '../src/client.js'

// ─── Mock helpers ─────────────────────────────────────────────────────────────

let lastParams = null

function mockClient(handler) {
  return {
    messages: {
      create: async (params) => {
        lastParams = params
        return handler(params)
      },
    },
  }
}

/** Returns a response that immediately calls submit_report */
function submitReportResponse(report) {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'submit_report',
        input: report,
      },
    ],
  }
}

const VALID_REPORT = {
  summary: 'The bug is in the parser.',
  relevant_files: [
    { path: 'src/parser.js', reason: 'Contains the buggy function', key_lines: [42] },
  ],
  fix_hypothesis: 'Change the regex on line 42 to handle edge case.',
}

beforeEach(() => {
  lastParams = null
  _setClient(mockClient(() => submitReportResponse(VALID_REPORT)))
})

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('localizeIssue — happy path', () => {
  it('returns the report from submit_report', async () => {
    const report = await localizeIssue('Bug: parser fails on empty input', '/tmp/repo')
    assert.equal(report.summary, VALID_REPORT.summary)
    assert.equal(report.fix_hypothesis, VALID_REPORT.fix_hypothesis)
  })

  it('returns relevant_files array', async () => {
    const report = await localizeIssue('issue', '/tmp/repo')
    assert.ok(Array.isArray(report.relevant_files))
    assert.equal(report.relevant_files[0].path, 'src/parser.js')
  })

  it('uses MODELS.medium (claude-sonnet-4-6)', async () => {
    await localizeIssue('issue', '/tmp/repo')
    assert.equal(lastParams.model, 'claude-sonnet-4-6')
  })

  it('includes the issue text in the prompt', async () => {
    await localizeIssue('my specific bug description', '/tmp/repo')
    const userMsg = lastParams.messages[0].content
    assert.ok(userMsg.includes('my specific bug description'))
  })

  it('includes the repoPath in the prompt', async () => {
    await localizeIssue('issue', '/some/special/repo/path')
    const userMsg = lastParams.messages[0].content
    assert.ok(userMsg.includes('/some/special/repo/path'))
  })
})

// ─── Tool schema validation ────────────────────────────────────────────────────

describe('localizeIssue — request structure', () => {
  it('sends tools array with 6 tools', async () => {
    await localizeIssue('issue', '/tmp/repo')
    assert.equal(lastParams.tools.length, 6)
  })

  it('includes submit_report tool', async () => {
    await localizeIssue('issue', '/tmp/repo')
    const names = lastParams.tools.map(t => t.name)
    assert.ok(names.includes('submit_report'))
  })

  it('every tool has a name and input_schema', async () => {
    await localizeIssue('issue', '/tmp/repo')
    for (const tool of lastParams.tools) {
      assert.ok(tool.name, `tool missing name`)
      assert.ok(tool.input_schema, `tool ${tool.name} missing input_schema`)
      assert.equal(tool.input_schema.type, 'object', `tool ${tool.name} input_schema must have type: 'object'`)
    }
  })

  it('does NOT use output_config (incompatible with tools)', async () => {
    await localizeIssue('issue', '/tmp/repo')
    assert.ok(!lastParams.output_config, 'output_config must not be used alongside tools')
  })

  it('does NOT include thinking parameter', async () => {
    await localizeIssue('issue', '/tmp/repo')
    assert.ok(!lastParams.thinking, 'thinking parameter must not be present')
  })

  it('max_tokens is set', async () => {
    await localizeIssue('issue', '/tmp/repo')
    assert.ok(lastParams.max_tokens > 0)
  })
})

// ─── Multi-turn loop ──────────────────────────────────────────────────────────

describe('localizeIssue — multi-turn', () => {
  it('iterates until submit_report is called', async () => {
    let callCount = 0
    _setClient(mockClient(() => {
      callCount++
      if (callCount < 3) {
        return {
          stop_reason: 'tool_use',
          content: [{
            type: 'tool_use', id: `tu_${callCount}`, name: 'get_file_tree', input: {},
          }],
        }
      }
      return submitReportResponse(VALID_REPORT)
    }))
    const report = await localizeIssue('issue', '/tmp/repo')
    assert.equal(callCount, 3)
    assert.equal(report.summary, VALID_REPORT.summary)
  })

  it('throws if model returns end_turn without submit_report', async () => {
    _setClient(mockClient(() => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I am done.' }],
    })))
    await assert.rejects(
      localizeIssue('issue', '/tmp/repo'),
      /without calling submit_report/i,
    )
  })
})

// ─── Prior attempts context ───────────────────────────────────────────────────

describe('localizeIssue — prior attempts', () => {
  it('includes prior attempt context when provided', async () => {
    const priorAttempts = [{
      localization: {
        relevant_files: [{ path: 'src/old.js', reason: 'thought it was here' }],
        fix_hypothesis: 'tried changing line 5',
      },
      patchedFiles: ['src/old.js'],
      testOutput: 'FAILED: test_foo',
    }]
    await localizeIssue('issue', '/tmp/repo', null, priorAttempts)
    const userMsg = lastParams.messages[0].content
    assert.ok(userMsg.includes('Prior Fix Attempts'))
    assert.ok(userMsg.includes('src/old.js'))
  })

  it('does not include prior context for empty prior attempts', async () => {
    await localizeIssue('issue', '/tmp/repo', null, [])
    const userMsg = lastParams.messages[0].content
    assert.ok(!userMsg.includes('Prior Fix Attempts'))
  })
})

// ─── Error propagation ────────────────────────────────────────────────────────

describe('localizeIssue — error propagation', () => {
  it('propagates API errors', async () => {
    _setClient(mockClient(() => { throw new Error('ECONNREFUSED') }))
    await assert.rejects(localizeIssue('issue', '/tmp/repo'), /ECONNREFUSED/)
  })
})
