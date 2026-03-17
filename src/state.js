import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import { topologicalSort, validateTaskReferences } from './dag.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export let SESSIONS_DIR = join(__dirname, '..', 'sessions')
export let LOGS_DIR = join(__dirname, '..', 'logs')

/** Override storage paths — used by tests to point at temp directories. */
export function _configure({ sessionsDir, logsDir } = {}) {
  if (sessionsDir) SESSIONS_DIR = sessionsDir
  if (logsDir) LOGS_DIR = logsDir
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** Normalise a raw task spec into the full stored shape. */
function normalizeTask(t) {
  return {
    // Core fields
    id: t.id,
    title: t.title,
    description: t.description,
    dependencies: t.dependencies ?? [],
    complexity: t.complexity || 'medium',
    docker_image: t.docker_image || 'node:22-alpine',
    completion_criteria: t.completion_criteria || [],
    tests: t.tests || [],
    input_paths: t.input_paths || ['.'],
    output_paths: t.output_paths || [],
    // Task type
    type: t.type || 'execute',
    // branch
    condition: t.condition ?? null,
    on_true: t.on_true ?? [],
    on_false: t.on_false ?? [],
    // for_each
    items: t.items ?? [],
    template: t.template ?? null,
    collect_into: t.collect_into ?? null,
    // while
    body: t.body ?? null,
    max_iterations: t.max_iterations ?? 5,
    iteration_count: t.iteration_count ?? 0,
    // barrier
    wait_for: t.wait_for ?? [],
    // wait
    until: t.until ?? null,
    timeout_seconds: t.timeout_seconds ?? 60,
    poll_interval_seconds: t.poll_interval_seconds ?? 5,
    // Runtime state
    status: t.status || 'pending',
    result: t.result ?? null,
    started_at: t.started_at ?? null,
    completed_at: t.completed_at ?? null,
    attempts: t.attempts ?? 0,
  }
}

export function generateId(prefix = 'sess') {
  return `${prefix}_${randomBytes(4).toString('hex')}`
}

export function createSession(goal, dagTasks) {
  ensureDir(SESSIONS_DIR)

  const tasks = {}
  for (const t of dagTasks) {
    tasks[t.id] = normalizeTask(t)
  }

  validateTaskReferences(tasks)
  const order = topologicalSort(tasks)

  const session = {
    id: generateId('sess'),
    goal,
    status: 'pending',
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    dag: { tasks, order, dynamic_tasks: [] },
  }

  saveSession(session)
  return session
}

export function saveSession(session) {
  ensureDir(SESSIONS_DIR)
  const path = join(SESSIONS_DIR, `${session.id}.json`)
  writeFileSync(path, JSON.stringify(session, null, 2))
}

export function loadSession(sessionId) {
  const path = join(SESSIONS_DIR, `${sessionId}.json`)
  if (!existsSync(path)) throw new Error(`Session not found: ${sessionId}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function listSessions() {
  ensureDir(SESSIONS_DIR)
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'))
        return { id: s.id, goal: s.goal, status: s.status, created_at: s.created_at }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
}

/**
 * Insert dynamically-generated tasks (from for_each / while) into a session.
 * Recomputes session.dag.order after insertion and saves the session.
 *
 * @param {object}   session
 * @param {object[]} newTasks  - raw task objects (will be normalised)
 * @returns {object}           - the updated session
 */
export function insertDynamicTasks(session, newTasks) {
  for (const t of newTasks) {
    if (session.dag.tasks[t.id]) continue  // already inserted (idempotent)
    session.dag.tasks[t.id] = normalizeTask(t)
    session.dag.dynamic_tasks = session.dag.dynamic_tasks ?? []
    session.dag.dynamic_tasks.push(t.id)
  }
  session.dag.order = topologicalSort(session.dag.tasks)
  saveSession(session)
  return session
}

export function resetTask(session, taskId) {
  const task = session.dag.tasks[taskId]
  if (!task) throw new Error(`Task not found: ${taskId}`)
  task.status = 'pending'
  task.result = null
  task.started_at = null
  task.completed_at = null
  session.status = 'running'
  saveSession(session)
}
