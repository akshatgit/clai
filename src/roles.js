/**
 * Multi-agent roles for the SWE pipeline.
 *
 * All roles use MODELS.high (Opus) and structured tool-use output.
 * Each role is a single API call — no agentic loops.
 *
 * Roles:
 *   researcher  — extracts key signals from issue before localization
 *   overseer    — mid-loop checkpoint for the localizer (called every N tool calls)
 *   reviewer    — validates localization report before planning
 *   critic      — challenges the fix plan before execution
 *   debugger_   — interprets test failures after execution (debugger is a reserved word)
 *   verifier    — reviews the git diff patch before final submission
 */

import { execSync } from 'child_process'
import { client, MODELS } from './client.js'

const MODEL = MODELS.high

// ─── Shared helper ─────────────────────────────────────────────────────────────

async function callRole(roleName, systemPrompt, userPrompt, outputSchema) {
  const toolName = `submit_${roleName}`
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    tools: [{ name: toolName, description: `Submit ${roleName} output.`, input_schema: outputSchema }],
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content: userPrompt }],
  })
  const block = response.content.find(b => b.type === 'tool_use' && b.name === toolName)
  if (!block) throw new Error(`Role "${roleName}" returned no tool call`)
  return block.input
}

// ─── Researcher ────────────────────────────────────────────────────────────────

/**
 * Analyzes the issue text and extracts actionable search signals.
 * Output is injected into the localizer's initial prompt as a Research Context block.
 */
export async function researcher(issueText) {
  return callRole(
    'researcher',
    'You are a senior software engineer analyzing a bug report. Extract all actionable signals that will guide a precise code search. Be specific — cite exact names, patterns, and file paths when possible.',
    `Analyze this GitHub issue and extract key signals for locating the bug in the codebase.

## Issue
${issueText}

Extract:
- key_functions: function/method names mentioned or implied by the bug
- key_files: file paths or module names mentioned or inferable
- error_patterns: exact error messages, exception types, or assertion failures
- test_names: test function names if mentioned
- search_queries: 3-5 ripgrep search strings to find the relevant code
- hypothesis: one precise sentence about where the bug is and why`,
    {
      type: 'object',
      properties: {
        key_functions:  { type: 'array', items: { type: 'string' } },
        key_files:      { type: 'array', items: { type: 'string' } },
        error_patterns: { type: 'array', items: { type: 'string' } },
        test_names:     { type: 'array', items: { type: 'string' } },
        search_queries: { type: 'array', items: { type: 'string' } },
        hypothesis:     { type: 'string' },
      },
      required: ['key_functions', 'search_queries', 'hypothesis'],
      additionalProperties: false,
    },
  )
}

// ─── Overseer ──────────────────────────────────────────────────────────────────

/**
 * Mid-loop checkpoint — reviews the localizer's recent tool call history.
 * Called every N tool calls inside localizeIssue.
 * Returns { on_track, guidance } — guidance is injected if not on_track.
 */
export async function overseer(issueText, recentToolCalls) {
  return callRole(
    'overseer',
    'You are an expert code reviewer monitoring an automated localization agent. Be brief and direct. Only redirect if you are confident the agent is wasting time.',
    `A localization agent is searching for a bug in a codebase. Review its recent actions.

## Original Issue
${issueText}

## Recent Tool Calls (last ${recentToolCalls.length})
${recentToolCalls.map((t, i) => `${i + 1}. ${t.name}(${JSON.stringify(t.input).slice(0, 120)})`).join('\n')}

Is the agent investigating the right area? If not, provide a specific one-sentence redirect.`,
    {
      type: 'object',
      properties: {
        on_track: { type: 'boolean' },
        guidance: { type: 'string', description: 'Specific redirect if not on_track, empty string if on_track' },
      },
      required: ['on_track', 'guidance'],
      additionalProperties: false,
    },
  )
}

// ─── Reviewer ──────────────────────────────────────────────────────────────────

/**
 * Validates the localization report against the original issue.
 * Returns { approved, feedback } — if rejected, localizeIssue is called again.
 */
export async function reviewer(issueText, report) {
  return callRole(
    'reviewer',
    'You are a senior software engineer validating a bug localization report. Be rigorous — a wrong localization wastes execution time.',
    `Review this localization report against the original issue.

## Issue
${issueText}

## Localization Report
Summary: ${report.summary}
Fix hypothesis: ${report.fix_hypothesis}
Relevant files: ${report.relevant_files?.map(f => `${f.path} — ${f.reason}`).join('; ')}
Relevant functions: ${report.relevant_functions?.map(f => `${f.name} in ${f.file}`).join('; ') || 'none'}

Does this report correctly identify the root cause? Are any files or functions missing that the issue clearly points to?`,
    {
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
        feedback: { type: 'string', description: 'If not approved: specific gaps, wrong files, or what to look for instead' },
      },
      required: ['approved', 'feedback'],
      additionalProperties: false,
    },
  )
}

// ─── Critic ────────────────────────────────────────────────────────────────────

/**
 * Challenges the fix plan (task DAG) before execution.
 * Returns { approved, issues, suggestion } — if rejected, planSWE is called again with feedback.
 */
export async function critic(issueText, report, tasks) {
  return callRole(
    'critic',
    'You are a critical software engineer reviewing an automated fix plan. Your job is to find flaws, edge cases, and missing steps. Be specific.',
    `Challenge this fix plan for the following bug.

## Issue
${issueText}

## Localization
Fix hypothesis: ${report.fix_hypothesis}
Files to change: ${report.relevant_files?.map(f => f.path).join(', ')}

## Proposed Task Plan
${tasks.map(t => `[${t.id}] ${t.title}\n  ${t.description.slice(0, 200)}`).join('\n\n')}

What could go wrong? Are there edge cases not addressed? Is any step missing or wrong?`,
    {
      type: 'object',
      properties: {
        approved:   { type: 'boolean' },
        issues:     { type: 'array', items: { type: 'string' }, description: 'List of specific problems with the plan' },
        suggestion: { type: 'string', description: 'How the plan should be revised' },
      },
      required: ['approved', 'issues', 'suggestion'],
      additionalProperties: false,
    },
  )
}

// ─── Debugger ──────────────────────────────────────────────────────────────────

/**
 * Interprets test failures after execution.
 * Returns { root_cause, fix_instructions, affected_files } — injected into next round's priorAttempts.
 * Named debugger_ to avoid collision with the JS debugger keyword.
 */
export async function debugger_(testOutput, report, patchedFiles) {
  return callRole(
    'debugger',
    'You are an expert debugger analyzing why an automated fix failed. Be precise — cite exact file paths, line numbers, and what the code should look like.',
    `An automated fix was applied but tests are still failing. Diagnose the remaining problem.

## Localization Report
Summary: ${report.summary}
Fix hypothesis: ${report.fix_hypothesis}

## Files That Were Patched
${patchedFiles.join(', ') || '(none recorded)'}

## Current Test Failures
\`\`\`
${testOutput.slice(0, 3000)}
\`\`\`

What is the root cause of the remaining failure? What exactly needs to change?`,
    {
      type: 'object',
      properties: {
        root_cause:       { type: 'string' },
        fix_instructions: { type: 'string', description: 'Specific, actionable instructions for the next fix attempt' },
        affected_files:   { type: 'array', items: { type: 'string' } },
      },
      required: ['root_cause', 'fix_instructions', 'affected_files'],
      additionalProperties: false,
    },
  )
}

// ─── Verifier ──────────────────────────────────────────────────────────────────

/**
 * Reviews the git diff patch before final submission.
 * Returns { approved, issues, summary }.
 */
export async function verifier(repoPath, report) {
  let patch = '(no changes)'
  try {
    patch = execSync('git diff HEAD', { cwd: repoPath, stdio: 'pipe' }).toString().slice(0, 8000)
    if (!patch.trim()) patch = '(no changes in git diff HEAD)'
  } catch {
    patch = '(could not get git diff)'
  }

  return callRole(
    'verifier',
    'You are a senior engineer doing a final review of an automated patch. Check that it actually fixes the described issue and has no obvious problems.',
    `Review this patch against the original bug report.

## Fix Hypothesis
${report.fix_hypothesis}

## Files Expected to Change
${report.relevant_files?.map(f => f.path).join(', ')}

## Patch (git diff HEAD)
\`\`\`diff
${patch}
\`\`\`

Does this patch correctly implement the fix hypothesis? Is anything missing or wrong?`,
    {
      type: 'object',
      properties: {
        approved: { type: 'boolean' },
        issues:   { type: 'array', items: { type: 'string' } },
        summary:  { type: 'string' },
      },
      required: ['approved', 'issues', 'summary'],
      additionalProperties: false,
    },
  )
}
