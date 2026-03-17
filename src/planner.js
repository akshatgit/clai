import Anthropic from '@anthropic-ai/sdk'

let _client = null
function getClient() {
  if (!_client) _client = new Anthropic()
  return _client
}
/** Override the Anthropic client — used by tests. */
export function _setClient(c) { _client = c }

// JSON Schema for the DAG plan — used as structured output
const PLAN_SCHEMA = {
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
  const response = await getClient().messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    output_config: {
      format: {
        type: 'json_schema',
        schema: PLAN_SCHEMA,
      },
    },
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

  const text = response.content.find(b => b.type === 'text')?.text
  if (!text) throw new Error('Planner returned no text block')

  const plan = JSON.parse(text)

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
