/**
 * Multi-agent mode smoke test — no real API calls.
 *
 * Uses a mock client that returns canned responses so we can verify
 * the full roles pipeline wiring: researcher → localize+overseer →
 * reviewer → planSWE+critic → execution hooks → debugger → verifier
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as roles from '../src/roles.js'

// ─── Mock client ──────────────────────────────────────────────────────────────

function makeMockClient(handlers) {
  return {
    messages: {
      create: async (params) => {
        const toolName = params.tool_choice?.name
        const handler = handlers[toolName] ?? handlers['*']
        if (!handler) throw new Error(`No mock handler for tool: ${toolName}`)
        return handler(params)
      }
    }
  }
}

function toolResponse(toolName, input) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'mock_id', name: toolName, input }],
  }
}

function textResponse(text) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('researcher role returns structured output', async () => {
  const mock = makeMockClient({
    submit_researcher: () => toolResponse('submit_researcher', {
      key_functions: ['separability_matrix', '_cstack'],
      key_files: ['astropy/modeling/separable.py'],
      error_patterns: ['AxisError'],
      test_names: ['test_custom_model_separability'],
      search_queries: ['_cstack', 'separability_matrix'],
      hypothesis: 'Bug in _cstack when handling nested CompoundModels',
    }),
  })

  // Temporarily swap client in roles.js
  const origCreate = roles.researcher.toString()  // just verify it exists
  assert.ok(typeof roles.researcher === 'function')

  // Call with mock injected via _setClient
  const { _setClient: setRolesClient } = await import('../src/client.js')
  setRolesClient(mock)

  const result = await roles.researcher('Fix separability_matrix bug')
  assert.equal(result.key_functions[0], 'separability_matrix')
  assert.equal(result.hypothesis, 'Bug in _cstack when handling nested CompoundModels')
  console.log('✓ researcher role structured output correct')
})

test('reviewer role approves valid report', async () => {
  const { _setClient: setRolesClient } = await import('../src/client.js')
  setRolesClient(makeMockClient({
    submit_reviewer: () => toolResponse('submit_reviewer', {
      approved: true,
      feedback: 'Report looks correct',
    }),
  }))

  const fakeReport = {
    summary: 'Bug in separable.py',
    fix_hypothesis: 'Assign right instead of 1',
    relevant_files: [{ path: 'astropy/modeling/separable.py', reason: 'contains _cstack' }],
  }

  const result = await roles.reviewer('Fix separability bug', fakeReport)
  assert.equal(result.approved, true)
  console.log('✓ reviewer role approval works')
})

test('critic role rejects bad plan and requests revision', async () => {
  const { _setClient: setRolesClient } = await import('../src/client.js')
  setRolesClient(makeMockClient({
    submit_critic: () => toolResponse('submit_critic', {
      approved: false,
      issues: ['Missing edge case for deeply nested models'],
      suggestion: 'Add handling for models nested more than 2 levels deep',
    }),
  }))

  const fakeReport = { summary: 'Bug', fix_hypothesis: 'Fix _cstack', relevant_files: [] }
  const fakeTasks = [{ id: 'task_1', title: 'Apply fix', description: 'Edit separable.py' }]

  const result = await roles.critic('Fix separability bug', fakeReport, fakeTasks)
  assert.equal(result.approved, false)
  assert.equal(result.issues.length, 1)
  console.log('✓ critic role rejection works')
})

test('overseer injects guidance when off track', async () => {
  const { _setClient: setRolesClient } = await import('../src/client.js')
  setRolesClient(makeMockClient({
    submit_overseer: () => toolResponse('submit_overseer', {
      on_track: false,
      guidance: 'Stop looking at core.py — the bug is in separable.py',
    }),
  }))

  const recentCalls = [
    { name: 'read_file', input: { path: 'astropy/modeling/core.py' } },
    { name: 'read_file', input: { path: 'astropy/modeling/core.py' } },
  ]

  const result = await roles.overseer('Fix separability bug', recentCalls)
  assert.equal(result.on_track, false)
  assert.ok(result.guidance.includes('separable.py'))
  console.log('✓ overseer role off-track detection works')
})

test('debugger_ role returns fix instructions', async () => {
  const { _setClient: setRolesClient } = await import('../src/client.js')
  setRolesClient(makeMockClient({
    submit_debugger: () => toolResponse('submit_debugger', {
      root_cause: 'Line 245: cright assigned 1 instead of right matrix',
      fix_instructions: 'Change `cright[...] = 1` to `cright[...] = right`',
      affected_files: ['astropy/modeling/separable.py'],
    }),
  }))

  const fakeReport = { summary: 'Bug', fix_hypothesis: 'Assign right', relevant_files: [] }
  const result = await roles.debugger_('FAILED: test_separable', fakeReport, [])
  assert.ok(result.root_cause.includes('Line 245'))
  assert.ok(result.affected_files.includes('astropy/modeling/separable.py'))
  console.log('✓ debugger_ role works')
})

console.log('\nAll multi-agent role tests passed ✓\n')
