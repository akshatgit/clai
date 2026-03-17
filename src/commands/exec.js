/**
 * Command handler for: clai exec <session-id> <task-id>
 *
 * Shortcut for: docker exec -it clai-<sessionId>-<taskId> sh
 *
 * Validates that the session and task exist, verifies the container is
 * currently running, then hands control to an interactive shell inside it.
 */
import { spawnSync } from 'child_process'
import { loadSession } from '../state.js'
import { containerName } from '../docker.js'

/**
 * Uses `docker inspect` to check whether a named container is running.
 *
 * @param {string} name - The Docker container name
 * @returns {boolean}   - true if the container exists and State.Running is true
 */
function isContainerRunning(name) {
  try {
    const result = spawnSync(
      'docker',
      ['inspect', '--format', '{{.State.Running}}', name],
      { encoding: 'utf8' }
    )
    // Non-zero exit means the container doesn't exist
    if (result.status !== 0) return false
    return result.stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Handler for `clai exec <session-id> <task-id>`.
 *
 * Steps:
 *  1. Validate that the session exists (via loadSession)
 *  2. Validate that the task ID exists in the session's DAG
 *  3. Build the container name: clai-<sessionId>-<taskId>
 *  4. Confirm the container is running (docker inspect)
 *  5. Spawn `docker exec -it <name> sh` with stdio: 'inherit' for
 *     a fully interactive terminal experience
 *
 * @param {string}   sessionId - The session identifier
 * @param {string}   taskId    - The task identifier within the session
 * @param {object}   helpers   - Logging helpers injected from the CLI host
 * @param {function} helpers.fail - Prints a red error line
 */
export function execHandler(sessionId, taskId, { fail }) {
  // ── Step 1: Validate session ────────────────────────────────────────────────
  let session
  try {
    session = loadSession(sessionId)
  } catch (err) {
    fail(err.message)
    process.exit(1)
  }

  // ── Step 2: Validate task ───────────────────────────────────────────────────
  if (!session.dag.tasks[taskId]) {
    fail(`Task not found: ${taskId}`)
    process.exit(1)
  }

  // ── Step 3: Build container name ────────────────────────────────────────────
  const name = containerName(sessionId, taskId)

  // ── Step 4: Check container is running ─────────────────────────────────────
  if (!isContainerRunning(name)) {
    fail(
      `Container ${name} is not running. ` +
      `Start the session first with: clai run ${sessionId} --docker`
    )
    process.exit(1)
  }

  // ── Step 5: Open interactive shell ─────────────────────────────────────────
  spawnSync('docker', ['exec', '-it', name, 'sh'], { stdio: 'inherit' })
}
