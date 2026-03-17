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

let _executor = _defaultExecutor
/** Override the task executor — used by tests to inject mock responses. */
export function _setExecutor(fn) { _executor = fn }
export function _resetExecutor() { _executor = _defaultExecutor }

/**
 * Run all pending tasks in a session (topological order), or re-run one task.
 *
 * @param {object} session
 * @param {{ verbose?: boolean, targetTaskId?: string, onChunk?: Function }} opts
 */
export async function runSessionTasks(session, opts = {}) {
  const { verbose = false, targetTaskId = null, onChunk } = opts

  if (targetTaskId) {
    resetTask(session, targetTaskId)
    session = loadSession(session.id)
    await runSingleTask(session, targetTaskId, { onChunk: verbose ? onChunk : null })
    return
  }

  session.status = 'running'
  session.started_at ??= new Date().toISOString()
  saveSession(session)

  emit('session:started', { sessionId: session.id, goal: session.goal })

  const sessionStart = Date.now()

  while (true) {
    session = loadSession(session.id)

    // Mark tasks blocked by failed/skipped dependencies
    const blocked = getBlockedTasks(session.dag.tasks)
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

    const ready = getReadyTasks(session.dag.tasks, session.dag.order)
    if (ready.length === 0) break

    await runSingleTask(session, ready[0], { onChunk: verbose ? onChunk : null })
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
 * @param {{ onChunk?: Function }} opts
 */
export async function runSingleTask(session, taskId, opts = {}) {
  const { onChunk } = opts

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
    const result = await _executor(session, task, onChunk ?? null)

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
