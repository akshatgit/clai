// src/swe-bench/runner.js
// Main orchestration loop for running clai against SWE-bench instances.
// Clones repos, formats goals, invokes clai, and collects patches.

import { execSync, spawnSync } from 'child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fetchInstances } from './fetch-instances.js'
import { formatGoal } from './goal-formatter.js'
import { extractPatch } from './extract-patch.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[swe-bench] ${msg}`) }
function warn(msg) { console.warn(`[swe-bench] ⚠  ${msg}`) }

/** Load existing predictions from a JSON file (returns [] if absent/invalid). */
function loadPredictions(outputPath) {
  if (!existsSync(outputPath)) return []
  try {
    return JSON.parse(readFileSync(outputPath, 'utf8'))
  } catch {
    return []
  }
}

/** Persist the predictions array to disk atomically-ish. */
function savePredictions(outputPath, predictions) {
  writeFileSync(outputPath, JSON.stringify(predictions, null, 2))
}

/**
 * Clone a GitHub repo at a specific commit into a fresh temp directory.
 * Returns the temp dir path.
 */
function cloneRepo(repo, baseCommit) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'clai-swe-'))
  const repoUrl = `https://github.com/${repo}.git`

  log(`Cloning ${repo}@${baseCommit} → ${tmpDir}`)

  // Shallow clone default branch then checkout the specific commit
  spawnSync('git', ['clone', '--quiet', repoUrl, tmpDir], {
    stdio: 'inherit',
    timeout: 120_000,
  })

  spawnSync('git', ['checkout', '--quiet', baseCommit], {
    cwd: tmpDir,
    stdio: 'inherit',
    timeout: 30_000,
  })

  return tmpDir
}

/**
 * Run `clai start <goal> --run --docker --repo <repoDir>` synchronously.
 * Returns the session ID extracted from stdout, or null on failure.
 */
function claiStartAndRun(goal, repoDir, { patchOutput = null, timeout = 600_000 } = {}) {
  // Find the clai binary relative to this file: ../../index.js → run via node
  const claiIndex = join(import.meta.dirname, '..', 'index.js')

  const args = ['start', goal, '--run', '--docker', '--repo', repoDir]
  if (patchOutput) args.push('--patch-output', patchOutput)

  const result = spawnSync(process.execPath, [claiIndex, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout,
  })

  if (result.error) {
    warn(`clai spawn error: ${result.error.message}`)
    return null
  }

  const output = (result.stdout ?? '') + (result.stderr ?? '')

  // Extract session ID from output like "Session ID: sess_abc123"
  const match = output.match(/Session\s+(?:ID:\s*)?(\S+)\s+created/)
    ?? output.match(/Session ID:\s*(\S+)/)
  if (match) return match[1]

  // Fallback: look for any sess_... token
  const fallback = output.match(/\b(sess_[a-z0-9]+)\b/)
  return fallback ? fallback[1] : null
}

// ─── Per-instance runner ──────────────────────────────────────────────────────

async function runInstance(instance, { timeout = 600_000 } = {}) {
  const { instance_id, repo, base_commit } = instance
  let repoDir = null

  try {
    // 1. Clone the repo at the base commit
    repoDir = cloneRepo(repo, base_commit)

    // 2. Build a patch output path inside a temp file
    const patchFile = join(tmpdir(), `clai-patch-${instance_id}.diff`)

    // 3. Format goal and run clai
    const goal = formatGoal(instance)
    log(`Running clai for ${instance_id}`)
    claiStartAndRun(goal, repoDir, { patchOutput: patchFile, timeout })

    // 4. Extract patch — prefer patch file written by clai run, fall back to git diff
    let patch = ''
    if (existsSync(patchFile)) {
      patch = readFileSync(patchFile, 'utf8')
    }
    if (!patch) {
      patch = extractPatch(repoDir)
    }

    if (patch.trim()) {
      log(`✓ ${instance_id} — patch captured (${patch.length} chars)`)
    } else {
      warn(`${instance_id} — empty patch`)
    }

    return { instance_id, model_patch: patch.trim(), model_name_or_path: 'clai' }

  } catch (err) {
    warn(`${instance_id} failed: ${err.message}`)
    return { instance_id, model_patch: '', model_name_or_path: 'clai' }
  } finally {
    // Clean up temp dir
    if (repoDir) {
      try { execSync(`rm -rf "${repoDir}"`, { timeout: 10_000 }) } catch {}
    }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run clai against SWE-bench instances and write predictions.json.
 *
 * @param {{
 *   dataset?: 'lite'|'verified',
 *   limit?: number,
 *   instanceId?: string,
 *   output?: string,
 *   concurrency?: number,
 *   timeout?: number,
 * }} opts
 */
export async function runSweBench(opts = {}) {
  const {
    dataset     = 'lite',
    limit       = 300,
    instanceId  = null,
    output      = 'predictions.json',
    concurrency = 1,
    timeout     = 600_000,
  } = opts

  // Load existing predictions to support resume
  const predictions = loadPredictions(output)
  const done = new Set(predictions.map(p => p.instance_id))

  log(`Fetching instances from ${dataset}…`)
  const instances = await fetchInstances(dataset, { limit, instanceId })
  log(`Fetched ${instances.length} instance(s)`)

  // Filter out already-completed instances (resume support)
  const pending = instances.filter(i => !done.has(i.instance_id))
  if (pending.length < instances.length) {
    log(`Skipping ${instances.length - pending.length} already-completed instance(s)`)
  }

  if (pending.length === 0) {
    log('Nothing to do.')
    return predictions
  }

  log(`Running ${pending.length} instance(s) with concurrency=${concurrency}`)

  // Process in batches of `concurrency`
  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency)
    const results = await Promise.all(batch.map(inst => runInstance(inst, { timeout })))

    for (const result of results) {
      predictions.push(result)
      savePredictions(output, predictions)
      log(`Saved prediction for ${result.instance_id} → ${output}`)
    }
  }

  log(`Done. ${predictions.length} predictions written to ${output}`)
  return predictions
}
