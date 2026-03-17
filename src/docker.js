import { spawn as _defaultSpawn, spawnSync } from 'child_process'
import { execSync } from 'child_process'
import { readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { SESSIONS_DIR } from './state.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

let _spawn = _defaultSpawn
/** Override the spawn implementation — used by tests. */
export function _setSpawn(fn) { _spawn = fn }
export function _resetSpawn() { _spawn = _defaultSpawn }

/**
 * Session-scoped container name. All tasks in a session share one container so
 * that package installs (pip, npm) from task_env persist for later tasks.
 *
 * The old per-task name (clai-<sid>-<tid>) caused: packages installed in
 * task_env's container were lost when task_fix started a fresh container.
 */
export function containerName(sessionId, _taskId) {
  return `clai-${sessionId}`
}

/**
 * Ensure the session container is running. Creates it if needed.
 *
 * The container mounts /workspace read-write so all tasks can freely
 * write files (patches, installs, compiled artifacts). This replaces the
 * old RO-base + selective-RW-overlay model which prevented writes to
 * files not listed in output_paths.
 *
 * Called by runTaskInDocker before every docker exec.
 */
export async function ensureSessionContainer(session, { repoPath, dockerImage = 'node:22-alpine' } = {}) {
  const name = containerName(session.id)

  // Check if already running — if so, reuse it (preserves installed packages)
  try {
    const state = execSync(`docker inspect --format={{.State.Running}} ${name}`, {
      stdio: 'pipe',
    }).toString().trim()
    if (state === 'true') return name
    // Exists but stopped — clean it up and recreate
    await silentRun('docker', ['rm', '-f', name])
  } catch {
    // Container doesn't exist yet — fall through to create it
  }

  const sessionsDir = SESSIONS_DIR
  const srcDir = join(projectRoot, 'src')
  const nodeModulesDir = join(projectRoot, 'node_modules')
  const packageJson = join(projectRoot, 'package.json')

  const workspaceMounts = repoPath
    ? ['-v', `${repoPath}:/workspace`, '-w', '/workspace']
    : ['-w', '/app']

  await run('docker', [
    'run', '-d',
    '--name', name,
    '--memory=4g',
    '--cpus=2',
    '--pids-limit=512',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? ''}`,
    '-v', `${sessionsDir}:/app/sessions`,
    '-v', `${srcDir}:/app/src:ro`,
    '-v', `${nodeModulesDir}:/app/node_modules:ro`,
    '-v', `${packageJson}:/app/package.json:ro`,
    ...workspaceMounts,
    dockerImage,
    'tail', '-f', '/dev/null',
  ])

  return name
}

/**
 * Run a task inside the session's shared Docker container.
 *
 * All tasks in a session share one container (session-scoped, not task-scoped).
 * This means:
 *  - pip/npm installs from task_env persist for task_fix and the while-loop body
 *  - /workspace is mounted RW — any file write is immediately visible to the host
 *    and to subsequent tasks (no output_paths whitelist required)
 *  - The container stays alive after the session for post-hoc inspection
 *
 * @param {object} session
 * @param {object} task
 * @param {function} onChunk  - called with each streamed output chunk
 * @param {object} opts
 * @param {string}  opts.repoPath  - host path to the project repo to mount at /workspace
 * @returns {string}          - the full task result text
 */
export async function runTaskInDocker(session, task, onChunk, { repoPath } = {}) {
  const dockerImage = task.docker_image || 'node:22-alpine'

  // Start or reuse the session container (provides the shell execution environment)
  const name = await ensureSessionContainer(session, { repoPath, dockerImage })

  // Run the executor on the HOST (avoids requiring node inside Python/Go/etc. containers).
  // Shell commands are proxied into the container via docker exec; file operations use
  // the bind-mounted repoPath directly on the host.
  const { executeTask } = await import('./executor.js')

  function dockerRunCommand(command, cwd = '/workspace') {
    const result = spawnSync('docker', ['exec', '-w', cwd, name, 'sh', '-c', command], {
      stdio: 'pipe',
      timeout: 120_000,
    })
    const stdout = result.stdout?.toString() ?? ''
    const stderr = result.stderr?.toString() ?? ''
    const combined = (stdout + stderr).trim()
    // Return combined output even on non-zero exit so Claude can see error messages
    return combined || (result.status !== 0 ? `ERROR: exit code ${result.status}` : '(no output)')
  }

  return executeTask(session, task, onChunk, {
    workspaceDir: repoPath ?? null,
    dockerRunCommand,
  })
}

/** List all running orchestrator task containers. */
export async function listTaskContainers() {
  return new Promise((resolve, reject) => {
    const proc = _spawn('docker', [
      'ps', '-a',
      '--filter', 'name=clai-',
      '--format', '{{.Names}}\t{{.Status}}\t{{.CreatedAt}}',
    ])
    let out = ''
    proc.stdout.on('data', d => { out += d })
    proc.on('close', () => resolve(out.trim()))
    proc.on('error', reject)
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = _spawn(cmd, args)
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d })
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} failed:\n${stderr}`))
      else resolve()
    })
    proc.on('error', reject)
  })
}

function silentRun(cmd, args) {
  return new Promise(resolve => {
    const proc = _spawn(cmd, args)
    proc.on('close', resolve)
    proc.on('error', resolve)  // ignore errors (e.g. container doesn't exist)
  })
}
