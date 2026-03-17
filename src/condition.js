/**
 * Condition evaluator for branch and while task types.
 *
 * Three modes, auto-detected by prefix:
 *   "exit: <cmd>"   — run shell command, true if exit code 0
 *   "js: <expr>"    — evaluate JS expression with `result` in scope
 *   (anything else) — ask Claude (Haiku) to judge true/false
 */

import { execSync } from 'child_process'
import Anthropic from '@anthropic-ai/sdk'

let _client = null
function getClient() {
  if (!_client) _client = new Anthropic()
  return _client
}
/** Override client — used by tests. */
export function _setClient(c) { _client = c }

export function detectConditionMode(conditionString) {
  if (conditionString.startsWith('exit:')) return 'shell'
  if (conditionString.startsWith('js:')) return 'js'
  return 'natural'
}

/**
 * Evaluate a condition string and return true/false.
 *
 * @param {string} conditionString
 * @param {{ session, task, lastResult: string }} context
 * @returns {Promise<boolean>}
 */
export async function evaluateCondition(conditionString, { session, task, lastResult = '' }) {
  const mode = detectConditionMode(conditionString)

  if (mode === 'shell') {
    const cmd = conditionString.slice('exit:'.length).trim()
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 30_000 })
      return true
    } catch {
      return false
    }
  }

  if (mode === 'js') {
    const expr = conditionString.slice('js:'.length).trim()
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('result', 'session', `return !!(${expr})`)
      return fn(lastResult, session)
    } catch (err) {
      throw new Error(`JS condition eval failed: ${err.message}`)
    }
  }

  // Natural language — ask Claude Haiku
  const recentResults = Object.values(session.dag.tasks)
    .filter(t => t.status === 'completed' && t.result)
    .sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at))
    .slice(-3)
    .map(t => `[${t.id}] ${t.title}:\n${t.result.slice(0, 400)}`)
    .join('\n\n')

  const prompt = `You are evaluating a condition for a workflow step.

Condition: "${conditionString}"

Recent task results:
${recentResults || '(none yet)'}

Respond with exactly one word: "true" or "false".`

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content.find(b => b.type === 'text')?.text?.trim().toLowerCase()
  return text === 'true'
}
