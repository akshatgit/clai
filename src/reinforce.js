/**
 * Reinforced SWE loop — outer iteration over the full localize → plan → execute pipeline.
 *
 * If the inner while-loop (test-fix) exhausts its iterations and tests still fail,
 * this loop re-localizes with the failure context and tries a completely different fix.
 *
 * Architecture:
 *
 *   for round in 1..maxRounds:
 *     report  = localizeIssue(issue, repo, priorAttempts)   ← gets smarter each round
 *     tasks   = planSWE(issue, report, repo)
 *     session = createSession + runSessionTasks              ← inner while loop inside
 *     result  = runTestSuite(repo)
 *     if result.passed → done ✓
 *     else → priorAttempts.push({ localization, testOutput, patchedFiles })
 *
 * Each round feeds the previous failure back as context so the localizer
 * searches in different parts of the codebase.
 */

import { localizeIssue, runTestSuite } from './localize.js'
import { planSWE } from './planner.js'
import { createSession, saveSession, loadSession } from './state.js'
import { runSessionTasks } from './runner.js'
import { getStats } from './dag.js'

/**
 * @param {string}   issueText
 * @param {string}   repoPath
 * @param {object}   opts
 * @param {number}   opts.maxRounds    - Max outer reinforcement rounds (default 3)
 * @param {boolean}  opts.verbose      - Stream output live
 * @param {boolean}  opts.useDocker    - Run tasks in Docker
 * @param {function} opts.onRound      - Called at start of each round: (round, total) => void
 * @param {function} opts.onLocalized  - Called with localization report each round
 * @param {function} opts.onPlanned    - Called with session after planning each round
 * @param {function} opts.onChunk      - Streamed output chunks
 * @returns {{ success: boolean, rounds: number, sessions: string[], finalOutput: string }}
 */
export async function reinforcedSWE(issueText, repoPath, opts = {}) {
  const {
    maxRounds = 3,
    verbose = false,
    useDocker = false,
    onRound,
    onLocalized,
    onPlanned,
    onChunk,
  } = opts

  const priorAttempts = []
  const sessionIds = []

  for (let round = 1; round <= maxRounds; round++) {
    if (onRound) onRound(round, maxRounds)

    // ── 1. Localize ────────────────────────────────────────────────────────
    const report = await localizeIssue(issueText, repoPath, onChunk, priorAttempts)
    if (onLocalized) onLocalized(round, report)

    // ── 2. Plan ────────────────────────────────────────────────────────────
    const tasks = await planSWE(issueText, report, repoPath)
    const goal = `[SWE r${round}] ${issueText.slice(0, 70)}`
    const session = createSession(goal, tasks)
    session.localization = report
    session.swe_round = round
    saveSession(session)
    sessionIds.push(session.id)
    if (onPlanned) onPlanned(round, session)

    // ── 3. Execute ─────────────────────────────────────────────────────────
    await runSessionTasks(session, { verbose, useDocker, repoPath, onChunk })

    // ── 4. Check tests ─────────────────────────────────────────────────────
    const testResult = runTestSuite(repoPath)

    if (testResult.passed) {
      return {
        success: true,
        rounds: round,
        sessions: sessionIds,
        finalOutput: testResult.output,
      }
    }

    // ── 5. Extract what was patched (from completed session) ───────────────
    const finalSession = loadSession(session.id)
    const patchedFiles = extractPatchedFiles(finalSession)

    priorAttempts.push({
      round,
      localization: report,
      testOutput: testResult.output,
      patchedFiles,
    })
  }

  // All rounds exhausted
  const lastTest = runTestSuite(repoPath)
  return {
    success: false,
    rounds: maxRounds,
    sessions: sessionIds,
    finalOutput: lastTest.output,
  }
}

/**
 * Extract the list of files that were actually written/modified in a session
 * by scanning output_paths of completed execute tasks.
 */
function extractPatchedFiles(session) {
  const files = new Set()
  for (const task of Object.values(session.dag.tasks)) {
    if (task.status !== 'completed') continue
    if ((task.type ?? 'execute') !== 'execute') continue
    for (const p of task.output_paths ?? []) {
      files.add(p)
    }
  }
  return [...files]
}
