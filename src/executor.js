import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { dirname } from 'path'
import { client, MODELS, _setClient } from './client.js'
export { _setClient }

// Model selection by task complexity — use cheaper models for simpler tasks
export const COMPLEXITY_MODEL_MAP = MODELS

// Tools Claude can use to actually implement tasks
const TASK_TOOLS = [
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or path relative to /workspace' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command. Returns stdout + stderr combined. Use for npm install, mkdir, chmod, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Working directory (default: /workspace)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read the content of an existing file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'str_replace',
    description: 'Replace an exact string in a file. Safer than write_file for small edits — only the changed lines are rewritten. Fails if old_str is not found or appears more than once.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path to edit' },
        old_str: { type: 'string', description: 'Exact string to replace (must appear exactly once in the file)' },
        new_str: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_str', 'new_str'],
      additionalProperties: false,
    },
  },
]

/**
 * Execute a tool call and return the result string.
 *
 * @param {string} name
 * @param {object} input
 * @param {object} opts
 * @param {string}   [opts.workspaceDir]      - Remap /workspace to this host path for file ops
 * @param {Function} [opts.dockerRunCommand]  - Override run_command to exec in Docker container
 */
function executeTool(name, input, opts = {}) {
  const { workspaceDir = null, dockerRunCommand = null } = opts

  // Remap /workspace paths to the host workspaceDir (used in Docker mode)
  function resolve(p) {
    if (!workspaceDir) return p
    if (p === '/workspace') return workspaceDir
    if (p.startsWith('/workspace/')) return workspaceDir + '/' + p.slice('/workspace/'.length)
    return p
  }

  try {
    if (name === 'write_file') {
      const { path, content } = input
      const resolved = resolve(path)
      mkdirSync(dirname(resolved), { recursive: true })
      writeFileSync(resolved, content)
      return `OK: wrote ${content.length} bytes to ${path}`
    }

    if (name === 'run_command') {
      const { command, cwd = '/workspace' } = input
      if (dockerRunCommand) {
        return dockerRunCommand(command, cwd)
      }
      const resolvedCwd = resolve(cwd)
      const out = execSync(command, {
        cwd: existsSync(resolvedCwd) ? resolvedCwd : (workspaceDir ?? '/workspace'),
        stdio: 'pipe',
        timeout: 120_000,
      })
      return out.toString() || '(no output)'
    }

    if (name === 'read_file') {
      const { path } = input
      return readFileSync(resolve(path), 'utf8')
    }

    if (name === 'str_replace') {
      const { path, old_str, new_str } = input
      const resolved = resolve(path)
      const content = readFileSync(resolved, 'utf8')
      const count = content.split(old_str).length - 1
      if (count === 0) return `ERROR: str_replace: string not found in ${path}`
      if (count > 1) return `ERROR: str_replace: string found ${count} times — make old_str more specific`
      writeFileSync(resolved, content.replace(old_str, new_str))
      return `OK: replaced string in ${path}`
    }

    return `ERROR: unknown tool "${name}"`
  } catch (err) {
    return `ERROR: ${err.message}`
  }
}

/**
 * Execute a single task using Claude with tool use.
 * Claude can write files and run commands inside the container.
 *
 * @param {object} session   - Full session object (for goal + completed context)
 * @param {object} task      - The task to execute
 * @param {function} onChunk - Called with each streamed text/status chunk
 * @returns {string}         - The full result text
 */
export async function executeTask(session, task, onChunk, opts = {}) {
  const completedContext = buildCompletedContext(session)
  const previousAttempt = task.result
    ? `\n\nNote: This task was previously attempted. Previous result:\n${task.result}\n\nPlease improve upon or complete the previous attempt.`
    : ''

  const completionBlock = task.completion_criteria?.length
    ? `\n## Completion Criteria\n${task.completion_criteria.map(c => `- ${c}`).join('\n')}`
    : ''
  const testsBlock = task.tests?.length
    ? `\n## Validation Tests\nRun these to verify your work:\n${task.tests.map(t => `  ${t}`).join('\n')}`
    : ''
  const inputBlock = task.input_paths?.length
    ? `\n**Read-only inputs** (available at /workspace):\n${task.input_paths.map(p => `  ${p}`).join('\n')}`
    : ''
  const outputBlock = task.output_paths?.length
    ? `\n**Writable outputs** (write to these paths):\n${task.output_paths.map(p => `  /workspace/${p}`).join('\n')}`
    : ''

  const prompt = `You are implementing a specific task within a larger software project.
The project repo is at /workspace. Use the provided tools to write files and run commands.

## Overall Goal
${session.goal}

## Completed Work So Far
${completedContext || 'This is the first task — no prior work yet.'}

## Your Current Task
**ID:** ${task.id}
**Title:** ${task.title}
**Complexity:** ${task.complexity}
**Runtime:** ${task.docker_image || 'node:22-alpine'}

**Description:**
${task.description}
${inputBlock}
${outputBlock}
${completionBlock}
${testsBlock}
${previousAttempt}

## Instructions
Use the write_file and run_command tools to implement this task completely.
1. Write all required files to /workspace using write_file
2. Run any necessary commands (npm install, chmod, etc.) using run_command
3. Run the validation tests listed above to confirm everything works
4. End with a brief summary of what you did`

  const model = COMPLEXITY_MODEL_MAP[task.complexity] ?? COMPLEXITY_MODEL_MAP.high

  const messages = [{ role: 'user', content: prompt }]
  let resultLines = []

  // Agentic loop: keep going until Claude stops using tools
  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: 16384,
      system: 'You are an expert software developer. Use the provided tools to implement tasks completely — write actual files and run commands.',
      tools: TASK_TOOLS,
      messages,
    })

    // Collect text from this response turn
    for (const block of response.content) {
      if (block.type === 'text') {
        resultLines.push(block.text)
        if (onChunk) onChunk(block.text)
      } else if (block.type === 'tool_use') {
        if (onChunk) onChunk(`\n[tool: ${block.name}(${JSON.stringify(block.input).slice(0, 80)}…)]\n`)
      }
    }

    // If Claude is done, break
    if (response.stop_reason === 'end_turn') break

    // Otherwise, execute tool calls and continue
    const toolResults = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const output = executeTool(block.name, block.input, opts)
      if (onChunk) onChunk(`→ ${output.slice(0, 120)}\n`)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
      })
    }

    // Add assistant response + tool results to history
    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }

  return resultLines.join('\n')
}

export function buildCompletedContext(session) {
  const completed = Object.values(session.dag.tasks)
    .filter(t => t.status === 'completed')
    .sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at))

  if (completed.length === 0) return ''

  return completed
    .map(t => {
      const summary = extractSummary(t.result)
      return `### ${t.title}\n${summary}`
    })
    .join('\n\n')
}

export function extractSummary(result) {
  if (!result) return 'No result recorded.'
  const summaryMatch = result.match(/#+\s*Summary\s*\n([\s\S]*?)(?:\n#|$)/i)
  if (summaryMatch) return summaryMatch[1].trim()
  return result.length > 600
    ? '...' + result.slice(-600).trim()
    : result.trim()
}
