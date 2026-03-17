/**
 * Core orchestration loop — loads sessions, runs tasks in DAG order,
 * emits lifecycle events, and persists state after every transition.
 *
 * Kept separate from the CLI so it can be imported and tested independently.
 */

import { loadSession, saveSession, resetTask } from './state.js'
import { emit } from './hooks.js'
import { getReadyTasks, getBlockedTasks, getStats } from './dag.js'
import { executeTask as _defaultExecutor } from './executor.js'
import { runTaskInDocker } from './docker.js'
import { executeBranch } from './task-types/branch.js'
import { executeBarrier, BARRIER_PENDING } from './task-types/barrier.js'
import { executeForEach } from './task-types/for-each.js'
import { executeWhile } from './task-types/while.js'
import { executeWait } from './task-types/wait.js'

let _executor = _defaultExecutor
/** Override the execute-type task executor — used by tests. */
export function _setExecutor(fn) { _executor = fn }
export function _resetExecutor() { _executor = _defaultExecutor }

/**
 * Dispatch to the correct handler based on task.type.
 * dockerOpts = { useDocker, repoPath } — passed down to executeWhile so the
 * condition evaluator can run shell conditions inside the right container.
 */
async function dispatchTask(session, task, onChunk, dockerOpts = {}) {
  const { useDocker = false, repoPath = null } = dockerOpts
  const type = task.type ?? 'execute'

  switch (type) {
    case 'execute':
      if (useDocker) return runTaskInDocker(session, task, onChunk, { repoPath })
      return _executor(session, task, onChunk)

    case 'branch':   return executeBranch(session, task, onChunk)
    case 'for_each': return executeForEach(session, task, onChunk)
    case 'while':    return executeWhile(session, task, onChunk, dockerOpts)
    case 'barrier':  return executeBarrier(session, task, onChunk)
    case 'wait':     return executeWait(session, task, onChunk)
    default: throw new Error(`Unknown task type: "${type}"`)
  }
}

/**
 * Run all pending tasks in a session (topological order), or re-run one task.
 *
 * @param {object} session
 * @param {{ verbose?: boolean, targetTaskId?: string, onChunk?: Function,
 *           useDocker?: boolean, repoPath?: string }} opts
 */
export async function runSessionTasks(session, opts = {}) {
  const { verbose = false, targetTaskId = null, onChunk, useDocker = false, repoPath = null } = opts
  const dockerOpts = { useDocker, repoPath }

  if (targetTaskId) {
    resetTask(session, targetTaskId)
    session = loadSession(session.id)
    await runSingleTask(session, targetTaskId, { onChunk: verbose ? onChunk : null, ...dockerOpts })
    return
  }

  session.status = 'running'
  session.started_at ??= new Date().toISOString()
  saveSession(session)

  emit('session:started', { sessionId: session.id, goal: session.goal })

  const sessionStart = Date.now()

  while (true) {
    session = loadSession(session.id)

    // Propagate skips transitively — one pass only catches direct deps,
    // so loop until no new tasks are blocked (e.g. A→B→C: C only appears
    // after B is already marked skipped)
    let blocked
    do {
      blocked = getBlockedTasks(session.dag.tasks)
      for (const id of blocked) {
        session.dag.tasks[id].status = 'skipped'
        emit('task:skipped', {
          sessionId: session.id,
          taskId: id,
          taskTitle: session.dag.tasks[id].title,
          reason: 'dependency failed or skipped',
        })
      }
      if (blocked.length > 0) saveSession(session)
    } while (blocked.length > 0)

    const ready = getReadyTasks(session.dag.tasks, session.dag.order)
    if (ready.length === 0) break

    await runSingleTask(session, ready[0], { onChunk: verbose ? onChunk : null, ...dockerOpts })
  }

  session = loadSession(session.id)
  const stats = getStats(session.dag.tasks)

  if (stats.pending === 0 && stats.running === 0) {
    session.status = stats.failed > 0 ? 'failed' : 'completed'
    session.completed_at = new Date().toISOString()
    saveSession(session)

    emit('session:completed', {
      sessionId: session.id,
      goal: session.goal,
      duration: Date.now() - sessionStart,
      stats,
    })
  }
}

/**
 * Run a single task, update its state, and emit lifecycle events.
 *
 * @param {object} session
 * @param {string} taskId
 * @param {{ onChunk?: Function, useDocker?: boolean, repoPath?: string }} opts
 */
export async function runSingleTask(session, taskId, opts = {}) {
  const { onChunk, useDocker = false, repoPath = null } = opts
  const dockerOpts = { useDocker, repoPath }

  // Reload to ensure we have latest state (prev task may have updated session)
  session = loadSession(session.id)
  const task = session.dag.tasks[taskId]

  task.status = 'running'
  task.started_at = new Date().toISOString()
  task.attempts = (task.attempts || 0) + 1
  saveSession(session)

  emit('task:started', {
    sessionId: session.id,
    taskId,
    taskTitle: task.title,
    attempt: task.attempts,
  })

  const taskStart = Date.now()

  try {
    const result = await dispatchTask(session, task, onChunk ?? null, dockerOpts)

    // Barrier not ready — reset to pending and return silently
    if (result === BARRIER_PENDING) {
      session = loadSession(session.id)
      session.dag.tasks[taskId].status = 'pending'
      session.dag.tasks[taskId].started_at = null
      session.dag.tasks[taskId].attempts = Math.max(0, (task.attempts || 1) - 1)
      saveSession(session)
      return
    }

    session = loadSession(session.id)
    session.dag.tasks[taskId].status = 'completed'
    session.dag.tasks[taskId].result = result
    session.dag.tasks[taskId].completed_at = new Date().toISOString()
    saveSession(session)

    emit('task:completed', {
      sessionId: session.id,
      taskId,
      taskTitle: task.title,
      duration: Date.now() - taskStart,
      resultLength: result.length,
    })

    return result
  } catch (err) {
    session = loadSession(session.id)
    session.dag.tasks[taskId].status = 'failed'
    session.dag.tasks[taskId].completed_at = new Date().toISOString()
    session.dag.tasks[taskId].error = err.message
    saveSession(session)

    emit('task:failed', {
      sessionId: session.id,
      taskId,
      taskTitle: task.title,
      error: err.message,
      duration: Date.now() - taskStart,
    })
    // Do not re-throw — the loop continues; blocked dependents will be skipped
  }
}
