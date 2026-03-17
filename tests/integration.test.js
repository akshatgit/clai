/**
 * integration.test.js — End-to-end: "Build a calendar CLI app"
 *
 * Tests the full pipeline: planDAG → createSession → runSessionTasks → inspect results.
 * Both planner and executor are mocked so no real API calls are made.
 *
 * Scenarios:
 *   1. Happy path — all 5 tasks complete, session is "completed"
 *   2. One task bombs — failure cascades, session is "failed"
 *   3. Retry — bombed task is re-run, session eventually completes
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { planDAG, _setClient } from '../src/planner.js'
import { _setExecutor, _resetExecutor, runSessionTasks } from '../src/runner.js'
import { createSession, loadSession, saveSession, _configure } from '../src/state.js'
import { _reset as resetHooks } from '../src/hooks.js'

// ─── Calendar app fixtures ────────────────────────────────────────────────────

/** The plan a mock Claude would design for a calendar CLI app. */
const CALENDAR_PLAN = {
  tasks: [
    {
      id: 'task_1',
      title: 'Project scaffold',
      description: 'Initialise a Node.js project. Create package.json with name "calendar-app" and commander as a dependency. Create src/ and tests/ directories.',
      dependencies: [],
      complexity: 'low',
      docker_image: 'node:22-alpine',
      completion_criteria: ['package.json exists with correct name', 'src/ directory exists'],
      tests: ['node --version', 'ls package.json'],
    },
    {
      id: 'task_2',
      title: 'Event data model',
      description: 'Create src/event.js exporting an Event class with fields: id (uuid), title (string), date (ISO string), description (string). Also create src/store.js with in-memory CRUD functions.',
      dependencies: ['task_1'],
      complexity: 'medium',
      docker_image: 'node:22-alpine',
      completion_criteria: ['src/event.js exports Event class', 'src/store.js exports add, list, remove, update'],
      tests: ['node -e "const {Event} = require(\'./src/event.js\'); console.log(new Event({title:\'t\',date:\'2026-01-01\'}))"'],
    },
    {
      id: 'task_3',
      title: 'Add / list events',
      description: 'Implement "add" and "list" subcommands in src/commands/add.js and src/commands/list.js. "add" takes --title and --date flags. "list" prints all events as a table.',
      dependencies: ['task_2'],
      complexity: 'medium',
      docker_image: 'node:22-alpine',
      completion_criteria: ['src/commands/add.js exists', 'src/commands/list.js exists'],
      tests: ['node cli.js list'],
    },
    {
      id: 'task_4',
      title: 'Delete / edit events',
      description: 'Implement "delete <id>" and "edit <id>" subcommands in src/commands/delete.js and src/commands/edit.js.',
      dependencies: ['task_2'],
      complexity: 'medium',
      docker_image: 'node:22-alpine',
      completion_criteria: ['src/commands/delete.js exists', 'src/commands/edit.js exists'],
      tests: ['node cli.js delete --help'],
    },
    {
      id: 'task_5',
      title: 'CLI entry point',
      description: 'Create cli.js at root. Wire all subcommands (add, list, delete, edit) using commander.js. Add --help text. Make the file executable.',
      dependencies: ['task_3', 'task_4'],
      complexity: 'high',
      docker_image: 'node:22-alpine',
      completion_criteria: ['cli.js exists and is executable', 'node cli.js --help lists all 4 subcommands'],
      tests: ['node cli.js --help'],
    },
  ],
}

/** Realistic-looking task outputs (what Claude would have produced). */
const TASK_RESULTS = {
  task_1: `# Project Scaffold

Created \`package.json\`:
\`\`\`json
{
  "name": "calendar-app",
  "version": "1.0.0",
  "type": "module",
  "bin": { "cal": "./cli.js" },
  "dependencies": { "commander": "^12.0.0" }
}
\`\`\`

Created directory structure: \`src/\`, \`src/commands/\`, \`tests/\`.

## Summary
Initialised Node.js project with package.json (name: calendar-app, commander dependency). Created src/ and tests/ directories.`,

  task_2: `# Event Data Model

Created \`src/event.js\`:
\`\`\`js
import { randomUUID } from 'crypto'
export class Event {
  constructor({ title, date, description = '' }) {
    this.id = randomUUID()
    this.title = title
    this.date = date
    this.description = description
  }
}
\`\`\`

Created \`src/store.js\` with in-memory CRUD (add, list, remove, update).

## Summary
Defined Event class (id, title, date, description) and a store module with full CRUD. Data lives in memory per process run.`,

  task_3: `# Add / List Events

Created \`src/commands/add.js\` — reads --title and --date flags, calls store.add(), prints confirmation.
Created \`src/commands/list.js\` — calls store.list(), renders events as an ASCII table.

## Summary
Implemented "add" command (--title, --date flags) and "list" command (tabular output). Both are exported as commander sub-command builders.`,

  task_4: `# Delete / Edit Events

Created \`src/commands/delete.js\` — takes event id argument, calls store.remove(), confirms deletion.
Created \`src/commands/edit.js\` — takes id + optional --title/--date/--description, calls store.update().

## Summary
Implemented "delete <id>" and "edit <id>" subcommands. Graceful error if event not found.`,

  task_5: `# CLI Entry Point

Created \`cli.js\`:
\`\`\`js
#!/usr/bin/env node
import { Command } from 'commander'
import { addCmd } from './src/commands/add.js'
import { listCmd } from './src/commands/list.js'
import { deleteCmd } from './src/commands/delete.js'
import { editCmd } from './src/commands/edit.js'

const program = new Command()
program.name('cal').description('Calendar CLI app').version('1.0.0')
program.addCommand(addCmd)
program.addCommand(listCmd)
program.addCommand(deleteCmd)
program.addCommand(editCmd)
program.parse()
\`\`\`

Made cli.js executable (chmod +x).

## Summary
Wired up all four subcommands (add, list, delete, edit) via commander.js. \`node cli.js --help\` lists all commands with descriptions.`,
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let sessionsDir, logsDir

beforeEach(() => {
  resetHooks()
  const base = mkdtempSync(join(tmpdir(), 'orch-int-'))
  sessionsDir = join(base, 'sessions')
  logsDir = join(base, 'logs')
  _configure({ sessionsDir, logsDir })

  // Mock planner: always returns the calendar plan
  _setClient({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify(CALENDAR_PLAN) }],
      }),
    },
  })
})

afterEach(() => {
  _resetExecutor()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Executor that returns realistic outputs for all 5 calendar tasks. */
function happyExecutor() {
  return async (session, task) => {
    if (!(task.id in TASK_RESULTS)) throw new Error(`No fixture for ${task.id}`)
    return TASK_RESULTS[task.id]
  }
}

/** Executor where task_3 always fails. */
function task3FailsExecutor() {
  return async (session, task) => {
    if (task.id === 'task_3') throw new Error('Claude timed out waiting for completion')
    if (!(task.id in TASK_RESULTS)) throw new Error(`No fixture for ${task.id}`)
    return TASK_RESULTS[task.id]
  }
}

// ─── Scenario 1: Full happy path ──────────────────────────────────────────────

describe('Scenario 1 — "Build a calendar CLI app" — all tasks succeed', () => {
  it('planDAG returns 5 tasks for the calendar goal', async () => {
    const tasks = await planDAG('Build a calendar CLI app')
    assert.equal(tasks.length, 5)
  })

  it('planDAG tasks cover expected features', async () => {
    const tasks = await planDAG('Build a calendar CLI app')
    const titles = tasks.map(t => t.title)
    assert.ok(titles.some(t => t.toLowerCase().includes('scaffold') || t.toLowerCase().includes('project')))
    assert.ok(titles.some(t => t.toLowerCase().includes('cli')))
  })

  it('each planned task has docker_image, completion_criteria, and tests', async () => {
    const tasks = await planDAG('Build a calendar CLI app')
    for (const t of tasks) {
      assert.ok(t.docker_image, `${t.id} missing docker_image`)
      assert.ok(Array.isArray(t.completion_criteria), `${t.id} missing completion_criteria`)
      assert.ok(Array.isArray(t.tests), `${t.id} missing tests`)
    }
  })

  it('session is "completed" after running all tasks', async () => {
    _setExecutor(happyExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    assert.equal(loadSession(session.id).status, 'completed')
  })

  it('all 5 tasks reach "completed" status', async () => {
    _setExecutor(happyExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    for (const task of Object.values(final.dag.tasks)) {
      assert.equal(task.status, 'completed', `${task.id} should be completed`)
    }
  })

  it('task results contain real generated content', async () => {
    _setExecutor(happyExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    assert.ok(final.dag.tasks.task_1.result.includes('package.json'))
    assert.ok(final.dag.tasks.task_2.result.includes('Event'))
    assert.ok(final.dag.tasks.task_5.result.includes('commander'))
  })

  it('task_5 (CLI) is the last to complete (all deps must come first)', async () => {
    const order = []
    _setExecutor(async (session, task) => {
      order.push(task.id)
      return TASK_RESULTS[task.id]
    })
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    assert.equal(order[order.length - 1], 'task_5')
  })

  it('task_1 is always first (no dependencies)', async () => {
    const order = []
    _setExecutor(async (session, task) => {
      order.push(task.id)
      return TASK_RESULTS[task.id]
    })
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    assert.equal(order[0], 'task_1')
  })
})

// ─── Scenario 2: One task bombs ───────────────────────────────────────────────

describe('Scenario 2 — "add/list" task fails, CLI task is skipped', () => {
  it('session ends as "failed"', async () => {
    _setExecutor(task3FailsExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    assert.equal(loadSession(session.id).status, 'failed')
  })

  it('task_3 (add/list) has status "failed"', async () => {
    _setExecutor(task3FailsExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    assert.equal(loadSession(session.id).dag.tasks.task_3.status, 'failed')
  })

  it('task_5 (CLI) is "skipped" because its dep task_3 failed', async () => {
    _setExecutor(task3FailsExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    assert.equal(loadSession(session.id).dag.tasks.task_5.status, 'skipped')
  })

  it('task_4 (delete/edit) still completes — independent from task_3', async () => {
    _setExecutor(task3FailsExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    assert.equal(loadSession(session.id).dag.tasks.task_4.status, 'completed')
  })

  it('early tasks (scaffold, data model) complete before the failure', async () => {
    _setExecutor(task3FailsExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    const final = loadSession(session.id)
    assert.equal(final.dag.tasks.task_1.status, 'completed')
    assert.equal(final.dag.tasks.task_2.status, 'completed')
  })
})

// ─── Scenario 3: Retry the bombed task ───────────────────────────────────────

describe('Scenario 3 — retry task_3 after failure, then complete the session', () => {
  it('re-running task_3 with a fixed executor gives it "completed" status', async () => {
    // First run: task_3 fails
    _setExecutor(task3FailsExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)
    assert.equal(loadSession(session.id).dag.tasks.task_3.status, 'failed')

    // Retry: use the happy executor
    _setExecutor(happyExecutor())
    await runSessionTasks(loadSession(session.id), { targetTaskId: 'task_3' })
    assert.equal(loadSession(session.id).dag.tasks.task_3.status, 'completed')
  })

  it('after retry, resuming the session brings it to "completed"', async () => {
    // First run: task_3 fails, task_5 skipped
    _setExecutor(task3FailsExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)

    // Retry task_3
    _setExecutor(happyExecutor())
    await runSessionTasks(loadSession(session.id), { targetTaskId: 'task_3' })

    // Un-skip task_5 and resume
    const s = loadSession(session.id)
    s.dag.tasks.task_5.status = 'pending'
    saveSession(s)

    await runSessionTasks(loadSession(session.id))

    const final = loadSession(session.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.dag.tasks.task_5.status, 'completed')
    assert.ok(final.dag.tasks.task_5.result.includes('commander'))
  })

  it('task_3 shows attempts=2 after one failure and one success', async () => {
    _setExecutor(task3FailsExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)

    _setExecutor(happyExecutor())
    await runSessionTasks(loadSession(session.id), { targetTaskId: 'task_3' })

    assert.equal(loadSession(session.id).dag.tasks.task_3.attempts, 2)
  })

  it('retry result overwrites the previous failed result', async () => {
    _setExecutor(task3FailsExecutor())
    const tasks = await planDAG('Build a calendar CLI app')
    const session = createSession('Build a calendar CLI app', tasks)
    await runSessionTasks(session)

    _setExecutor(happyExecutor())
    await runSessionTasks(loadSession(session.id), { targetTaskId: 'task_3' })

    const result = loadSession(session.id).dag.tasks.task_3.result
    assert.ok(result)
    assert.ok(result.includes('Summary'), 'result should contain Summary section')
  })
})
