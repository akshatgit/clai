#!/usr/bin/env node
import { program } from 'commander'
import { planDAG, planSWE } from './planner.js'
import { localizeIssue } from './localize.js'
import { reinforcedSWE } from './reinforce.js'
import { executeTask } from './executor.js'
import { runTaskInDocker, listTaskContainers, containerName } from './docker.js'
import { createSession, loadSession, saveSession, listSessions, resetTask, LOGS_DIR } from './state.js'
import { emit, on } from './hooks.js'
import { topologicalSort, getReadyTasks, getBlockedTasks, getStats } from './dag.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { createServer } from 'http'
import { execHandler } from './commands/exec.js'
import { acceptHandler } from './commands/accept.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  magenta:'\x1b[35m',
  gray:   '\x1b[90m',
}

const icon = {
  pending:   `${c.gray}○${c.reset}`,
  running:   `${c.cyan}◉${c.reset}`,
  completed: `${c.green}✓${c.reset}`,
  failed:    `${c.red}✗${c.reset}`,
  skipped:   `${c.yellow}⊘${c.reset}`,
}

function header(text) {
  console.log(`\n${c.bold}${c.blue}══ ${text} ══${c.reset}`)
}

function info(text)    { console.log(`${c.cyan}ℹ${c.reset}  ${text}`) }
function success(text) { console.log(`${c.green}✓${c.reset}  ${text}`) }
function warn(text)    { console.log(`${c.yellow}⚠${c.reset}  ${text}`) }
function fail(text)    { console.log(`${c.red}✗${c.reset}  ${text}`) }

function statusBadge(status) {
  const map = {
    pending:   `${c.gray}pending${c.reset}`,
    running:   `${c.cyan}running${c.reset}`,
    completed: `${c.green}completed${c.reset}`,
    failed:    `${c.red}failed${c.reset}`,
    skipped:   `${c.yellow}skipped${c.reset}`,
  }
  return map[status] ?? status
}

function elapsed(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

// ─── Default logging hooks (console + file are already handled in hooks.js) ───

function setupLoggingHooks() {
  on('session:created', ({ sessionId, goal, taskCount }) => {
    info(`Session ${c.bold}${sessionId}${c.reset} created — ${taskCount} tasks planned`)
  })

  on('task:started', ({ taskId, taskTitle, attempt }) => {
    const retryNote = attempt > 1 ? ` ${c.yellow}(attempt ${attempt})${c.reset}` : ''
    console.log(`\n${icon.running} ${c.bold}[${taskId}] ${taskTitle}${c.reset}${retryNote}`)
  })

  on('task:completed', ({ taskId, taskTitle, duration }) => {
    success(`[${taskId}] ${taskTitle} ${c.gray}(${elapsed(duration)})${c.reset}`)
  })

  on('task:failed', ({ taskId, taskTitle, error }) => {
    fail(`[${taskId}] ${taskTitle} — ${error}`)
  })

  on('task:skipped', ({ taskId, taskTitle }) => {
    warn(`[${taskId}] ${taskTitle} — skipped (dependency failed)`)
  })

  on('session:completed', ({ sessionId, goal, duration, stats }) => {
    header('Session Complete')
    console.log(`  Goal:      ${goal}`)
    console.log(`  Duration:  ${elapsed(duration)}`)
    console.log(`  ${c.green}Completed: ${stats.completed}${c.reset}  ${c.red}Failed: ${stats.failed}${c.reset}  ${c.yellow}Skipped: ${stats.skipped}${c.reset}`)
    info(`Logs: logs/${sessionId}.jsonl`)
  })

  on('session:failed', ({ sessionId, error }) => {
    fail(`Session ${sessionId} failed: ${error}`)
  })
}

// ─── Core runner ──────────────────────────────────────────────────────────────

async function runSessionTasks(session, opts = {}) {
  const { verbose = false, targetTaskId = null, useDocker = false, repoPath = null } = opts

  if (targetTaskId) {
    // Single-task re-run
    const task = session.dag.tasks[targetTaskId]
    if (!task) throw new Error(`Task not found: ${targetTaskId}`)
    resetTask(session, targetTaskId)
    session = loadSession(session.id)
    await runSingleTask(session, targetTaskId, { verbose, useDocker, repoPath })
    return
  }

  // Full run: execute all ready tasks in topological order
  session.status = 'running'
  session.started_at ??= new Date().toISOString()
  saveSession(session)

  emit('session:started', { sessionId: session.id, goal: session.goal })

  const sessionStart = Date.now()

  while (true) {
    // Reload to get latest state
    session = loadSession(session.id)

    // Mark blocked tasks as skipped
    for (const id of getBlockedTasks(session.dag.tasks)) {
      session.dag.tasks[id].status = 'skipped'
      saveSession(session)
      emit('task:skipped', {
        sessionId: session.id,
        taskId: id,
        taskTitle: session.dag.tasks[id].title,
        reason: 'dependency failed',
      })
    }

    const ready = getReadyTasks(session.dag.tasks, session.dag.order)
    if (ready.length === 0) break

    // Run the next ready task
    await runSingleTask(session, ready[0], { verbose, useDocker, repoPath })
  }

  session = loadSession(session.id)
  const stats = getStats(session.dag.tasks)
  const allDone = stats.pending === 0 && stats.running === 0

  if (allDone) {
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

async function runSingleTask(session, taskId, { verbose = false, useDocker = false, repoPath = null } = {}) {
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

  if (useDocker) {
    const cname = containerName(session.id, taskId)
    info(`Docker container: ${c.cyan}${cname}${c.reset}`)
  }

  const taskStart = Date.now()

  try {
    const runner = useDocker
      ? (s, t, cb) => runTaskInDocker(s, t, cb, { repoPath })
      : executeTask
    const result = await runner(session, task, chunk => {
      if (verbose) process.stdout.write(chunk)
    })

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

    if (!verbose) {
      // Show a brief preview of the result
      const preview = result.trim().split('\n').slice(0, 3).join('\n')
      console.log(`${c.dim}${preview}${c.reset}`)
      if (result.trim().split('\n').length > 3) {
        console.log(`${c.gray}  ... run with --verbose to see full output${c.reset}`)
      }
    }

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
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

program
  .name('clai')
  .description('AI-powered task orchestrator — plan, execute, and track goals end-to-end')
  .version('1.0.0')

// START: plan a new session
program
  .command('start <goal>')
  .description('Create a new session: AI designs a task DAG for the goal')
  .option('--verbose', 'Show Claude\'s thinking during planning')
  .option('--run', 'Immediately run the session after planning')
  .action(async (goal, opts) => {
    setupLoggingHooks()
    header('Planning')
    info(`Goal: ${goal}`)
    console.log(`${c.dim}Asking Claude to design the task DAG…${c.reset}\n`)

    let tasks
    try {
      tasks = await planDAG(goal, opts.verbose ? (t) => {
        console.log(`${c.dim}[thinking] ${t.slice(0, 200)}…${c.reset}`)
      } : null)
    } catch (err) {
      fail(`Planning failed: ${err.message}`)
      process.exit(1)
    }

    const session = createSession(goal, tasks)

    emit('session:created', {
      sessionId: session.id,
      goal: session.goal,
      taskCount: tasks.length,
    })

    header('Task DAG')
    for (const id of session.dag.order) {
      const t = session.dag.tasks[id]
      const deps = t.dependencies.length > 0
        ? ` ${c.gray}← [${t.dependencies.join(', ')}]${c.reset}`
        : ''
      const cx = t.complexity === 'high' ? c.red : t.complexity === 'medium' ? c.yellow : c.green
      console.log(`  ${icon.pending} ${c.bold}${id}${c.reset}  ${t.title}  ${cx}[${t.complexity}]${c.reset}${deps}`)
      console.log(`       ${c.dim}${t.description.slice(0, 90)}${t.description.length > 90 ? '…' : ''}${c.reset}`)
    }
    console.log()
    info(`Session ID: ${c.bold}${session.id}${c.reset}`)
    info(`Run it:     clai run ${session.id}`)

    if (opts.run) {
      await runSessionTasks(session, { verbose: opts.verbose })
    }
  })

// RUN: execute pending tasks (or re-run a specific task)
program
  .command('run <session-id>')
  .description('Run pending tasks in a session (or re-run one task)')
  .option('--task <task-id>', 'Re-run a specific task by ID')
  .option('--verbose', 'Stream Claude\'s full output in real-time')
  .option('--docker', 'Run each task in its own Docker container (container persists after task)')
  .option('--repo <path>', 'Path to the project repo to mount at /workspace in each container (defaults to cwd)')
  .option('--patch-output <file>', 'After all tasks complete, write git diff HEAD of --repo to this file')
  .action(async (sessionId, opts) => {
    setupLoggingHooks()
    let session
    try {
      session = loadSession(sessionId)
    } catch (err) {
      fail(err.message)
      process.exit(1)
    }

    header(`Running: ${session.goal}`)

    if (opts.task) {
      info(`Re-running task: ${opts.task}`)
    } else {
      const stats = getStats(session.dag.tasks)
      if (stats.pending === 0 && stats.running === 0) {
        warn('All tasks are already completed or failed. Use --task <id> to re-run one.')
        process.exit(0)
      }
    }

    const repoPath = opts.docker ? (opts.repo ?? process.cwd()) : null
    await runSessionTasks(session, { verbose: opts.verbose, targetTaskId: opts.task, useDocker: opts.docker, repoPath })

    // Write git diff to patch output file if requested
    if (opts.patchOutput && repoPath) {
      try {
        const { extractPatch } = await import('./swe-bench/extract-patch.js')
        const patch = extractPatch(repoPath)
        writeFileSync(opts.patchOutput, patch)
        info(`Patch written to ${opts.patchOutput}`)
      } catch (err) {
        warn(`Could not write patch output: ${err.message}`)
      }
    }
  })

// STATUS: show session status
program
  .command('status <session-id>')
  .description('Show the current status of a session')
  .option('--result <task-id>', 'Print the full result of a specific task')
  .action((sessionId, opts) => {
    let session
    try {
      session = loadSession(sessionId)
    } catch (err) {
      fail(err.message)
      process.exit(1)
    }

    if (opts.result) {
      const task = session.dag.tasks[opts.result]
      if (!task) { fail(`Task not found: ${opts.result}`); process.exit(1) }
      console.log(`\n${c.bold}[${task.id}] ${task.title}${c.reset}\n`)
      console.log(task.result ?? `${c.dim}(no result yet)${c.reset}`)
      return
    }

    header(`Session: ${session.id}`)
    console.log(`  Goal:    ${session.goal}`)
    console.log(`  Status:  ${statusBadge(session.status)}`)
    console.log(`  Created: ${session.created_at}`)
    if (session.completed_at) console.log(`  Ended:   ${session.completed_at}`)
    console.log()

    for (const id of session.dag.order) {
      const t = session.dag.tasks[id]
      const deps = t.dependencies.length > 0
        ? ` ${c.gray}← [${t.dependencies.join(', ')}]${c.reset}`
        : ''
      const attempt = t.attempts > 0 ? ` ${c.dim}(×${t.attempts})${c.reset}` : ''
      const dur = t.started_at && t.completed_at
        ? ` ${c.gray}${elapsed(new Date(t.completed_at) - new Date(t.started_at))}${c.reset}`
        : ''
      console.log(`  ${icon[t.status]} ${c.bold}${id}${c.reset}  ${t.title}${deps}${attempt}${dur}`)
    }

    const stats = getStats(session.dag.tasks)
    console.log()
    console.log(`  ${c.green}✓ ${stats.completed}${c.reset}  ${c.red}✗ ${stats.failed}${c.reset}  ${c.yellow}⊘ ${stats.skipped}${c.reset}  ${c.gray}○ ${stats.pending}${c.reset}`)
    if (session.status === 'pending' || session.status === 'running') {
      console.log()
      info(`Continue: clai run ${session.id}`)
    }
    if (stats.failed > 0 || stats.skipped > 0) {
      info(`Re-run a task: clai run ${session.id} --task <task-id>`)
    }
  })

// LIST: list all sessions
program
  .command('list')
  .description('List all sessions')
  .action(() => {
    const sessions = listSessions()
    if (sessions.length === 0) {
      info('No sessions yet. Start one with: clai start "<goal>"')
      return
    }

    header('Sessions')
    for (const s of sessions) {
      console.log(`  ${statusBadge(s.status)}  ${c.bold}${s.id}${c.reset}  ${s.goal.slice(0, 60)}${s.goal.length > 60 ? '…' : ''}`)
      console.log(`  ${' '.repeat(s.status.length + 2)}  ${c.dim}${s.created_at}${c.reset}`)
    }
  })

// LOGS: show session event log
program
  .command('logs <session-id>')
  .description('Show the event log for a session')
  .option('--raw', 'Output raw JSONL')
  .action((sessionId, opts) => {
    const logPath = join(LOGS_DIR, `${sessionId}.jsonl`)
    if (!existsSync(logPath)) {
      warn('No logs found for this session.')
      return
    }

    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    if (opts.raw) {
      lines.forEach(l => console.log(l))
      return
    }

    header(`Logs: ${sessionId}`)
    for (const line of lines) {
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      const ts = entry.ts?.split('T')[1]?.slice(0, 8) ?? ''
      const ev = entry.event ?? ''

      if (ev === 'task:started') {
        console.log(`  ${c.dim}${ts}${c.reset}  ${icon.running} ${c.cyan}${ev}${c.reset}  ${entry.taskId} — ${entry.taskTitle}  ${c.dim}attempt #${entry.attempt}${c.reset}`)
      } else if (ev === 'task:completed') {
        console.log(`  ${c.dim}${ts}${c.reset}  ${icon.completed} ${c.green}${ev}${c.reset}  ${entry.taskId} — ${entry.taskTitle}  ${c.dim}${elapsed(entry.duration)}${c.reset}`)
      } else if (ev === 'task:failed') {
        console.log(`  ${c.dim}${ts}${c.reset}  ${icon.failed} ${c.red}${ev}${c.reset}  ${entry.taskId} — ${entry.error}`)
      } else if (ev === 'task:skipped') {
        console.log(`  ${c.dim}${ts}${c.reset}  ${icon.skipped} ${c.yellow}${ev}${c.reset}  ${entry.taskId} — ${entry.taskTitle}`)
      } else if (ev.startsWith('session:')) {
        console.log(`  ${c.dim}${ts}${c.reset}  ${c.magenta}${ev}${c.reset}  ${entry.goal ?? ''}`)
      } else {
        console.log(`  ${c.dim}${ts}${c.reset}  ${ev}`)
      }
    }
  })

// ─── Viz helpers ──────────────────────────────────────────────────────────────

/** Compute the "level" of each task: 0 for roots, max(dep levels)+1 for others. */
function computeLevels(tasks, order) {
  const levels = {}
  for (const id of order) {
    const deps = tasks[id].dependencies
    levels[id] = deps.length === 0
      ? 0
      : Math.max(...deps.map(d => levels[d] ?? 0)) + 1
  }
  return levels
}

function terminalViz(session) {
  const { tasks, order } = session.dag
  const levels = computeLevels(tasks, order)
  const maxLevel = Math.max(...Object.values(levels))

  header(`DAG Visualization: ${session.goal}`)

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const ids = order.filter(id => levels[id] === lvl)
    const levelLabel = lvl === 0 ? 'roots (no dependencies)' : `level ${lvl}`
    console.log(`\n${c.bold}${c.blue}Level ${lvl}${c.reset}  ${c.dim}${levelLabel}${c.reset}`)
    console.log(`  ${'─'.repeat(52)}`)

    for (const id of ids) {
      const t = tasks[id]
      const deps = t.dependencies.length > 0
        ? `  ${c.gray}← [${t.dependencies.join(', ')}]${c.reset}`
        : ''
      const cx = t.complexity === 'high' ? c.red : t.complexity === 'medium' ? c.yellow : c.green
      console.log(`  ${icon[t.status]} ${c.bold}${id}${c.reset}  ${t.title}  ${cx}[${t.complexity}]${c.reset}${deps}`)
      console.log(`     ${c.dim}${t.description.slice(0, 80)}${t.description.length > 80 ? '…' : ''}${c.reset}`)
    }
  }

  console.log()
  info(`For interactive graph: clai viz ${session.id} --html`)
}

function generateHTML(session) {
  const { tasks, order } = session.dag

  // Build Mermaid flowchart definition
  const statusColor = {
    pending:   '#6b7280',
    running:   '#3b82f6',
    completed: '#22c55e',
    failed:    '#ef4444',
    skipped:   '#eab308',
  }
  const statusIcon = { pending: '○', running: '◉', completed: '✓', failed: '✗', skipped: '⊘' }

  let mermaid = 'graph TD\n'

  // Node definitions with labels
  for (const id of order) {
    const t = tasks[id]
    const ic = statusIcon[t.status] ?? '○'
    const title = t.title.replace(/"/g, "'").replace(/[<>]/g, '')
    const label = `${ic} ${id}\\n${title}\\n[${t.complexity}]`
    mermaid += `  ${id}["${label}"]\n`
  }

  // Edges
  for (const id of order) {
    for (const dep of tasks[id].dependencies) {
      mermaid += `  ${dep} --> ${id}\n`
    }
  }

  // Style classes
  for (const id of order) {
    const col = statusColor[tasks[id].status] ?? '#6b7280'
    mermaid += `  style ${id} fill:${col},color:#fff,stroke:#fff\n`
  }

  const taskData = {}
  for (const id of order) {
    const t = tasks[id]
    taskData[id] = {
      id: t.id, title: t.title, status: t.status, complexity: t.complexity,
      docker_image: t.docker_image ?? '',
      dependencies: t.dependencies,
      description: t.description ?? '',
      completion_criteria: t.completion_criteria ?? [],
      tests: t.tests ?? [],
      result: t.result ?? '',
      error: t.error ?? '',
    }
  }

  const taskRows = order.map(id => {
    const t = tasks[id]
    const statusBg = {
      pending: '#1e293b', running: '#1e3a5f', completed: '#14532d',
      failed: '#450a0a', skipped: '#422006',
    }[t.status] ?? '#1e293b'
    return `
      <tr data-task-id="${t.id}" style="background:${statusBg};cursor:pointer" title="Click for details">
        <td><code>${t.id}</code></td>
        <td>${escapeHTML(t.title)}</td>
        <td>${t.status}</td>
        <td>${t.complexity}</td>
        <td>${t.dependencies.join(', ') || '—'}</td>
        <td>${t.result ? '✓ has result' : '<em style="color:#9ca3af">—</em>'}</td>
      </tr>`
  }).join('')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>clai — ${escapeHTML(session.goal)}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
    h1 { font-size: 1.4rem; color: #f8fafc; margin-bottom: 4px; }
    .meta { color: #64748b; font-size: 0.85rem; margin-bottom: 24px; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; margin-left: 8px; }
    .pending   { background:#374151; color:#d1d5db }
    .running   { background:#1d4ed8; color:#fff }
    .completed { background:#15803d; color:#fff }
    .failed    { background:#b91c1c; color:#fff }
    .skipped   { background:#a16207; color:#fff }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .mermaid svg { max-width: 100%; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { background: #0f172a; padding: 8px 12px; text-align: left; color: #94a3b8; font-weight: 600; border-bottom: 1px solid #334155; }
    td { padding: 8px 12px; border-bottom: 1px solid #1e293b; vertical-align: top; }
    tr[data-task-id]:hover td { background: rgba(96,165,250,0.08); }
    details summary { cursor: pointer; color: #60a5fa; font-size: 0.8rem; }
    pre { color: #334155; }
    code { font-size: 0.8rem; color: #7dd3fc; }
    /* Modal */
    #modal-backdrop {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.6); z-index: 100;
      align-items: flex-start; justify-content: center;
      padding: 40px 16px; overflow-y: auto;
    }
    #modal-backdrop.open { display: flex; }
    #modal {
      background: #1e293b; border-radius: 14px; width: 100%; max-width: 760px;
      padding: 28px; position: relative; box-shadow: 0 24px 64px rgba(0,0,0,0.5);
    }
    #modal-close {
      position: absolute; top: 16px; right: 20px; background: none; border: none;
      color: #94a3b8; font-size: 1.4rem; cursor: pointer; line-height: 1;
    }
    #modal-close:hover { color: #e2e8f0; }
    .modal-title { font-size: 1.1rem; font-weight: 700; color: #f8fafc; margin-bottom: 6px; }
    .modal-id { font-size: .8rem; color: #64748b; margin-bottom: 18px; }
    .modal-section { margin-bottom: 18px; }
    .modal-label {
      font-size: .7rem; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; color: #64748b; margin-bottom: 6px;
    }
    .modal-text { font-size: .875rem; color: #cbd5e1; line-height: 1.6; }
    .modal-text code,.modal-list li code { background:#1e293b; color:#7dd3fc; padding:1px 5px; border-radius:4px; font-size:.8rem; font-family:monospace; }
    .modal-list { list-style: none; padding: 0; margin: 0; }
    .modal-list li {
      font-size: .85rem; color: #cbd5e1; padding: 5px 0;
      border-bottom: 1px solid #334155; display: flex; gap: 8px;
    }
    .modal-list li:last-child { border-bottom: none; }
    .modal-list li::before { content: "•"; color: #475569; flex-shrink: 0; }
    .modal-result {
      font-size: .875rem; background: #0f172a; padding: 16px; border-radius: 8px;
      overflow: auto; max-height: 360px; border: 1px solid #334155; color: #cbd5e1; line-height: 1.65;
    }
    .modal-result h1,.modal-result h2,.modal-result h3,.modal-result h4 { color:#f1f5f9; margin: .9em 0 .4em; font-size: 1em; }
    .modal-result h1 { font-size: 1.15em; } .modal-result h2 { font-size: 1.05em; }
    .modal-result p { margin: 0 0 .6em; }
    .modal-result ul,.modal-result ol { padding-left: 1.4em; margin: 0 0 .6em; }
    .modal-result li { margin-bottom: .2em; }
    .modal-result code { background:#1e293b; color:#7dd3fc; padding:1px 5px; border-radius:4px; font-size:.8rem; font-family:monospace; }
    .modal-result pre { background:#1e293b; border-radius:6px; padding:10px 12px; overflow:auto; margin:.5em 0; }
    .modal-result pre code { background:none; padding:0; color:#7dd3fc; font-size:.8rem; }
    .modal-result blockquote { border-left:3px solid #334155; margin:0 0 .6em; padding:.3em .8em; color:#94a3b8; }
    .modal-result hr { border:none; border-top:1px solid #334155; margin:.8em 0; }
    .modal-result a { color:#60a5fa; }
    .modal-result strong { color:#f1f5f9; }
    .pill {
      display: inline-block; padding: 2px 10px; border-radius: 999px;
      font-size: .75rem; font-weight: 600;
    }
    .pill-low    { background:#14532d; color:#86efac }
    .pill-medium { background:#713f12; color:#fde68a }
    .pill-high   { background:#7f1d1d; color:#fca5a5 }
    .meta-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
    .meta-chip { background:#0f172a; border-radius:8px; padding:8px 14px; font-size:.8rem; color:#94a3b8; }
    .meta-chip strong { display: block; font-size: .7rem; color: #475569; margin-bottom: 2px; text-transform: uppercase; letter-spacing: .06em; }
  </style>
</head>
<body>
  <h1>${escapeHTML(session.goal)}</h1>
  <p class="meta">
    Session: <code style="color:#7dd3fc">${session.id}</code>
    &nbsp;·&nbsp; Created: ${session.created_at}
    &nbsp;·&nbsp; Status: <span class="badge ${session.status}">${session.status}</span>
  </p>

  <div class="card">
    <h2 style="font-size:1rem;margin-bottom:16px;color:#94a3b8">TASK GRAPH</h2>
    <div class="mermaid">
${mermaid}
    </div>
  </div>

  <div class="card">
    <h2 style="font-size:1rem;margin-bottom:16px;color:#94a3b8">TASK DETAILS <span style="font-size:.75rem;font-weight:400;color:#475569">— click a row for full details</span></h2>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Title</th><th>Status</th><th>Complexity</th><th>Dependencies</th><th>Result</th>
        </tr>
      </thead>
      <tbody>${taskRows}</tbody>
    </table>
  </div>

  <!-- Task detail modal -->
  <div id="modal-backdrop">
    <div id="modal">
      <button id="modal-close" onclick="closeModal()">✕</button>
      <div class="modal-title" id="m-title"></div>
      <div class="modal-id" id="m-id"></div>
      <div class="meta-row" id="m-meta"></div>
      <div class="modal-section">
        <div class="modal-label">Description</div>
        <div class="modal-text" id="m-desc"></div>
      </div>
      <div class="modal-section" id="m-criteria-wrap">
        <div class="modal-label">Completion Criteria</div>
        <ul class="modal-list" id="m-criteria"></ul>
      </div>
      <div class="modal-section" id="m-tests-wrap">
        <div class="modal-label">Tests</div>
        <ul class="modal-list" id="m-tests"></ul>
      </div>
      <div class="modal-section" id="m-error-wrap">
        <div class="modal-label" style="color:#f87171">Error</div>
        <pre class="modal-result" id="m-error" style="color:#fca5a5;border-color:#7f1d1d"></pre>
      </div>
      <div class="modal-section" id="m-result-wrap">
        <div class="modal-label">Result</div>
        <div class="modal-result" id="m-result"></div>
      </div>
    </div>
  </div>

  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'dark', flowchart: { curve: 'basis', padding: 20 } })

    const TASKS = ${JSON.stringify(taskData)}

    function openModal(id) {
      const t = TASKS[id]
      if (!t) return
      document.getElementById('m-title').textContent = t.title
      document.getElementById('m-id').textContent = t.id

      const complexityClass = { low: 'pill-low', medium: 'pill-medium', high: 'pill-high' }[t.complexity] ?? 'pill-low'
      const statusColors = { pending:'#374151;color:#d1d5db', running:'#1d4ed8;color:#fff', completed:'#15803d;color:#fff', failed:'#b91c1c;color:#fff', skipped:'#a16207;color:#fff' }
      const sc = statusColors[t.status] ?? '#374151;color:#d1d5db'
      document.getElementById('m-meta').innerHTML = [
        \`<div class="meta-chip"><strong>Status</strong><span style="background:\${sc};padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600">\${t.status}</span></div>\`,
        \`<div class="meta-chip"><strong>Complexity</strong><span class="pill \${complexityClass}">\${t.complexity}</span></div>\`,
        t.docker_image ? \`<div class="meta-chip"><strong>Docker Image</strong>\${escHtml(t.docker_image)}</div>\` : '',
        t.dependencies.length ? \`<div class="meta-chip"><strong>Depends on</strong>\${t.dependencies.join(', ')}</div>\` : '',
      ].join('')

      document.getElementById('m-desc').innerHTML = marked.parse(t.description || '—')

      const criteria = t.completion_criteria
      const cWrap = document.getElementById('m-criteria-wrap')
      if (criteria.length) {
        document.getElementById('m-criteria').innerHTML = criteria.map(c => \`<li>\${marked.parseInline(c)}</li>\`).join('')
        cWrap.style.display = ''
      } else { cWrap.style.display = 'none' }

      const tests = t.tests
      const tWrap = document.getElementById('m-tests-wrap')
      if (tests.length) {
        document.getElementById('m-tests').innerHTML = tests.map(x => \`<li>\${marked.parseInline(x)}</li>\`).join('')
        tWrap.style.display = ''
      } else { tWrap.style.display = 'none' }

      const ew = document.getElementById('m-error-wrap')
      if (t.error) {
        document.getElementById('m-error').textContent = t.error
        ew.style.display = ''
      } else { ew.style.display = 'none' }

      const rWrap = document.getElementById('m-result-wrap')
      if (t.result) {
        document.getElementById('m-result').innerHTML = marked.parse(t.result)
        rWrap.style.display = ''
      } else { rWrap.style.display = 'none' }

      document.getElementById('modal-backdrop').classList.add('open')
    }

    function closeModal() {
      document.getElementById('modal-backdrop').classList.remove('open')
    }

    function escHtml(s) {
      return (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }

    document.getElementById('modal-backdrop').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-backdrop')) closeModal()
    })
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal() })

    document.querySelectorAll('tr[data-task-id]').forEach(row => {
      row.addEventListener('click', () => openModal(row.dataset.taskId))
    })
  </script>
</body>
</html>`

  const outDir = join(__dirname, '..', 'sessions')
  const outPath = join(outDir, `${session.id}.html`)
  writeFileSync(outPath, html)
  success(`HTML written: ${outPath}`)

  // Try to open in browser
  try {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open'
    execSync(`${opener} "${outPath}"`, { stdio: 'ignore' })
    info('Opening in browser…')
  } catch {
    info(`Open manually: file://${outPath}`)
  }
}

function escapeHTML(str) {
  return (str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function buildIndexPage(sessions) {
  const rows = sessions.map(s => {
    const badgeCss = {
      pending:'background:#374151;color:#d1d5db', running:'background:#1d4ed8;color:#fff',
      completed:'background:#15803d;color:#fff', failed:'background:#b91c1c;color:#fff',
    }[s.status] ?? 'background:#374151;color:#d1d5db'
    return `
      <tr onclick="location='/viz/${s.id}'" style="cursor:pointer">
        <td><code style="color:#7dd3fc">${s.id}</code></td>
        <td>${escapeHTML(s.goal)}</td>
        <td><span style="padding:2px 10px;border-radius:999px;font-size:.75rem;font-weight:600;${badgeCss}">${s.status}</span></td>
        <td style="color:#64748b;font-size:.8rem">${s.created_at}</td>
      </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><title>clai</title>
  <script>setTimeout(() => location.reload(), 5000)</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px}
    h1{font-size:1.5rem;margin-bottom:4px}
    .sub{color:#64748b;font-size:.875rem;margin-bottom:28px}
    table{width:100%;border-collapse:collapse;font-size:.875rem}
    th{background:#1e293b;padding:10px 14px;text-align:left;color:#94a3b8;border-bottom:1px solid #334155}
    td{padding:10px 14px;border-bottom:1px solid #1e293b;vertical-align:middle}
    tr:hover td{background:#1e293b}
    .empty{text-align:center;padding:48px;color:#475569}
  </style>
</head><body>
  <h1>clai</h1>
  <p class="sub">Click a session to view its interactive DAG visualization.</p>
  <table>
    <thead><tr><th>Session ID</th><th>Goal</th><th>Status</th><th>Created</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="empty">No sessions yet. Run <code>clai start "…"</code> to create one.</td></tr>`}</tbody>
  </table>
</body></html>`
}

function startServer(port) {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0]

    // Index: list all sessions
    if (url === '/' || url === '') {
      const sessions = listSessions()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(buildIndexPage(sessions))
      return
    }

    // Viz: /viz/<session-id>
    const vizMatch = url.match(/^\/viz\/([a-z0-9_]+)$/)
    if (vizMatch) {
      try {
        const session = loadSession(vizMatch[1])
        const html = buildVizHTML(session)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Session not found')
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  })

  server.listen(port, '0.0.0.0', () => {
    header('clai Server')
    success(`Listening on http://0.0.0.0:${port}`)
    console.log()
    info(`From your Mac, forward the port:`)
    console.log(`  ${c.bold}${c.cyan}ssh -L ${port}:localhost:${port} <user>@<server>${c.reset}`)
    console.log()
    info(`Then open: ${c.bold}http://localhost:${port}${c.reset}`)
    console.log()
    console.log(`${c.dim}Press Ctrl+C to stop${c.reset}`)
  })
}

/** Same as generateHTML but returns the string instead of writing a file. */
function buildVizHTML(session) {
  const { tasks, order } = session.dag
  const statusColor = {
    pending:'#6b7280', running:'#3b82f6', completed:'#22c55e',
    failed:'#ef4444', skipped:'#eab308',
  }
  const statusIcon = { pending:'○', running:'◉', completed:'✓', failed:'✗', skipped:'⊘' }

  let mermaid = 'graph TD\n'
  for (const id of order) {
    const t = tasks[id]
    const label = `${statusIcon[t.status] ?? '○'} ${id}\\n${t.title.replace(/"/g,"'").replace(/[<>]/g,'')}\\n[${t.complexity}]`
    mermaid += `  ${id}["${label}"]\n`
  }
  for (const id of order) {
    for (const dep of tasks[id].dependencies) {
      mermaid += `  ${dep} --> ${id}\n`
    }
  }
  for (const id of order) {
    mermaid += `  style ${id} fill:${statusColor[tasks[id].status] ?? '#6b7280'},color:#fff,stroke:#fff\n`
  }

  const taskData = {}
  for (const id of order) {
    const t = tasks[id]
    taskData[id] = {
      id: t.id, title: t.title, status: t.status, complexity: t.complexity,
      docker_image: t.docker_image ?? '',
      dependencies: t.dependencies,
      description: t.description ?? '',
      completion_criteria: t.completion_criteria ?? [],
      tests: t.tests ?? [],
      result: t.result ?? '',
      error: t.error ?? '',
    }
  }

  const taskRows = order.map(id => {
    const t = tasks[id]
    const bg = { pending:'#1e293b', running:'#1e3a5f', completed:'#14532d', failed:'#450a0a', skipped:'#422006' }[t.status] ?? '#1e293b'
    return `<tr data-task-id="${t.id}" style="background:${bg};cursor:pointer" title="Click for details"><td><code>${t.id}</code></td><td>${escapeHTML(t.title)}</td><td>${t.status}</td><td>${t.complexity}</td><td>${t.dependencies.join(', ') || '—'}</td><td>${t.result ? '✓ has result' : '<em style="color:#9ca3af">—</em>'}</td></tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <title>${escapeHTML(session.goal)}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    if (${JSON.stringify(session.status)} === 'running') {
      history.scrollRestoration = 'manual'
      const saved = sessionStorage.getItem('scrollY')
      if (saved) {
        // Wait for mermaid to finish rendering before restoring scroll
        mermaid.initialize({startOnLoad:false,theme:'dark',flowchart:{curve:'basis',padding:20}})
        document.addEventListener('DOMContentLoaded', async () => {
          await mermaid.run()
          window.scrollTo(0, parseInt(saved, 10))
        })
      } else {
        mermaid.initialize({startOnLoad:true,theme:'dark',flowchart:{curve:'basis',padding:20}})
      }
      setInterval(() => {
        if (!document.getElementById('modal-backdrop')?.classList.contains('open')) {
          sessionStorage.setItem('scrollY', window.scrollY)
          location.reload()
        }
      }, 3000)
    }
  </script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
    h1{font-size:1.4rem;color:#f8fafc;margin-bottom:4px}
    .meta{color:#64748b;font-size:.85rem;margin-bottom:24px}
    .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.75rem;font-weight:600;margin-left:8px}
    .pending{background:#374151;color:#d1d5db}.running{background:#1d4ed8;color:#fff}
    .completed{background:#15803d;color:#fff}.failed{background:#b91c1c;color:#fff}.skipped{background:#a16207;color:#fff}
    .card{background:#1e293b;border-radius:12px;padding:20px;margin-bottom:20px}
    .mermaid svg{max-width:100%}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    th{background:#0f172a;padding:8px 12px;text-align:left;color:#94a3b8;border-bottom:1px solid #334155}
    td{padding:8px 12px;border-bottom:1px solid #1e293b;vertical-align:top}
    tr[data-task-id]:hover td{background:rgba(96,165,250,0.08)}
    code{font-size:.8rem;color:#7dd3fc}
    a{color:#60a5fa;text-decoration:none}
    a:hover{text-decoration:underline}
    .refresh{float:right;font-size:.8rem;color:#64748b;margin-top:4px}
    #modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto}
    #modal-backdrop.open{display:flex}
    #modal{background:#1e293b;border-radius:14px;width:100%;max-width:760px;padding:28px;position:relative;box-shadow:0 24px 64px rgba(0,0,0,0.5)}
    #modal-close{position:absolute;top:16px;right:20px;background:none;border:none;color:#94a3b8;font-size:1.4rem;cursor:pointer;line-height:1}
    #modal-close:hover{color:#e2e8f0}
    .modal-title{font-size:1.1rem;font-weight:700;color:#f8fafc;margin-bottom:6px}
    .modal-id{font-size:.8rem;color:#64748b;margin-bottom:18px}
    .modal-section{margin-bottom:18px}
    .modal-label{font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:6px}
    .modal-text{font-size:.875rem;color:#cbd5e1;line-height:1.6}
    .modal-list{list-style:none;padding:0;margin:0}
    .modal-list li{font-size:.85rem;color:#cbd5e1;padding:5px 0;border-bottom:1px solid #334155;display:flex;gap:8px}
    .modal-list li:last-child{border-bottom:none}
    .modal-list li::before{content:"•";color:#475569;flex-shrink:0}
    .modal-result{font-size:.875rem;background:#0f172a;padding:16px;border-radius:8px;overflow:auto;max-height:360px;border:1px solid #334155;color:#cbd5e1;line-height:1.65}
    .modal-result h1,.modal-result h2,.modal-result h3,.modal-result h4{color:#f1f5f9;margin:.9em 0 .4em;font-size:1em}.modal-result h1{font-size:1.15em}.modal-result h2{font-size:1.05em}
    .modal-result p{margin:0 0 .6em}.modal-result ul,.modal-result ol{padding-left:1.4em;margin:0 0 .6em}.modal-result li{margin-bottom:.2em}
    .modal-result code{background:#1e293b;color:#7dd3fc;padding:1px 5px;border-radius:4px;font-size:.8rem;font-family:monospace}
    .modal-result pre{background:#1e293b;border-radius:6px;padding:10px 12px;overflow:auto;margin:.5em 0}.modal-result pre code{background:none;padding:0;color:#7dd3fc;font-size:.8rem}
    .modal-result blockquote{border-left:3px solid #334155;margin:0 0 .6em;padding:.3em .8em;color:#94a3b8}.modal-result hr{border:none;border-top:1px solid #334155;margin:.8em 0}
    .modal-result a{color:#60a5fa}.modal-result strong{color:#f1f5f9}
    .pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.75rem;font-weight:600}
    .pill-low{background:#14532d;color:#86efac}.pill-medium{background:#713f12;color:#fde68a}.pill-high{background:#7f1d1d;color:#fca5a5}
    .meta-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:18px}
    .meta-chip{background:#0f172a;border-radius:8px;padding:8px 14px;font-size:.8rem;color:#94a3b8}
    .meta-chip strong{display:block;font-size:.7rem;color:#475569;margin-bottom:2px;text-transform:uppercase;letter-spacing:.06em}
  </style>
</head><body>
  <p style="margin-bottom:12px"><a href="/">← All sessions</a>
    <span class="refresh">${session.status === 'running' ? '⟳ Live — refreshes every 3 s' : 'Session complete'}</span></p>
  <h1>${escapeHTML(session.goal)}</h1>
  <p class="meta">
    <code style="color:#7dd3fc">${session.id}</code>
    &nbsp;·&nbsp;${session.created_at}
    &nbsp;·&nbsp;<span class="badge ${session.status}">${session.status}</span>
  </p>
  <div class="card">
    <h2 style="font-size:1rem;margin-bottom:16px;color:#94a3b8">TASK GRAPH</h2>
    <div class="mermaid">\n${mermaid}</div>
  </div>
  <div class="card">
    <h2 style="font-size:1rem;margin-bottom:16px;color:#94a3b8">TASK DETAILS <span style="font-size:.75rem;font-weight:400;color:#475569">— click a row for full details</span></h2>
    <table>
      <thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Complexity</th><th>Dependencies</th><th>Result</th></tr></thead>
      <tbody>${taskRows}</tbody>
    </table>
  </div>

  <div id="modal-backdrop">
    <div id="modal">
      <button id="modal-close" onclick="closeModal()">✕</button>
      <div class="modal-title" id="m-title"></div>
      <div class="modal-id" id="m-id"></div>
      <div class="meta-row" id="m-meta"></div>
      <div class="modal-section">
        <div class="modal-label">Description</div>
        <div class="modal-text" id="m-desc"></div>
      </div>
      <div class="modal-section" id="m-criteria-wrap">
        <div class="modal-label">Completion Criteria</div>
        <ul class="modal-list" id="m-criteria"></ul>
      </div>
      <div class="modal-section" id="m-tests-wrap">
        <div class="modal-label">Tests</div>
        <ul class="modal-list" id="m-tests"></ul>
      </div>
      <div class="modal-section" id="m-error-wrap">
        <div class="modal-label" style="color:#f87171">Error</div>
        <pre class="modal-result" id="m-error" style="color:#fca5a5;border-color:#7f1d1d"></pre>
      </div>
      <div class="modal-section" id="m-result-wrap">
        <div class="modal-label">Result</div>
        <div class="modal-result" id="m-result"></div>
      </div>
    </div>
  </div>

  <script>
    const TASKS = ${JSON.stringify(taskData)}
    function escHtml(s){return(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
    function openModal(id){
      const t=TASKS[id]; if(!t) return
      document.getElementById('m-title').textContent=t.title
      document.getElementById('m-id').textContent=t.id
      const sc={pending:'#374151;color:#d1d5db',running:'#1d4ed8;color:#fff',completed:'#15803d;color:#fff',failed:'#b91c1c;color:#fff',skipped:'#a16207;color:#fff'}[t.status]??'#374151;color:#d1d5db'
      const cc={low:'pill-low',medium:'pill-medium',high:'pill-high'}[t.complexity]??'pill-low'
      document.getElementById('m-meta').innerHTML=[
        \`<div class="meta-chip"><strong>Status</strong><span style="background:\${sc};padding:2px 8px;border-radius:999px;font-size:.75rem;font-weight:600">\${t.status}</span></div>\`,
        \`<div class="meta-chip"><strong>Complexity</strong><span class="pill \${cc}">\${t.complexity}</span></div>\`,
        t.docker_image?\`<div class="meta-chip"><strong>Docker Image</strong>\${escHtml(t.docker_image)}</div>\`:'',
        t.dependencies.length?\`<div class="meta-chip"><strong>Depends on</strong>\${t.dependencies.join(', ')}</div>\`:'',
      ].join('')
      document.getElementById('m-desc').innerHTML=marked.parse(t.description||'—')
      const cw=document.getElementById('m-criteria-wrap')
      if(t.completion_criteria.length){document.getElementById('m-criteria').innerHTML=t.completion_criteria.map(c=>\`<li>\${marked.parseInline(c)}</li>\`).join('');cw.style.display=''}else{cw.style.display='none'}
      const tw=document.getElementById('m-tests-wrap')
      if(t.tests.length){document.getElementById('m-tests').innerHTML=t.tests.map(x=>\`<li>\${marked.parseInline(x)}</li>\`).join('');tw.style.display=''}else{tw.style.display='none'}
      const ew=document.getElementById('m-error-wrap')
      if(t.error){document.getElementById('m-error').textContent=t.error;ew.style.display=''}else{ew.style.display='none'}
      const rw=document.getElementById('m-result-wrap')
      if(t.result){document.getElementById('m-result').innerHTML=marked.parse(t.result);rw.style.display=''}else{rw.style.display='none'}
      document.getElementById('modal-backdrop').classList.add('open')
    }
    function closeModal(){document.getElementById('modal-backdrop').classList.remove('open')}
    document.getElementById('modal-backdrop').addEventListener('click',e=>{if(e.target===document.getElementById('modal-backdrop'))closeModal()})
    document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()})
    document.querySelectorAll('tr[data-task-id]').forEach(r=>r.addEventListener('click',()=>openModal(r.dataset.taskId)))
  </script>
</body></html>`
}

// SERVE: start HTTP server
program
  .command('serve')
  .description('Start an HTTP server to view sessions in the browser')
  .option('-p, --port <port>', 'Port to listen on', '4242')
  .action((opts) => {
    startServer(parseInt(opts.port, 10))
  })

// VIZ: visualize the DAG
program
  .command('viz <session-id>')
  .description('Visualize the task DAG (terminal layers or interactive HTML)')
  .option('--html', 'Generate an HTML Mermaid flowchart and open in browser')
  .action((sessionId, opts) => {
    let session
    try {
      session = loadSession(sessionId)
    } catch (err) {
      fail(err.message)
      process.exit(1)
    }

    if (opts.html) {
      generateHTML(session)
    } else {
      terminalViz(session)
    }
  })

// CONTAINERS: list Docker containers for task runs
program
  .command('containers')
  .description('List Docker containers created for task runs')
  .action(async () => {
    const out = await listTaskContainers()
    if (!out) {
      info('No clai task containers found.')
      return
    }
    header('Task Containers')
    console.log(`  ${c.dim}${'CONTAINER'.padEnd(48)} ${'STATUS'.padEnd(20)} CREATED${c.reset}`)
    for (const line of out.split('\n')) {
      const [name, status, ...rest] = line.split('\t')
      const created = rest.join('\t')
      const alive = status?.toLowerCase().startsWith('up')
      const dot = alive ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`
      console.log(`  ${dot} ${c.bold}${(name ?? '').padEnd(46)}${c.reset} ${(status ?? '').padEnd(20)} ${c.dim}${created}${c.reset}`)
    }
    console.log()
    info(`Exec into a container:  ${c.cyan}docker exec -it <name> sh${c.reset}`)
  })

// EXEC: open an interactive shell inside a task's Docker container
program
  .command('exec <session-id> <task-id>')
  .description("Open an interactive shell inside a task's Docker container")
  .action((sessionId, taskId) => {
    execHandler(sessionId, taskId, { fail })
  })

// ACCEPT: manually mark a task as completed
program
  .command('accept <session-id> <task-id>')
  .description('Manually mark a task as completed (skip AI execution)')
  .option('--message <text>', 'Optional message to record as the task result')
  .action((sessionId, taskId, opts) => {
    acceptHandler(sessionId, taskId, opts, { fail, success, warn, info })
  })

// ─── SWE-bench ────────────────────────────────────────────────────────────────

const sweBench = program
  .command('swe-bench')
  .description('Run clai against SWE-bench evaluation instances')

// swe-bench run
sweBench
  .command('run')
  .description('Run clai on SWE-bench instances and collect patches into predictions.json')
  .option('--dataset <name>', 'Dataset to use: lite (300) or verified (500)', 'lite')
  .option('--limit <n>', 'Max number of instances to run', (v) => parseInt(v, 10), 300)
  .option('--instance <id>', 'Run a single instance by ID')
  .option('--output <path>', 'Output predictions JSON file', 'predictions.json')
  .option('--concurrency <n>', 'Number of instances to run in parallel', (v) => parseInt(v, 10), 1)
  .option('--timeout <ms>', 'Timeout per instance in ms', (v) => parseInt(v, 10), 600_000)
  .option('--rounds <n>', 'Max reinforcement rounds per instance', (v) => parseInt(v, 10), 3)
  .option('--verbose', 'Stream Claude output for each instance')
  .option('--viz', 'Print a terminal DAG visualization after each round is planned')
  .action(async (opts) => {
    const { runSweBench } = await import('./swe-bench/runner.js')
    const { terminalViz } = await import('./viz.js')
    try {
      await runSweBench({
        dataset:     opts.dataset,
        limit:       opts.limit,
        instanceId:  opts.instance ?? null,
        output:      opts.output,
        concurrency: opts.concurrency,
        timeout:     opts.timeout,
        maxRounds:   opts.rounds,
        verbose:     opts.verbose ?? false,
        onPlanned:   opts.viz
          ? (round, total, session) => terminalViz(session, { label: `Round ${round}/${total}`, hint: true })
          : null,
      })
    } catch (err) {
      fail(`swe-bench run failed: ${err.message}`)
      process.exit(1)
    }
  })

// swe-bench status
sweBench
  .command('status <predictions-file>')
  .description('Show a summary of a predictions.json file')
  .action((predictionsFile) => {
    if (!existsSync(predictionsFile)) {
      fail(`File not found: ${predictionsFile}`)
      process.exit(1)
    }

    let predictions
    try {
      predictions = JSON.parse(readFileSync(predictionsFile, 'utf8'))
    } catch (err) {
      fail(`Could not parse ${predictionsFile}: ${err.message}`)
      process.exit(1)
    }

    const total     = predictions.length
    const completed = predictions.filter(p => p.model_patch && p.model_patch.trim().length > 0).length
    const failed    = total - completed

    header('SWE-bench Predictions')
    console.log(`  File:      ${predictionsFile}`)
    console.log(`  Total:     ${c.bold}${total}${c.reset}`)
    console.log(`  ${c.green}Completed: ${completed}${c.reset}  (non-empty patch)`)
    console.log(`  ${c.red}Failed:    ${failed}${c.reset}  (empty patch)`)

    if (total > 0) {
      const pct = ((completed / total) * 100).toFixed(1)
      console.log(`  Coverage:  ${pct}%`)
    }
    console.log()
  })

// SWE: localize → plan → execute with reinforcement rounds
program
  .command('swe <issue>')
  .description('Localize a bug, plan a surgical fix, and execute with reinforcement rounds')
  .option('--repo <path>',    'Path to the repository (defaults to cwd)')
  .option('--docker',         'Run fix tasks in Docker containers')
  .option('--rounds <n>',     'Max outer reinforcement rounds (default 3)', '3')
  .option('--plan-only',      'Stop after first localize+plan (do not execute)')
  .option('--verbose',        'Stream Claude output live')
  .action(async (issue, opts) => {
    setupLoggingHooks()
    const repoPath = opts.repo ?? process.cwd()
    const maxRounds = parseInt(opts.rounds, 10)

    if (opts.planOnly) {
      // Single localize + plan, then exit
      header('Localizing Issue')
      info(`Repo: ${repoPath}`)

      let report
      try {
        report = await localizeIssue(issue, repoPath, chunk => {
          if (opts.verbose) process.stdout.write(chunk)
          else process.stdout.write('.')
        })
      } catch (err) {
        fail(`Localization failed: ${err.message}`)
        process.exit(1)
      }
      if (!opts.verbose) console.log()
      printLocalizationReport(report)

      header('Planning Fix')
      let tasks
      try { tasks = await planSWE(issue, report, repoPath) }
      catch (err) { fail(`Planning failed: ${err.message}`); process.exit(1) }

      const session = createSession(`[SWE] ${issue.slice(0, 80)}`, tasks)
      session.localization = report
      saveSession(session)
      emit('session:created', { sessionId: session.id, goal: session.goal, taskCount: tasks.length })
      printPlan(session)
      info(`Run it: clai run ${session.id}${opts.docker ? ' --docker' : ''} --repo ${repoPath}`)
      return
    }

    // Full reinforced run
    header('SWE — Reinforced Fix')
    info(`Issue: ${issue.slice(0, 100)}`)
    info(`Repo:  ${repoPath}`)
    info(`Rounds: up to ${maxRounds}`)
    console.log()

    let result
    try {
      result = await reinforcedSWE(issue, repoPath, {
        maxRounds,
        verbose: opts.verbose,
        useDocker: opts.docker,
        onChunk: chunk => {
          if (opts.verbose) process.stdout.write(chunk)
          else process.stdout.write('.')
        },
        onRound: (round, total) => {
          if (!opts.verbose) console.log()
          header(`Round ${round} / ${total}`)
        },
        onLocalized: (round, report) => {
          printLocalizationReport(report)
        },
        onPlanned: (round, session) => {
          printPlan(session)
        },
      })
    } catch (err) {
      fail(`SWE failed: ${err.message}`)
      process.exit(1)
    }

    if (!opts.verbose) console.log()
    header('Result')
    if (result.success) {
      success(`Fixed in ${result.rounds} round${result.rounds > 1 ? 's' : ''}`)
    } else {
      fail(`Could not fix after ${result.rounds} rounds`)
    }
    console.log()
    console.log(`${c.dim}${result.finalOutput?.slice(0, 600) ?? ''}${c.reset}`)
    info(`Sessions: ${result.sessions.join(', ')}`)
  })

function printLocalizationReport(report) {
  console.log(`\n  ${c.bold}Root cause:${c.reset}  ${report.summary}`)
  console.log(`  ${c.bold}Hypothesis:${c.reset}  ${report.fix_hypothesis}`)
  console.log(`\n  ${c.bold}Relevant files:${c.reset}`)
  for (const f of report.relevant_files ?? []) {
    const lines = f.key_lines?.length ? ` ${c.dim}(lines ${f.key_lines.join(', ')})${c.reset}` : ''
    console.log(`    ${c.cyan}${f.path}${c.reset}${lines}  ${c.dim}${f.reason}${c.reset}`)
  }
  if (report.failing_tests?.length) {
    console.log(`\n  ${c.bold}Failing tests:${c.reset}`)
    for (const t of report.failing_tests) console.log(`    ${c.red}✗ ${t}${c.reset}`)
  }
  console.log()
}

function printPlan(session) {
  console.log()
  for (const id of session.dag.order) {
    const t = session.dag.tasks[id]
    const deps = t.dependencies.length ? ` ${c.gray}← [${t.dependencies.join(', ')}]${c.reset}` : ''
    const cx = t.complexity === 'high' ? c.red : t.complexity === 'medium' ? c.yellow : c.green
    const typeBadge = t.type !== 'execute' ? ` ${c.magenta}[${t.type}]${c.reset}` : ''
    console.log(`  ${icon.pending} ${c.bold}${id}${c.reset}  ${t.title}  ${cx}[${t.complexity}]${c.reset}${typeBadge}${deps}`)
  }
  info(`Session: ${c.bold}${session.id}${c.reset}`)
  console.log()
}

program.parse()
