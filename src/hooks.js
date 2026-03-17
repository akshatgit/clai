/**
 * Event / hook system.
 *
 * Core events emitted throughout the orchestrator lifecycle:
 *
 *   session:created   { sessionId, goal, taskCount }
 *   session:started   { sessionId, goal }
 *   session:completed { sessionId, goal, duration, stats }
 *   session:failed    { sessionId, error }
 *
 *   task:started      { sessionId, taskId, taskTitle, attempt }
 *   task:completed    { sessionId, taskId, taskTitle, duration }
 *   task:failed       { sessionId, taskId, taskTitle, error }
 *   task:skipped      { sessionId, taskId, taskTitle, reason }
 *
 * All events are persisted to  logs/<sessionId>.jsonl  as newline-delimited JSON.
 * Additional handlers can be registered via  on(event, fn).
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { LOGS_DIR } from './state.js'

const handlers = {}

/** Clear all registered handlers — used by tests to isolate state between cases. */
export function _reset() {
  for (const key of Object.keys(handlers)) delete handlers[key]
}

/** Register a handler for an event (or '*' for all events). */
export function on(event, handler) {
  if (!handlers[event]) handlers[event] = []
  handlers[event].push(handler)
}

/** Emit an event, writing it to the session log and calling any registered handlers. */
export function emit(event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...data,
  }

  // Persist to per-session JSONL log
  const { sessionId } = data
  if (sessionId) {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true })
    appendFileSync(join(LOGS_DIR, `${sessionId}.jsonl`), JSON.stringify(entry) + '\n')
  }

  // Call handlers for this specific event
  for (const fn of handlers[event] ?? []) {
    try { fn(entry) } catch { /* ignore handler errors */ }
  }

  // Call wildcard handlers
  for (const fn of handlers['*'] ?? []) {
    try { fn(entry) } catch { /* ignore */ }
  }
}
