#!/usr/bin/env node
/**
 * In-container task worker.
 * Usage: node src/worker.js <sessionId> <taskId>
 *
 * - Streams chunk output to stderr (so the host can display it live)
 * - Writes the final result to sessions/.result-<sessionId>-<taskId>
 * - Then sleeps forever so the container stays interactive
 */

import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { executeTask } from './executor.js'
import { loadSession } from './state.js'

const [,, sessionId, taskId] = process.argv
if (!sessionId || !taskId) {
  process.stderr.write('Usage: worker.js <sessionId> <taskId>\n')
  process.exit(1)
}

const session = loadSession(sessionId)
const task = session.dag.tasks[taskId]
if (!task) {
  process.stderr.write(`Task not found: ${taskId}\n`)
  process.exit(1)
}

// Stream chunks to stderr — host reads this via docker exec output
const result = await executeTask(session, task, chunk => {
  process.stderr.write(chunk)
})

// Write result to the shared sessions dir (mounted from host)
const resultFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'sessions',
  `.result-${sessionId}-${taskId}`,
)
writeFileSync(resultFile, result)

// Container stays alive via `tail -f /dev/null` (the main process), so the
// worker can exit cleanly here.
process.stderr.write('\n\n[worker] Task complete. Container is still running — use `docker exec -it <name> sh` to explore.\n')
