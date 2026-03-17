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
 *
 * dockerOpts = { useDocker, repoPath } is threaded through from runSessionTasks
 * so the shell condition check runs inside the session container (where test
 * dependencies are installed) rather than on the host.
 */

import { execSync } from 'child_process'
import { cloneTask } from '../template.js'
import { evaluateCondition } from '../condition.js'
import { insertDynamicTasks } from '../state.js'
import { containerName as getContainerName } from '../docker.js'

export async function executeWhile(session, task, _onChunk, dockerOpts = {}) {
  const { useDocker = false } = dockerOpts
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
  let conditionOutput = null  // test output captured when condition is checked

  if (iterCount > 0) {
    // When running in Docker, the condition shell command runs inside the session
    // container so it has access to the installed test dependencies.
    const dockerContainerName = useDocker ? getContainerName(session.id) : null

    // Capture test output for the condition check when it's a shell condition.
    // This output is injected into the next body task's description as context
    // so the body doesn't have to re-run tests from scratch to know what failed.
    if (task.condition.startsWith('exit:') && dockerContainerName) {
      conditionOutput = captureShellOutput(task.condition, dockerContainerName)
    }

    shouldContinue = await evaluateCondition(task.condition, {
      session,
      task,
      lastResult,
      dockerContainerName,
    })
  }

  if (!shouldContinue) {
    return `while: condition "${task.condition}" → false after iteration ${iterCount} — exiting loop.`
  }

  // Spawn body task for this iteration
  const bodyTemplate = session.dag.tasks[task.body]
  if (!bodyTemplate) throw new Error(`while: body template "${task.body}" not found`)

  const bodyId = `${task.body}_${task.id}_body_${iterCount}`

  // Inject test failure context into the body task description so it knows
  // exactly what to fix without needing to re-run tests first.
  const failureContext = conditionOutput
    ? `\n\n## Test Failures from Previous Check\nThe following tests are still failing — fix these:\n\`\`\`\n${conditionOutput.slice(0, 2000)}\n\`\`\``
    : ''

  const bodyTask = cloneTask(bodyTemplate, bodyId, { iteration: iterCount, i: iterCount })
  if (failureContext) {
    bodyTask.description = bodyTask.description + failureContext
  }
  bodyTask.dependencies = [task.id]

  // Spawn next while-check task (runs after body completes)
  const nextWhileId = `${task.id}_check_${iterCount + 1}`
  const nextWhile = cloneTask(task, nextWhileId, {})
  nextWhile.id = nextWhileId
  nextWhile.dependencies = [bodyId]
  nextWhile.iteration_count = iterCount + 1
  nextWhile.status = 'pending'

  // Mark body template as skipped on first iteration so it doesn't run standalone
  if (iterCount === 0 && session.dag.tasks[task.body]) {
    session.dag.tasks[task.body].status = 'skipped'
  }

  insertDynamicTasks(session, [bodyTask, nextWhile])

  if (_onChunk) _onChunk(`while: iteration ${iterCount} — spawned ${bodyId} + ${nextWhileId}\n`)
  return `while: iteration ${iterCount} started. Body: ${bodyId}. Next check: ${nextWhileId}.`
}

/**
 * Run the condition shell command and capture its output (stdout+stderr) for
 * context injection into the next body task, even if the command fails.
 *
 * Returns null if output cannot be captured (e.g. docker exec not available).
 */
function captureShellOutput(conditionString, dockerContainerName) {
  const innerCmd = conditionString.slice('exit:'.length).trim()

  // Strip leading "! " if present to get the actual test command
  const testCmd = innerCmd.startsWith('! ') ? innerCmd.slice(2).trim() : innerCmd

  const cmd = dockerContainerName
    ? `docker exec ${dockerContainerName} sh -c ${JSON.stringify(testCmd)}`
    : testCmd

  try {
    return execSync(cmd, { stdio: 'pipe', timeout: 60_000 }).toString()
  } catch (e) {
    // Non-zero exit is expected when tests fail — return the output anyway
    return ((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')) || null
  }
}
