import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { containerName, runTaskInDocker, _setSpawn, _resetSpawn } from '../src/docker.js'
import { _configure } from '../src/state.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a fake ChildProcess that fires its events lazily.
 *
 * Events are scheduled via Promise.resolve().then() the first time a `close`
 * listener is attached — i.e. inside the _spawn() call, after the caller has
 * set up all its handlers. This prevents the race where pre-created procs fire
 * their events before any listener is attached.
 */
function fakeProc(exitCode = 0, { stderrChunks = [] } = {}) {
  const stderrHandlers = []
  const closeHandlers = []
  let scheduled = false

  function scheduleOnce() {
    if (scheduled) return
    scheduled = true
    Promise.resolve().then(() => {
      for (const chunk of stderrChunks) {
        for (const fn of stderrHandlers) fn(Buffer.from(chunk))
      }
      for (const fn of closeHandlers) fn(exitCode)
    })
  }

  return {
    stdout: { on() {} },
    stderr: {
      on(ev, fn) {
        if (ev === 'data') stderrHandlers.push(fn)
      },
    },
    on(ev, fn) {
      if (ev === 'close') { closeHandlers.push(fn); scheduleOnce() }
      // 'error' ignored — tests don't exercise that path
    },
  }
}

/** Returns a spawn mock that hands out procs in order; falls back to fakeProc(0). */
function spawnSequence(...procs) {
  let i = 0
  const calls = []
  const fn = (cmd, args) => {
    calls.push({ cmd, args })
    return procs[i++] ?? fakeProc(0)
  }
  fn.calls = calls
  return fn
}

function session(id = 'sess_abc123') {
  return { id, goal: 'Build a calendar app', dag: { tasks: {}, order: [] } }
}

function task(id = 'task_1', overrides = {}) {
  return { id, title: 'Scaffold', description: 'do it', complexity: 'low', docker_image: 'node:22-alpine', ...overrides }
}

let tmpBase, sessionsDir

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'orch-docker-'))
  sessionsDir = join(tmpBase, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  _configure({ sessionsDir, logsDir: join(tmpBase, 'logs') })
})

afterEach(() => {
  _resetSpawn()
  rmSync(tmpBase, { recursive: true, force: true })
})

// ─── containerName ────────────────────────────────────────────────────────────

describe('containerName', () => {
  it('produces a name containing both sessionId and taskId', () => {
    const name = containerName('sess_abc', 'task_1')
    assert.ok(name.includes('sess_abc'))
    assert.ok(name.includes('task_1'))
  })

  it('varies with sessionId', () => {
    assert.notEqual(containerName('sess_aaa', 'task_1'), containerName('sess_bbb', 'task_1'))
  })

  it('varies with taskId', () => {
    assert.notEqual(containerName('sess_aaa', 'task_1'), containerName('sess_aaa', 'task_2'))
  })

  it('starts with the expected prefix', () => {
    // containerName returns `clai-${sessionId}-${taskId}` (project prefix)
    const name = containerName('sess_xyz', 'task_3')
    assert.ok(name.startsWith('clai-') || name.startsWith('orchestrator-'),
      `unexpected prefix: ${name}`)
  })

  it('is consistent (same inputs → same output)', () => {
    assert.equal(containerName('sess_abc', 'task_1'), containerName('sess_abc', 'task_1'))
  })
})

// ─── runTaskInDocker — spawn call sequence ────────────────────────────────────

describe('runTaskInDocker — container lifecycle', () => {
  it('first spawn call is docker rm -f (cleanup previous container)', async () => {
    const s = session()
    const t = task()
    writeFileSync(join(sessionsDir, `.result-${s.id}-${t.id}`), 'output')

    const mock = spawnSequence(fakeProc(0), fakeProc(0), fakeProc(0))
    _setSpawn(mock)

    await runTaskInDocker(s, t, () => {})
    assert.equal(mock.calls[0].args[0], 'rm')
    assert.ok(mock.calls[0].args.includes('-f'))
    assert.ok(mock.calls[0].args.includes(containerName(s.id, t.id)))
  })

  it('second spawn call is docker run -d with the container name', async () => {
    const s = session()
    const t = task()
    writeFileSync(join(sessionsDir, `.result-${s.id}-${t.id}`), 'output')

    const mock = spawnSequence(fakeProc(0), fakeProc(0), fakeProc(0))
    _setSpawn(mock)

    await runTaskInDocker(s, t, () => {})
    const args = mock.calls[1].args
    assert.equal(args[0], 'run')
    assert.ok(args.includes('-d'))
    assert.ok(args.includes('--name'))
    assert.ok(args.includes(containerName(s.id, t.id)))
  })

  it('uses task.docker_image for the container image', async () => {
    const s = session()
    const t = task('task_1', { docker_image: 'python:3.12-slim' })
    writeFileSync(join(sessionsDir, `.result-${s.id}-${t.id}`), 'output')

    const mock = spawnSequence(fakeProc(0), fakeProc(0), fakeProc(0))
    _setSpawn(mock)

    await runTaskInDocker(s, t, () => {})
    assert.ok(mock.calls[1].args.includes('python:3.12-slim'))
  })

  it('mounts repoPath at /workspace when provided', async () => {
    const s = session()
    const t = task()
    writeFileSync(join(sessionsDir, `.result-${s.id}-${t.id}`), 'output')

    const mock = spawnSequence(fakeProc(0), fakeProc(0), fakeProc(0))
    _setSpawn(mock)

    await runTaskInDocker(s, t, () => {}, { repoPath: '/my/project' })
    const runArgs = mock.calls[1].args.join(' ')
    assert.ok(runArgs.includes('/my/project:/workspace'))
  })

  it('third spawn call is docker exec with correct session and task ids', async () => {
    const s = session('sess_xyz')
    const t = task('task_2')
    writeFileSync(join(sessionsDir, `.result-${s.id}-${t.id}`), 'the result')

    const mock = spawnSequence(fakeProc(0), fakeProc(0), fakeProc(0, { stderrChunks: ['the result'] }))
    _setSpawn(mock)

    await runTaskInDocker(s, t, () => {})
    const execArgs = mock.calls[2].args
    assert.equal(execArgs[0], 'exec')
    assert.ok(execArgs.includes('sess_xyz'))
    assert.ok(execArgs.includes('task_2'))
  })
})

// ─── runTaskInDocker — result file and streaming ──────────────────────────────

describe('runTaskInDocker — result handling', () => {
  it('returns the content of the result file', async () => {
    const s = session()
    const t = task()
    writeFileSync(join(sessionsDir, `.result-${s.id}-${t.id}`), '## Summary\nScaffolded the project.')

    _setSpawn(spawnSequence(fakeProc(0), fakeProc(0), fakeProc(0)))
    const result = await runTaskInDocker(s, t, () => {})
    assert.ok(result.includes('Scaffolded the project.'))
  })

  it('delivers stderr chunks to the onChunk callback', async () => {
    const s = session()
    const t = task()
    writeFileSync(join(sessionsDir, `.result-${s.id}-${t.id}`), 'result')

    const chunks = []
    _setSpawn(spawnSequence(
      fakeProc(0),
      fakeProc(0),
      fakeProc(0, { stderrChunks: ['chunk-a', 'chunk-b'] }),
    ))
    await runTaskInDocker(s, t, c => chunks.push(c))
    assert.ok(chunks.some(c => c.includes('chunk-a')))
    assert.ok(chunks.some(c => c.includes('chunk-b')))
  })

  it('rejects when the worker container exits non-zero', async () => {
    const s = session()
    const t = task()
    _setSpawn(spawnSequence(fakeProc(0), fakeProc(0), fakeProc(1)))

    await assert.rejects(
      runTaskInDocker(s, t, () => {}),
      /exited with code 1/,
    )
  })

  it('rejects when result file is missing after success exit', async () => {
    const s = session()
    const t = task()
    // intentionally no result file
    _setSpawn(spawnSequence(fakeProc(0), fakeProc(0), fakeProc(0)))

    await assert.rejects(
      runTaskInDocker(s, t, () => {}),
      /Failed to read task result/,
    )
  })
})
