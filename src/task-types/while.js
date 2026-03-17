/**
 * while task type — loops by spawning a body task + next while-check per iteration.
 *
 * Schema fields:
 *   condition       string   evaluated after each iteration to decide whether to continue
 *   body            string   task ID of the template task to clone per iteration
 *   max_iterations  number   safety limit (default 5)
 *
 * Each invocation either:
 *   - Spawns body_N + while_check_N tasks (condition true / first run)
 *   - Marks itself complete (condition false or max_iterations reached)
 *
 * The DAG stays acyclic because each iteration creates new task IDs with
 * strictly forward dependencies.
 */

import { cloneTask } from '../template.js'
import { evaluateCondition } from '../condition.js'
import { insertDynamicTasks } from '../state.js'

export async function executeWhile(session, task, _onChunk) {
  const maxIter = task.max_iterations ?? 5
  const iterCount = task.iteration_count ?? 0

  // Safety: never exceed max_iterations
  if (iterCount >= maxIter) {
    return `while: max_iterations (${maxIter}) reached — exiting loop.`
  }

  // Get last body result for condition evaluation (or last dependency result on first run)
  const lastBodyId = iterCount > 0 ? `${task.body}_${task.id}_body_${iterCount - 1}` : null
  const lastDep = lastBodyId
    ? lastBodyId
    : task.dependencies[task.dependencies.length - 1]
  const lastResult = lastDep ? (session.dag.tasks[lastDep]?.result ?? '') : ''

  // On first iteration: always enter the loop (skip condition check)
  // On subsequent iterations: evaluate condition against last body result
  let shouldContinue = true
  if (iterCount > 0) {
    shouldContinue = await evaluateCondition(task.condition, { session, task, lastResult })
  }

  if (!shouldContinue) {
    return `while: condition "${task.condition}" → false after iteration ${iterCount} — exiting loop.`
  }

  // Spawn body task for this iteration
  const bodyTemplate = session.dag.tasks[task.body]
  if (!bodyTemplate) throw new Error(`while: body template "${task.body}" not found`)

  const bodyId = `${task.body}_${task.id}_body_${iterCount}`
  const bodyTask = cloneTask(bodyTemplate, bodyId, { iteration: iterCount, i: iterCount })
  bodyTask.dependencies = [task.id]

  // Spawn next while-check task (runs after body completes)
  const nextWhileId = `${task.id}_check_${iterCount + 1}`
  const nextWhile = cloneTask(task, nextWhileId, {})
  nextWhile.id = nextWhileId
  nextWhile.dependencies = [bodyId]
  nextWhile.iteration_count = iterCount + 1
  nextWhile.status = 'pending'

  // Mark body template as skipped on first iteration
  if (iterCount === 0 && session.dag.tasks[task.body]) {
    session.dag.tasks[task.body].status = 'skipped'
  }

  insertDynamicTasks(session, [bodyTask, nextWhile])

  if (_onChunk) _onChunk(`while: iteration ${iterCount} — spawned ${bodyId} + ${nextWhileId}\n`)
  return `while: iteration ${iterCount} started. Body: ${bodyId}. Next check: ${nextWhileId}.`
}
