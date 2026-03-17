/**
 * wait task type — polls a shell command until it succeeds or times out.
 *
 * Schema fields:
 *   until                 string  shell command to poll (success = exit code 0)
 *   timeout_seconds       number  max time to wait (default 60)
 *   poll_interval_seconds number  seconds between polls (default 5)
 */

import { execSync } from 'child_process'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function executeWait(session, task, onChunk) {
  const { until, timeout_seconds = 60, poll_interval_seconds = 5 } = task

  if (!until) throw new Error('wait: missing required field "until"')

  const deadline = Date.now() + timeout_seconds * 1000
  let attempts = 0

  while (Date.now() < deadline) {
    attempts++
    try {
      execSync(until, { stdio: 'pipe', timeout: 10_000 })
      const elapsed = ((Date.now() - (deadline - timeout_seconds * 1000)) / 1000).toFixed(1)
      return `wait: condition met after ${elapsed}s (${attempts} attempt${attempts > 1 ? 's' : ''}).`
    } catch {
      const remaining = Math.ceil((deadline - Date.now()) / 1000)
      if (onChunk) onChunk(`wait: not ready yet (${remaining}s remaining)…\n`)
      await sleep(poll_interval_seconds * 1000)
    }
  }

  throw new Error(`wait: timed out after ${timeout_seconds}s — condition never met: "${until}"`)
}
