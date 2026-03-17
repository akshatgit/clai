import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import { topologicalSort } from './dag.js'

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

export function generateId(prefix = 'sess') {
  return `${prefix}_${randomBytes(4).toString('hex')}`
}

export function createSession(goal, dagTasks) {
  ensureDir(SESSIONS_DIR)

  const tasks = {}
  for (const t of dagTasks) {
    tasks[t.id] = {
      id: t.id,
      title: t.title,
      description: t.description,
      dependencies: t.dependencies,
      complexity: t.complexity || 'medium',
      docker_image: t.docker_image || 'node:22-alpine',
      completion_criteria: t.completion_criteria || [],
      tests: t.tests || [],
      input_paths: t.input_paths || ['.'],
      output_paths: t.output_paths || [],
      status: 'pending',
      result: null,
      started_at: null,
      completed_at: null,
      attempts: 0,
    }
  }

  const order = topologicalSort(tasks)

  const session = {
    id: generateId('sess'),
    goal,
    status: 'pending',
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    dag: { tasks, order },
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
