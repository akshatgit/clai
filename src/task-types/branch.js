/**
 * branch task type — evaluates a condition and activates one of two paths.
 *
 * Schema fields:
 *   condition  string   condition to evaluate (natural / "exit: cmd" / "js: expr")
 *   on_true    string[] task IDs to keep active if condition is true
 *   on_false   string[] task IDs to skip if condition is true (and vice versa)
 *
 * Both on_true and on_false tasks must already exist in the static DAG.
 * Branch only activates/skips — it never inserts new tasks.
 */

import { evaluateCondition } from '../condition.js'
import { saveSession } from '../state.js'

export async function executeBranch(session, task, _onChunk) {
  // Determine the last completed dependency's result as context
  const lastDep = task.dependencies[task.dependencies.length - 1]
  const lastResult = lastDep ? (session.dag.tasks[lastDep]?.result ?? '') : ''

  const result = await evaluateCondition(task.condition, { session, task, lastResult })

  const activated = result ? task.on_true : task.on_false
  const skipped   = result ? task.on_false : task.on_true

  // Mark losing-path tasks as skipped so getBlockedTasks cascades naturally
  for (const id of (skipped ?? [])) {
    if (session.dag.tasks[id]) {
      session.dag.tasks[id].status = 'skipped'
    }
  }
  saveSession(session)

  return `branch: condition "${task.condition}" → ${result ? 'true' : 'false'}. ` +
    `Activated: [${(activated ?? []).join(', ')}]. ` +
    `Skipped: [${(skipped ?? []).join(', ')}].`
}
