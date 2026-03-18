/**
 * Issue localizer — given a bug report / issue text and a repo path,
 * uses Claude with repo navigation tools to identify exactly which
 * files, functions, and lines are relevant.
 *
 * Returns a structured LocalizationReport used by planSWE() to create
 * a focused, minimal fix plan.
 */

import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { client, MODELS } from './client.js'

// ─── Localization report schema ───────────────────────────────────────────────
// Defined first so submit_report tool can reference it.

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One paragraph explaining the root cause of the issue',
    },
    relevant_files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path:   { type: 'string' },
          reason: { type: 'string', description: 'Why this file is relevant' },
          key_lines: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Line numbers most likely to need changes',
          },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    },
    relevant_functions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file:     { type: 'string' },
          name:     { type: 'string' },
          line:     { type: 'integer' },
          relevance: { type: 'string' },
        },
        required: ['file', 'name', 'relevance'],
        additionalProperties: false,
      },
    },
    test_files: {
      type: 'array',
      items: { type: 'string' },
      description: 'Test files that cover the affected code',
    },
    failing_tests: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific test names/IDs that currently fail (if determinable)',
    },
    fix_hypothesis: {
      type: 'string',
      description: 'Concrete hypothesis for how to fix the issue (2-3 sentences)',
    },
  },
  required: ['summary', 'relevant_files', 'fix_hypothesis'],
  additionalProperties: false,
}

// ─── Repo navigation tools ────────────────────────────────────────────────────

const LOCALIZE_TOOLS = [
  {
    name: 'search_code',
    description: 'Search the repo for a pattern using ripgrep. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:   { type: 'string', description: 'Regex or literal string to search for' },
        path:      { type: 'string', description: 'Subdirectory to search in (default: repo root)' },
        file_glob: { type: 'string', description: 'File glob filter e.g. "*.py", "*.ts" (optional)' },
        context_lines: { type: 'integer', description: 'Lines of context around each match (default 3)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_file_tree',
    description: 'List the directory structure of the repo. Use to understand layout before diving into files.',
    input_schema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'Directory to list (default: repo root)' },
        depth: { type: 'integer', description: 'Max depth (default 3)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read the content of a file. For large files (>300 lines) prefer read_range to get specific sections.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or repo-relative file path' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_range',
    description: 'Read specific lines from a file. Use after search_code to see surrounding context.',
    input_schema: {
      type: 'object',
      properties: {
        path:       { type: 'string',  description: 'File path' },
        start_line: { type: 'integer', description: 'First line to read (1-indexed)' },
        end_line:   { type: 'integer', description: 'Last line to read (inclusive)' },
      },
      required: ['path', 'start_line', 'end_line'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_tests',
    description: 'Run the test suite (or a specific test file) and return output. Use to understand what currently fails.',
    input_schema: {
      type: 'object',
      properties: {
        test_path:  { type: 'string', description: 'Specific test file or directory (optional — runs all if omitted)' },
        extra_args: { type: 'string', description: 'Extra CLI args e.g. "-x --tb=short" (optional)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'submit_report',
    description: 'Submit your final localization report once you have identified the root cause. Call this exactly once when done.',
    input_schema: REPORT_SCHEMA,
  },
]

// ─── Tool executor ─────────────────────────────────────────────────────────────

function executeLocalizeTool(name, input, repoPath) {
  const cwd = repoPath || '/workspace'

  try {
    if (name === 'search_code') {
      const { pattern, path = '.', file_glob, context_lines = 3 } = input
      const globFlag = file_glob ? `--glob '${file_glob}'` : ''
      const cmd = `rg -n -C ${context_lines} ${globFlag} ${JSON.stringify(pattern)} ${path}`
      try {
        return execSync(cmd, { cwd, stdio: 'pipe', timeout: 15_000 }).toString() || '(no matches)'
      } catch (e) {
        // rg exits 1 when no matches found
        return e.stdout?.toString() || '(no matches)'
      }
    }

    if (name === 'get_file_tree') {
      const { path = '.', depth = 3 } = input
      try {
        return execSync(`find ${path} -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/__pycache__/*' | head -200`, {
          cwd, stdio: 'pipe', timeout: 10_000,
        }).toString()
      } catch {
        return execSync(`ls -la ${path}`, { cwd, stdio: 'pipe' }).toString()
      }
    }

    if (name === 'read_file') {
      const fullPath = input.path.startsWith('/') ? input.path : `${cwd}/${input.path}`
      if (!existsSync(fullPath)) return `ERROR: file not found: ${fullPath}`
      const content = readFileSync(fullPath, 'utf8')
      const totalLines = content.split('\n').length
      // Cap at 20000 chars; tell Claude the total line count so it can use read_range
      if (content.length > 20_000) {
        return content.slice(0, 20_000) +
          `\n... (truncated — file has ${totalLines} lines total. Use read_range to read specific sections.)`
      }
      return content
    }

    if (name === 'read_range') {
      const { path, start_line, end_line } = input
      const fullPath = path.startsWith('/') ? path : `${cwd}/${path}`
      if (!existsSync(fullPath)) return `ERROR: file not found: ${fullPath}`
      const lines = readFileSync(fullPath, 'utf8').split('\n')
      const slice = lines.slice(start_line - 1, end_line)
      return slice.map((l, i) => `${start_line + i}: ${l}`).join('\n')
    }

    if (name === 'run_tests') {
      const { test_path = '', extra_args = '--tb=short -q' } = input
      // Auto-detect test runner
      const hasPackageJson = existsSync(`${cwd}/package.json`)
      const hasPytest = existsSync(`${cwd}/pytest.ini`) ||
                        existsSync(`${cwd}/setup.cfg`) ||
                        existsSync(`${cwd}/pyproject.toml`)

      let cmd
      if (hasPytest) {
        cmd = `python -m pytest ${extra_args} ${test_path}`.trim()
      } else if (hasPackageJson) {
        cmd = test_path
          ? `node --test ${test_path}`
          : `npm test -- ${extra_args}`.trim()
      } else {
        cmd = `python -m pytest ${extra_args} ${test_path}`.trim()
      }

      try {
        const out = execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 })
        return out.toString().slice(0, 4000)
      } catch (e) {
        return ((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).slice(0, 4000)
      }
    }

    // submit_report is handled by the caller — should not reach here
    if (name === 'submit_report') return '__report_submitted__'

    return `ERROR: unknown tool "${name}"`
  } catch (err) {
    return `ERROR: ${err.message}`
  }
}

// ─── Main exports ──────────────────────────────────────────────────────────────

/**
 * Run the test suite in a repo and return { passed, output }.
 * Auto-detects pytest vs npm test.
 */
export function runTestSuite(repoPath) {
  const cwd = repoPath
  const hasPytest = existsSync(`${cwd}/pytest.ini`) ||
                    existsSync(`${cwd}/setup.cfg`) ||
                    existsSync(`${cwd}/pyproject.toml`)
  const cmd = hasPytest
    ? 'python -m pytest --tb=short -q'
    : 'npm test'
  try {
    const out = execSync(cmd, { cwd, stdio: 'pipe', timeout: 120_000 }).toString()
    return { passed: true, output: out.slice(0, 3000) }
  } catch (e) {
    const out = ((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).slice(0, 3000)
    return { passed: false, output: out }
  }
}

/**
 * Localize a bug/issue within a repo using an agentic tool-use loop.
 *
 * Claude uses the navigation tools to explore the repo, then calls submit_report
 * with the structured result. This avoids the output_config + tools API conflict.
 *
 * @param {string}   issueText     - The issue description / bug report
 * @param {string}   repoPath      - Absolute path to the repository on the host
 * @param {function} onChunk       - Called with progress strings (optional)
 * @param {object[]} priorAttempts - Previous failed rounds for reinforcement context
 * @returns {LocalizationReport}
 */
/**
 * @param {string}   issueText
 * @param {string}   repoPath
 * @param {function} onChunk
 * @param {object[]} priorAttempts
 * @param {object}   opts
 * @param {object}   [opts.researcherContext]  - Output from researcher role; injected into prompt
 * @param {function} [opts.overseer]           - Called every 5 tool calls: (issueText, recentCalls) => { on_track, guidance }
 */
export async function localizeIssue(issueText, repoPath, onChunk, priorAttempts = [], opts = {}) {
  const { researcherContext = null, overseer = null } = opts

  // Build prior attempts context block
  const priorContext = priorAttempts.length === 0 ? '' : `
## Prior Fix Attempts (all failed — do NOT repeat these approaches)
${priorAttempts.map((a, i) => `
### Round ${i + 1} — FAILED
**Files we thought were relevant:** ${a.localization?.relevant_files?.map(f => f.path).join(', ') ?? 'unknown'}
**Fix hypothesis we used:** ${a.localization?.fix_hypothesis ?? 'unknown'}
**What we patched:** ${(a.patchedFiles ?? []).join(', ') || 'unknown'}
**Test output after fix:**
\`\`\`
${a.testOutput?.slice(0, 800) ?? '(no output)'}
\`\`\`
${a.debuggerAnalysis ? `**Debugger analysis:** ${a.debuggerAnalysis.root_cause}
**Fix instructions from debugger:** ${a.debuggerAnalysis.fix_instructions}
**Debugger identified files:** ${a.debuggerAnalysis.affected_files?.join(', ') ?? 'unknown'}` : ''}
${a.reviewerFeedback ? `**Reviewer feedback:** ${a.reviewerFeedback}` : ''}
**Conclusion:** This localization was wrong or incomplete. Look elsewhere.
`).join('\n')}`

  // Researcher context block (injected when multi-agent mode is on)
  const researchContext = researcherContext ? `
## Research Context (pre-analyzed — start here)
**Key functions:** ${researcherContext.key_functions?.join(', ') ?? 'none'}
**Key files:** ${researcherContext.key_files?.join(', ') ?? 'none'}
**Error patterns:** ${researcherContext.error_patterns?.join(', ') ?? 'none'}
**Test names:** ${researcherContext.test_names?.join(', ') ?? 'none'}
**Suggested searches:** ${researcherContext.search_queries?.join('; ') ?? 'none'}
**Hypothesis:** ${researcherContext.hypothesis}

Start your investigation with these leads before exploring elsewhere.` : ''

  const prompt = `You are an expert software engineer analyzing a bug report.
Your job is to localize the issue — find exactly which files, functions, and lines are relevant.

Repository path: ${repoPath}

## Issue / Bug Report
${issueText}
${researchContext}
${priorContext}

## Instructions
1. Use get_file_tree to understand the repo structure
2. Use run_tests FIRST to see the actual failure output — the traceback gives exact file/line numbers
3. Use search_code to find code related to the issue (error messages, function names, keywords)
4. Use read_file / read_range to read the relevant sections
   - For large files (>300 lines), use read_range with the specific line numbers from step 2-3
5. When you have enough information, call submit_report with the structured result
${priorAttempts.length > 0 ? '\nIMPORTANT: Previous attempts failed. Look in different files than before. Start from the test traceback, not from the issue description.' : ''}

Be thorough but focused — only include files/functions that are actually relevant to this specific issue.`

  const messages = [{ role: 'user', content: prompt }]
  let toolCallCount = 0
  const recentToolCalls = []  // rolling window for overseer

  // Agentic loop — runs until Claude calls submit_report
  while (true) {
    const response = await client.messages.create({
      model: MODELS.low,
      max_tokens: 16000,
      system: 'You are an expert software engineer. Localize bugs precisely using the provided tools. When done, call submit_report.',
      tools: LOCALIZE_TOOLS,
      messages,
    })

    // Progress notifications
    for (const block of response.content) {
      if (block.type === 'text' && onChunk) onChunk(block.text)
      if (block.type === 'tool_use' && onChunk) {
        onChunk(`\n[localize: ${block.name}(${JSON.stringify(block.input).slice(0, 100)}…)]\n`)
      }
    }

    // Execute tool calls; intercept submit_report to return the report
    const toolResults = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      if (block.name === 'submit_report') {
        // Report submitted — return it directly (input is the validated report object)
        return block.input
      }

      const output = executeLocalizeTool(block.name, block.input, repoPath)
      if (onChunk) onChunk(`→ ${output.slice(0, 200)}\n`)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output })

      // Track tool calls for overseer
      toolCallCount++
      recentToolCalls.push({ name: block.name, input: block.input })
      if (recentToolCalls.length > 10) recentToolCalls.shift()
    }

    // Overseer checkpoint every 5 tool calls
    if (overseer && toolCallCount > 0 && toolCallCount % 5 === 0) {
      try {
        const check = await overseer(issueText, recentToolCalls.slice(-5))
        if (!check.on_track && check.guidance) {
          if (onChunk) onChunk(`\n[overseer: redirecting — ${check.guidance}]\n`)
          toolResults.push({ type: 'text', text: `[OVERSEER]: ${check.guidance}` })
        } else if (onChunk) {
          onChunk(`\n[overseer: on track ✓]\n`)
        }
      } catch (err) {
        if (onChunk) onChunk(`\n[overseer: error — ${err.message}]\n`)
      }
    }

    // If stop_reason is end_turn with no submit_report, something went wrong
    if (response.stop_reason === 'end_turn') {
      throw new Error('Localizer ended without calling submit_report')
    }

    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }
}
