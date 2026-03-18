import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { client, MODELS, _setClient } from './client.js'
export { _setClient }

// JSON Schema for the DAG plan — used as structured output
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique task ID, e.g. task_1',
          },
          title: {
            type: 'string',
            description: 'Short human-readable title (max 60 chars)',
          },
          description: {
            type: 'string',
            description: 'Detailed description of exactly what this task must accomplish — name specific files, APIs, schemas, or design decisions',
          },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of tasks that must complete before this one can start',
          },
          complexity: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description:
              'Estimated effort level — determines which model executes this task. ' +
              'low = Haiku (simple boilerplate, config, file edits), ' +
              'medium = Sonnet (moderate logic, integration, refactoring), ' +
              'high = Opus (complex architecture, algorithms, critical decisions)',
          },
          docker_image: {
            type: 'string',
            description:
              'Docker image best suited to run this task (e.g. "node:22-alpine", "python:3.12-slim", "golang:1.22-alpine"). ' +
              'Choose based on the task\'s runtime requirements.',
          },
          completion_criteria: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Concrete, verifiable conditions that confirm this task is done ' +
              '(e.g. "package.json exists with correct dependencies", "GET /health returns 200")',
          },
          tests: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Shell commands or test invocations to validate the task output ' +
              '(e.g. "npm test", "pytest tests/test_auth.py", "curl -f http://localhost:3000/health")',
          },
          input_paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Repo-relative paths this task needs to READ (mounted read-only). ' +
              'Include files produced by dependency tasks that this task consumes. ' +
              'Use "." to mean the entire repo root (read-only). ' +
              'Examples: ["src/models/user.js", "package.json", "src/db/"]',
          },
          output_paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Repo-relative paths this task will CREATE or MODIFY (mounted read-write). ' +
              'Be specific — list individual files or directories, not the whole repo. ' +
              'For new files that do not exist yet, list them here so the container gets write access. ' +
              'Examples: ["src/routes/auth.js", "tests/auth.test.js", "src/middleware/"]',
          },
          type: {
            type: 'string',
            enum: ['execute', 'branch', 'for_each', 'while', 'barrier', 'wait'],
            description: 'Task type. Default "execute" = Claude implements the task. Use others for control flow.',
          },
          condition:   { type: 'string', description: 'branch/while: condition string. Prefix "exit: " for shell, "js: " for JS, or natural language.' },
          on_true:     { type: 'array', items: { type: 'string' }, description: 'branch: task IDs to activate when condition is true.' },
          on_false:    { type: 'array', items: { type: 'string' }, description: 'branch: task IDs to activate when condition is false.' },
          items:       { type: 'array', items: { type: 'string' }, description: 'for_each: items to iterate over.' },
          template:    { type: 'string', description: 'for_each: task ID of template to clone per item.' },
          collect_into: { type: 'string', description: 'for_each: downstream barrier task ID to wire generated tasks into.' },
          body:        { type: 'string', description: 'while: task ID of body template to clone per iteration.' },
          max_iterations: { type: 'integer', description: 'while: max loop iterations (default 5).' },
          wait_for:    { type: 'array', items: { type: 'string' }, description: 'barrier: task IDs that must all complete.' },
          until:       { type: 'string', description: 'wait: shell command to poll until exit code 0.' },
          timeout_seconds: { type: 'integer', description: 'wait: max seconds before timing out (default 60).' },
          poll_interval_seconds: { type: 'integer', description: 'wait: seconds between polls (default 5).' },
        },
        required: ['id', 'title', 'description', 'dependencies', 'complexity', 'docker_image', 'completion_criteria', 'tests', 'input_paths', 'output_paths'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
}

/**
 * Use Claude to design a task DAG for the given goal.
 * Returns an array of task objects ready to be stored in state.
 */
export async function planDAG(goal, onThinking) {
  const response = await client.messages.create({
    model: MODELS.high,
    max_tokens: 16000,
    system: `You are a senior software architect who breaks complex goals into well-structured task DAGs.

Rules for designing the DAG:
- Each task must be concrete and independently implementable
- Dependencies must form a valid DAG (no cycles)
- Use IDs like task_1, task_2, ... in topological order where possible
- 4–10 tasks is ideal; avoid tasks that are too large or too small
- Front-load foundational tasks (setup, scaffolding) with no dependencies
- Later tasks that build on earlier ones should list those as dependencies
- Be specific in descriptions: name files, APIs, schemas, or design decisions

For each task also provide:
- docker_image: the Docker image whose runtime best fits the task (e.g. node:22-alpine, python:3.12-slim, golang:1.22-alpine, postgres:16-alpine)
- completion_criteria: 2–4 specific, verifiable statements that confirm success (not vague — cite filenames, endpoints, exit codes)
- tests: 1–3 shell commands that can be run inside the container to validate the task output
- input_paths: repo-relative paths this task reads (will be mounted read-only); use ["."] if the whole repo is needed for context
- output_paths: repo-relative paths this task creates or modifies (will be mounted read-write); be specific — list files, not the whole repo root`,
    tools: [{ name: 'submit_plan', description: 'Submit the complete task DAG plan.', input_schema: PLAN_SCHEMA }],
    tool_choice: { type: 'tool', name: 'submit_plan' },
    messages: [
      {
        role: 'user',
        content: `Design a complete task DAG to accomplish this goal end-to-end:\n\n${goal}`,
      },
    ],
  })

  // Surface thinking if callback provided
  if (onThinking) {
    for (const block of response.content) {
      if (block.type === 'thinking') onThinking(block.thinking)
    }
  }

  const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_plan')
  if (!toolBlock) throw new Error('Planner returned no submit_plan tool call')

  const plan = toolBlock.input

  // Validate references
  const ids = new Set(plan.tasks.map(t => t.id))
  for (const task of plan.tasks) {
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) {
        throw new Error(`Task "${task.id}" has unknown dependency "${dep}"`)
      }
    }
  }

  return plan.tasks
}

/**
 * Detect the Python version constraint from a repo's config files.
 * Returns a docker image tag like "python:3.11-slim", or null if not detectable.
 *
 * Checks (in order):
 *   .python-version       — exact version line, e.g. "3.10.4"
 *   pyproject.toml        — requires-python = ">=3.10"
 *   setup.cfg             — python_requires = >=3.9
 *   tox.ini / .travis.yml — python: 3.x lines
 */
function detectPythonImage(repoPath) {
  if (!repoPath) return null

  // .python-version (pyenv/mise)
  const pvFile = join(repoPath, '.python-version')
  if (existsSync(pvFile)) {
    const ver = readFileSync(pvFile, 'utf8').trim().split('\n')[0]
    const m = ver.match(/^(\d+)\.(\d+)/)
    if (m) return `python:${m[1]}.${m[2]}-slim`
  }

  // pyproject.toml — requires-python
  const ppFile = join(repoPath, 'pyproject.toml')
  if (existsSync(ppFile)) {
    const content = readFileSync(ppFile, 'utf8')
    const m = content.match(/requires-python\s*=\s*["'][><=!~^]*\s*(\d+)\.(\d+)/)
    if (m) return `python:${m[1]}.${m[2]}-slim`
  }

  // setup.cfg — python_requires
  const scFile = join(repoPath, 'setup.cfg')
  if (existsSync(scFile)) {
    const content = readFileSync(scFile, 'utf8')
    const m = content.match(/python_requires\s*=\s*[><=!~^]*\s*(\d+)\.(\d+)/)
    if (m) return `python:${m[1]}.${m[2]}-slim`
  }

  // package.json → Node repo, not Python
  if (existsSync(join(repoPath, 'package.json'))) return null

  // Default to a recent but not bleeding-edge Python for broad compatibility
  return 'python:3.11-slim'
}

/**
 * Plan a focused SWE fix DAG using a localization report.
 *
 * Unlike planDAG (which plans from a high-level goal), planSWE receives
 * the localization report and designs a minimal 3-phase plan:
 *   1. Apply the fix (targeted edits to the localized files)
 *   2. while loop: run tests → fix failures (up to max_iterations)
 *   3. Final validation
 *
 * @param {string} issueText         - Original issue description
 * @param {object} localizationReport - Output from localizeIssue()
 * @param {string} repoPath           - Absolute path to the repo
 * @returns {object[]}               - Task array ready for createSession
 */
export async function planSWE(issueText, localizationReport, repoPath, criticFeedback = null) {
  const { summary, relevant_files, relevant_functions, fix_hypothesis, test_files, failing_tests } = localizationReport

  const filesContext = relevant_files.map(f =>
    `- ${f.path}${f.key_lines?.length ? ` (lines: ${f.key_lines.join(', ')})` : ''}: ${f.reason}`
  ).join('\n')

  const functionsContext = (relevant_functions ?? []).map(f =>
    `- ${f.file} → ${f.name}${f.line ? ` (line ${f.line})` : ''}: ${f.relevance}`
  ).join('\n')

  const testContext = (test_files ?? []).join(', ') || 'unknown'
  const failingContext = (failing_tests ?? []).join('\n') || 'run the test suite to find out'

  // Detect the required Python/Node version from the repo so the planner
  // picks a docker_image that actually has the right runtime.
  const detectedImage = detectPythonImage(repoPath)
  const imageHint = detectedImage
    ? `\n**Detected runtime:** Use \`${detectedImage}\` as docker_image for all tasks (detected from repo config).`
    : ''

  const prompt = `Fix the following issue in the repository at ${repoPath}.

## Issue
${issueText}

## Localization Report
**Root cause:** ${summary}

**Fix hypothesis:** ${fix_hypothesis}

**Relevant files:**
${filesContext}

**Relevant functions:**
${functionsContext || '(none identified)'}

**Test files:** ${testContext}
**Currently failing tests:**
${failingContext}
${imageHint}
## Plan requirements
Design a minimal, surgical fix plan with exactly this structure:
1. task_env [execute, complexity: low]: Install the repo's test dependencies so tests can actually run.
   - Detect the package manager: pip (pyproject.toml/setup.cfg/requirements.txt), npm (package.json), etc.
   - Run the install command (e.g. pip install -e ".[test]", npm ci, pip install -r requirements.txt).
   - input_paths: ["."], output_paths: [] (no source files modified).
2. task_fix [execute, complexity: high, depends on task_env]: Apply the fix — edit only the localized files. Be surgical.
   - Use str_replace for targeted edits; only use write_file for new files.
3. task_loop [while, max_iterations: 5, depends on task_fix]: Test-fix loop — run tests, fix failures, repeat until green.
   - body task (task_loop_body) [execute]: Read failing test output and patch the code with str_replace.
   - condition: "exit: ! <test command>" — IMPORTANT: prefix the test command with "! " so the condition
     exits 0 (= true = keep looping) when tests FAIL, and exits non-zero (= false = stop looping) when tests PASS.
     Example: "exit: ! python -m pytest tests/ -x -q"
4. task_summary [execute, complexity: low, depends on task_loop]: Write a brief summary of what was changed and why.

Set input_paths to the relevant files. Set output_paths to only the files that will be modified.
Use the correct docker_image for this repo's language (detect from file extensions in the report).
${criticFeedback ? `\n## Critic Feedback (MUST address in this plan)\n${criticFeedback}` : ''}`

  const response = await client.messages.create({
    model: MODELS.high,
    max_tokens: 16000,
    system: `You are an expert software engineer creating a minimal, surgical fix plan.
Focus: apply the smallest possible change that fixes the issue. Do not refactor or clean up unrelated code.`,
    tools: [{ name: 'submit_plan', description: 'Submit the complete task DAG plan.', input_schema: PLAN_SCHEMA }],
    tool_choice: { type: 'tool', name: 'submit_plan' },
    messages: [{ role: 'user', content: prompt }],
  })

  const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_plan')
  if (!toolBlock) throw new Error('SWE planner returned no submit_plan tool call')

  const plan = toolBlock.input

  const ids = new Set(plan.tasks.map(t => t.id))
  for (const task of plan.tasks) {
    for (const dep of task.dependencies ?? []) {
      if (!ids.has(dep)) throw new Error(`Task "${task.id}" has unknown dependency "${dep}"`)
    }
  }

  return plan.tasks
}
