import { spawn as _defaultSpawn } from 'child_process'
import { readFileSync, unlinkSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import { SESSIONS_DIR } from './state.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

let _spawn = _defaultSpawn
/** Override the spawn implementation — used by tests. */
export function _setSpawn(fn) { _spawn = fn }
export function _resetSpawn() { _spawn = _defaultSpawn }

/** Stable container name for a given session + task. */
export function containerName(sessionId, taskId) {
  return `clai-${sessionId}-${taskId}`
}

/**
 * Run a task inside a dedicated Docker container.
 *
 * The container is kept alive after the task finishes so the user can
 * exec into it with:  docker exec -it <name> sh
 *
 * @param {object} session
 * @param {object} task
 * @param {function} onChunk  - called with each streamed output chunk
 * @param {object} opts
 * @param {string}  opts.repoPath  - host path to the project repo to mount at /workspace
 * @returns {string}          - the full task result text
 */
export async function runTaskInDocker(session, task, onChunk, { repoPath } = {}) {
  const name = containerName(session.id, task.id)
  // SESSIONS_DIR is a live binding — respects _configure() overrides (used by tests)
  const sessionsDir = SESSIONS_DIR
  const resultFile = join(sessionsDir, `.result-${session.id}-${task.id}`)
  const srcDir = join(projectRoot, 'src')
  const nodeModulesDir = join(projectRoot, 'node_modules')
  const packageJson = join(projectRoot, 'package.json')

  // Remove any leftover container from a previous run of this task
  await silentRun('docker', ['rm', '-f', name])

  const repoMounts = repoPath
    ? buildRepoMounts(repoPath, task.input_paths ?? ['.'], task.output_paths ?? [])
    : ['-w', '/app']

  // Start the container detached — it stays alive via `tail -f /dev/null`
  // The worker is then launched via docker exec below
  await run('docker', [
    'run', '-d',
    '--name', name,
    // Resource caps — prevent runaway tasks from affecting the host
    '--memory=2g',
    '--cpus=2',
    '--pids-limit=512',
    // Drop all Linux capabilities; task code shouldn't need any
    '--cap-drop=ALL',
    // Prevent setuid/setgid binaries from gaining extra privileges
    '--security-opt=no-new-privileges',
    '-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? ''}`,
    '-v', `${sessionsDir}:/app/sessions`,
    '-v', `${srcDir}:/app/src:ro`,
    '-v', `${nodeModulesDir}:/app/node_modules:ro`,
    '-v', `${packageJson}:/app/package.json:ro`,
    ...repoMounts,
    task.docker_image || 'node:22-alpine',
    'tail', '-f', '/dev/null',
  ])

  // Run the worker inside the container; worker streams chunks to stderr.
  // Use --user to match host UID/GID so the worker can write to bind-mounted dirs.
  const uid = process.getuid?.() ?? 0
  const gid = process.getgid?.() ?? 0
  return new Promise((resolve, reject) => {
    const proc = _spawn('docker', [
      'exec',
      '--user', `${uid}:${gid}`,
      name,
      'node', '/app/src/worker.js', session.id, task.id,
    ])

    proc.stderr.on('data', chunk => {
      if (onChunk) onChunk(chunk.toString())
    })

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Worker in container "${name}" exited with code ${code}`))
        return
      }
      try {
        const result = readFileSync(resultFile, 'utf8')
        if (existsSync(resultFile)) unlinkSync(resultFile)
        resolve(result)
      } catch (err) {
        reject(new Error(`Failed to read task result from container: ${err.message}`))
      }
    })

    proc.on('error', err => reject(new Error(`docker exec failed: ${err.message}`)))
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

// ─── Mount builder ────────────────────────────────────────────────────────────

/**
 * Build Docker -v mount flags for a task's file access pattern:
 *
 *  - The repo root is mounted read-only at /workspace
 *  - Each output_path is mounted read-write on top (overlaying the RO base)
 *    Docker processes bind mounts in order, so a later RW mount for a specific
 *    path takes precedence over the earlier RO root mount.
 *  - Directories and non-existent files in output_paths are created on the host
 *    as empty placeholders so Docker has something to bind-mount.
 *
 * @param {string}   repoPath     - Absolute host path to the project repo
 * @param {string[]} inputPaths   - Repo-relative paths to read (mounted RO via root)
 * @param {string[]} outputPaths  - Repo-relative paths to write (overlaid RW)
 * @returns {string[]} Flat array of Docker args: ['-v', '...', '-w', '/workspace', ...]
 */
function buildRepoMounts(repoPath, inputPaths, outputPaths) {
  const args = []

  // Base: whole repo read-only (covers all input_paths)
  args.push('-v', `${repoPath}:/workspace:ro`)
  args.push('-w', '/workspace')

  // Overlay: each output path mounted read-write on top of the RO base
  for (const rel of outputPaths) {
    const hostPath = isAbsolute(rel) ? rel : join(repoPath, rel)
    const containerPath = `/workspace/${rel}`

    // Ensure the host path exists so Docker can bind-mount it.
    // If it looks like a file (has an extension or no trailing slash), create
    // an empty file; otherwise create a directory.
    if (!existsSync(hostPath)) {
      const looksLikeFile = /\.[^/]+$/.test(rel) && !rel.endsWith('/')
      if (looksLikeFile) {
        mkdirSync(dirname(hostPath), { recursive: true })
        writeFileSync(hostPath, '')
      } else {
        mkdirSync(hostPath, { recursive: true })
      }
    }

    args.push('-v', `${hostPath}:${containerPath}`)  // no :ro → writable
  }

  return args
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
