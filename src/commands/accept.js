/**
 * Command handler for: clai accept <session-id> <task-id> [--message <text>]
 *
 * Manually marks a task as completed so downstream tasks can proceed.
 * Useful when the user has manually modified files inside a container
 * and wants to continue the session from that point.
 */
import { loadSession, saveSession } from '../state.js'
import { emit } from '../hooks.js'
import { getReadyTasks } from '../dag.js'

/**
 * Handler for `clai accept <session-id> <task-id>`.
 *
 * Steps:
 *  1. Load the session (errors if not found)
 *  2. Look up the task by ID in the session's DAG
 *  3. Warn if the task is already completed (but proceed anyway)
 *  4. Set task.status = 'completed'
 *  5. Set task.completed_at = current ISO timestamp
 *  6. Set task.result to --message text or 'Manually accepted'
 *  7. Persist the updated session
 *  8. Emit a task:completed event for the log trail
 *  9. Print confirmation and show newly ready downstream tasks
 *
 * @param {string}   sessionId - The session identifier
 * @param {string}   taskId    - The task identifier within the session
 * @param {object}   opts      - Commander options object
 * @param {string}   [opts.message] - Optional message to record as the task result
 * @param {object}   helpers   - Logging helpers injected from the CLI host
 * @param {function} helpers.fail    - Prints a red error line
 * @param {function} helpers.success - Prints a green success line
 * @param {function} helpers.warn    - Prints a yellow warning line
 * @param {function} helpers.info    - Prints a cyan info line
 */
export function acceptHandler(sessionId, taskId, opts, { fail, success, warn, info }) {
  // ── Step 1: Load session ────────────────────────────────────────────────────
  let session
  try {
    session = loadSession(sessionId)
  } catch (err) {
    fail(err.message)
    process.exit(1)
  }

  // ── Step 2: Validate task exists ────────────────────────────────────────────
  const task = session.dag.tasks[taskId]
  if (!task) {
    fail(`Task ${taskId} not found in session ${sessionId}`)
    process.exit(1)
  }

  // ── Step 3: Warn if already completed ───────────────────────────────────────
  if (task.status === 'completed') {
    warn(`Task ${taskId} is already completed — updating anyway.`)
  }

  // ── Step 4–6: Update task fields ────────────────────────────────────────────
  task.status = 'completed'
  task.completed_at = new Date().toISOString()
  task.result = opts.message ?? 'Manually accepted'

  // ── Step 7: Persist session ─────────────────────────────────────────────────
  try {
    saveSession(session)
  } catch (err) {
    fail(`Failed to save session: ${err.message}`)
    process.exit(1)
  }

  // ── Step 8: Emit event for log trail ────────────────────────────────────────
  emit('task:completed', {
    sessionId: session.id,
    taskId,
    taskTitle: task.title,
    duration: 0,
    resultLength: task.result.length,
  })

  // ── Step 9: Print confirmation ──────────────────────────────────────────────
  success(`Task ${taskId} marked as completed.`)

  // Show which tasks are now ready to run
  const ready = getReadyTasks(session.dag.tasks, session.dag.order)
  if (ready.length > 0) {
    info(`Downstream tasks now ready: ${ready.join(', ')}`)
    info(`Continue with: clai run ${session.id}`)
  }
}
