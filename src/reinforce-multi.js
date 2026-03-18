/**
 * Multi-agent reinforced SWE loop.
 *
 * Wraps the standard localize → plan → execute → test pipeline with
 * optional role hooks at each stage:
 *
 *   researcher  → localizeIssue(+overseer) → reviewer → planSWE → critic
 *   → runSessionTasks → verifier → runTestSuite → debugger → [next round]
 *
 * Roles are passed in via opts.roles — any subset can be enabled.
 * All roles default to Opus (see src/roles.js).
 */

import { localizeIssue, runTestSuite } from './localize.js'
import { planSWE } from './planner.js'
import { createSession, saveSession, loadSession } from './state.js'
import { runSessionTasks } from './runner.js'
import { getStats } from './dag.js'

/**
 * @param {string} issueText
 * @param {string} repoPath
 * @param {object} opts
 * @param {number}   opts.maxRounds
 * @param {boolean}  opts.verbose
 * @param {boolean}  opts.useDocker
 * @param {object}   opts.roles           - { researcher, overseer, reviewer, critic, debugger_, verifier }
 * @param {number}   opts.maxReviewerRejections  - default 2
 * @param {number}   opts.maxCriticRevisions     - default 1
 * @param {function} opts.onRound
 * @param {function} opts.onLocalized
 * @param {function} opts.onPlanned
 * @param {function} opts.onChunk
 */
export async function reinforcedSWEMulti(issueText, repoPath, opts = {}) {
  const {
    maxRounds = 3,
    verbose = false,
    useDocker = false,
    roles = {},
    maxReviewerRejections = 2,
    maxCriticRevisions = 1,
    onRound,
    onLocalized,
    onPlanned,
    onChunk,
  } = opts

  const priorAttempts = []
  const sessionIds = []

  for (let round = 1; round <= maxRounds; round++) {
    if (onRound) onRound(round, maxRounds)

    // ── 1. Researcher ─────────────────────────────────────────────────────────
    let researcherContext = null
    if (roles.researcher) {
      if (onChunk) onChunk(`\n[researcher: analyzing issue…]\n`)
      try {
        researcherContext = await roles.researcher(issueText)
        if (onChunk) onChunk(`[researcher: hypothesis="${researcherContext.hypothesis}"]\n`)
      } catch (err) {
        if (onChunk) onChunk(`[researcher: error — ${err.message}]\n`)
      }
    }

    // ── 2. Localize (with optional overseer) + Reviewer loop ─────────────────
    let report
    let reviewerRejections = 0

    while (true) {
      report = await localizeIssue(issueText, repoPath, onChunk, priorAttempts, {
        researcherContext,
        overseer: roles.overseer
          ? (issueText_, recentCalls) => roles.overseer(issueText_, recentCalls)
          : null,
      })
      if (onLocalized) onLocalized(round, report)

      if (!roles.reviewer) break

      if (onChunk) onChunk(`\n[reviewer: validating localization…]\n`)
      let review
      try {
        review = await roles.reviewer(issueText, report)
      } catch (err) {
        if (onChunk) onChunk(`[reviewer: error — ${err.message}]\n`)
        break
      }

      if (review.approved) {
        if (onChunk) onChunk(`[reviewer: approved ✓]\n`)
        break
      }

      reviewerRejections++
      if (onChunk) onChunk(`[reviewer: rejected (${reviewerRejections}/${maxReviewerRejections}) — ${review.feedback}]\n`)

      if (reviewerRejections >= maxReviewerRejections) {
        if (onChunk) onChunk(`[reviewer: max rejections reached — proceeding anyway]\n`)
        break
      }

      // Feed reviewer feedback into next localization attempt
      priorAttempts.push({ reviewerFeedback: review.feedback, localization: report, round })
    }

    // ── 3. Plan + Critic loop ─────────────────────────────────────────────────
    let tasks
    let criticRevisions = 0
    let lastCriticFeedback = null

    while (true) {
      tasks = await planSWE(issueText, report, repoPath, lastCriticFeedback)

      if (!roles.critic) break

      if (onChunk) onChunk(`\n[critic: reviewing plan…]\n`)
      let critique
      try {
        critique = await roles.critic(issueText, report, tasks)
      } catch (err) {
        if (onChunk) onChunk(`[critic: error — ${err.message}]\n`)
        break
      }

      if (critique.approved) {
        if (onChunk) onChunk(`[critic: plan approved ✓]\n`)
        break
      }

      criticRevisions++
      if (onChunk) onChunk(`[critic: issues found (${criticRevisions}/${maxCriticRevisions}) — ${critique.issues.join('; ')}]\n`)

      if (criticRevisions >= maxCriticRevisions) {
        if (onChunk) onChunk(`[critic: max revisions reached — proceeding anyway]\n`)
        break
      }

      lastCriticFeedback = critique.suggestion
    }

    // ── 4. Session setup ──────────────────────────────────────────────────────
    const goal = `[SWE-multi r${round}] ${issueText.slice(0, 70)}`
    const session = createSession(goal, tasks)
    session.localization = report
    session.swe_round = round
    saveSession(session)
    sessionIds.push(session.id)
    if (onPlanned) onPlanned(round, session)

    // ── 5. Execute ────────────────────────────────────────────────────────────
    await runSessionTasks(session, { verbose, useDocker, repoPath, onChunk })

    // ── 6. Verifier ───────────────────────────────────────────────────────────
    if (roles.verifier) {
      if (onChunk) onChunk(`\n[verifier: reviewing patch…]\n`)
      try {
        const verification = await roles.verifier(repoPath, report)
        if (verification.approved) {
          if (onChunk) onChunk(`[verifier: patch approved ✓ — ${verification.summary}]\n`)
        } else {
          if (onChunk) onChunk(`[verifier: issues — ${verification.issues.join('; ')}]\n`)
          // Surface issues to next round's priorAttempts
          priorAttempts.push({ verifierIssues: verification.issues, localization: report, round })
        }
      } catch (err) {
        if (onChunk) onChunk(`[verifier: error — ${err.message}]\n`)
      }
    }

    // ── 7. Test suite ─────────────────────────────────────────────────────────
    const testResult = runTestSuite(repoPath)
    if (testResult.passed) {
      return {
        success: true,
        rounds: round,
        sessions: sessionIds,
        finalOutput: testResult.output,
      }
    }

    // ── 8. Debugger ───────────────────────────────────────────────────────────
    const finalSession = loadSession(session.id)
    const patchedFiles = extractPatchedFiles(finalSession)
    let debuggerAnalysis = null

    if (roles.debugger_) {
      if (onChunk) onChunk(`\n[debugger: analyzing failures…]\n`)
      try {
        debuggerAnalysis = await roles.debugger_(testResult.output, report, patchedFiles)
        if (onChunk) onChunk(`[debugger: root_cause="${debuggerAnalysis.root_cause}"]\n`)
      } catch (err) {
        if (onChunk) onChunk(`[debugger: error — ${err.message}]\n`)
      }
    }

    priorAttempts.push({
      round,
      localization: report,
      testOutput: testResult.output,
      patchedFiles,
      debuggerAnalysis,
    })
  }

  const lastTest = runTestSuite(repoPath)
  return {
    success: false,
    rounds: maxRounds,
    sessions: sessionIds,
    finalOutput: lastTest.output,
  }
}

function extractPatchedFiles(session) {
  const files = new Set()
  for (const task of Object.values(session.dag.tasks)) {
    if (task.status !== 'completed') continue
    if ((task.type ?? 'execute') !== 'execute') continue
    for (const p of task.output_paths ?? []) files.add(p)
  }
  return [...files]
}
