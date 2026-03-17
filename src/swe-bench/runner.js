// src/swe-bench/runner.js
// Main orchestration loop for running clai against SWE-bench instances.
// Clones repos, formats goals, invokes reinforcedSWE, and collects patches.

import { execSync, spawnSync } from 'child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fetchInstances } from './fetch-instances.js'
import { formatGoal } from './goal-formatter.js'
import { extractPatch } from './extract-patch.js'
import { reinforcedSWE } from '../reinforce.js'

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

// ─── Per-instance runner ──────────────────────────────────────────────────────

async function runInstance(instance, { timeout = 600_000, maxRounds = 3, verbose = false, onPlanned = null } = {}) {
  const { instance_id, repo, base_commit } = instance
  let repoDir = null

  try {
    // 1. Clone the repo at the base commit
    repoDir = cloneRepo(repo, base_commit)

    // 2. Format the issue as an SWE goal
    const issueText = formatGoal(instance)
    log(`Running reinforcedSWE for ${instance_id} (up to ${maxRounds} rounds)`)

    // 3. Run the full localize → planSWE → execute → test-fix → reinforce pipeline.
    //    useDocker=true so each session gets a shared container with the repo bind-mounted
    //    at /workspace RW — patches written by the executor flow back to repoDir on host.
    const result = await reinforcedSWE(issueText, repoDir, {
      maxRounds,
      useDocker: true,
      verbose,
      onRound: (round, total) => log(`${instance_id} — round ${round}/${total}`),
      onPlanned: onPlanned ? (round, session) => onPlanned(round, maxRounds, session) : null,
    })

    if (result.success) {
      log(`✓ ${instance_id} — fixed in ${result.rounds} round(s)`)
    } else {
      warn(`${instance_id} — not fixed after ${result.rounds} round(s)`)
    }

    // 4. Extract patch — git diff HEAD picks up all bind-mount writes from the container
    const patch = extractPatch(repoDir)

    if (patch.trim()) {
      log(`  patch captured (${patch.length} chars)`)
    } else {
      warn(`${instance_id} — empty patch`)
    }

    return { instance_id, model_patch: patch.trim(), model_name_or_path: 'clai' }

  } catch (err) {
    warn(`${instance_id} failed: ${err.message}`)
    return { instance_id, model_patch: '', model_name_or_path: 'clai' }
  } finally {
    // Remove the cloned repo — the Docker session container is kept alive
    // for post-hoc inspection (clai containers / docker exec clai-<sid> sh)
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
 *   maxRounds?: number,
 *   verbose?: boolean,
 *   onPlanned?: (round, total, session) => void,
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
    maxRounds   = 3,
    verbose     = false,
    onPlanned   = null,
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
    const results = await Promise.all(
      batch.map(inst => runInstance(inst, { timeout, maxRounds, verbose, onPlanned }))
    )

    for (const result of results) {
      predictions.push(result)
      savePredictions(output, predictions)
      log(`Saved prediction for ${result.instance_id} → ${output}`)
    }
  }

  log(`Done. ${predictions.length} predictions written to ${output}`)
  return predictions
}
