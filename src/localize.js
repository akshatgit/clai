/**
 * Issue localizer — given a bug report / issue text and a repo path,
 * uses Claude with repo navigation tools to identify exactly which
 * files, functions, and lines are relevant.
 *
 * Returns a structured LocalizationReport used by planSWE() to create
 * a focused, minimal fix plan.
 */

import Anthropic from '@anthropic-ai/sdk'
import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'

let _client = null
function getClient() {
  if (!_client) _client = new Anthropic()
  return _client
}
export function _setClient(c) { _client = c }

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
    description: 'Read the full content of a file.',
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
        test_path: { type: 'string', description: 'Specific test file or directory (optional — runs all if omitted)' },
        extra_args: { type: 'string', description: 'Extra CLI args e.g. "-x --tb=short" (optional)' },
      },
      additionalProperties: false,
    },
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
      // Cap at 8000 chars to avoid context blowup
      return content.length > 8000 ? content.slice(0, 8000) + '\n... (truncated)' : content
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

    return `ERROR: unknown tool "${name}"`
  } catch (err) {
    return `ERROR: ${err.message}`
  }
}

// ─── Localization report schema ───────────────────────────────────────────────

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

// ─── Main export ──────────────────────────────────────────────────────────────

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
 * @param {string}   issueText     - The issue description / bug report
 * @param {string}   repoPath      - Absolute path to the repository on the host
 * @param {function} onChunk       - Called with progress strings (optional)
 * @param {object[]} priorAttempts - Previous failed rounds for reinforcement context
 * @returns {LocalizationReport}
 */
export async function localizeIssue(issueText, repoPath, onChunk, priorAttempts = []) {
  // Build prior attempts context block
  const priorContext = priorAttempts.length === 0 ? '' : `
## Prior Fix Attempts (all failed — do NOT repeat these approaches)
${priorAttempts.map((a, i) => `
### Round ${i + 1} — FAILED
**Files we thought were relevant:** ${a.localization.relevant_files.map(f => f.path).join(', ')}
**Fix hypothesis we used:** ${a.localization.fix_hypothesis}
**What we patched:** ${(a.patchedFiles ?? []).join(', ') || 'unknown'}
**Test output after fix:**
\`\`\`
${a.testOutput?.slice(0, 800) ?? '(no output)'}
\`\`\`
**Conclusion:** This localization was wrong or incomplete. Look elsewhere.
`).join('\n')}`

  const prompt = `You are an expert software engineer analyzing a bug report.
Your job is to localize the issue — find exactly which files, functions, and lines are relevant.

Repository path: ${repoPath}

## Issue / Bug Report
${issueText}
${priorContext}

## Instructions
1. Use get_file_tree to understand the repo structure
2. Use run_tests FIRST to see the actual failure output — the traceback gives exact file/line numbers
3. Use search_code to find code related to the issue (error messages, function names, keywords)
4. Use read_file / read_range to read the relevant sections
5. When you have enough information, output a JSON localization report
${priorAttempts.length > 0 ? '\nIMPORTANT: Previous attempts failed. Look in different files than before. Start from the test traceback, not from the issue description.' : ''}

Be thorough but focused — only include files/functions that are actually relevant to this specific issue.`

  const messages = [{ role: 'user', content: prompt }]

  // Agentic loop — keep going until Claude outputs the JSON report
  while (true) {
    const response = await getClient().messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      system: 'You are an expert software engineer. Localize bugs precisely using the provided tools.',
      tools: LOCALIZE_TOOLS,
      output_config: {
        format: {
          type: 'json_schema',
          schema: REPORT_SCHEMA,
        },
      },
      messages,
    })

    // Stream text progress
    for (const block of response.content) {
      if (block.type === 'text' && onChunk) onChunk(block.text)
      if (block.type === 'tool_use' && onChunk) {
        onChunk(`\n[localize: ${block.name}(${JSON.stringify(block.input).slice(0, 100)}…)]\n`)
      }
    }

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text')?.text
      if (!text) throw new Error('Localizer returned no report')
      return JSON.parse(text)
    }

    // Execute tool calls
    const toolResults = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const output = executeLocalizeTool(block.name, block.input, repoPath)
      if (onChunk) onChunk(`→ ${output.slice(0, 200)}\n`)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output })
    }

    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }
}
