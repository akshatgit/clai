# clai

AI-powered task orchestration system that breaks down goals into DAGs and executes them with Claude.

## Architecture

```
src/
  index.js     CLI entry point (commander) — 7 commands
  planner.js   Claude Opus plans the task DAG (structured JSON output)
  executor.js  Claude executes individual tasks (streaming)
  docker.js    Docker container runner — each task gets its own container
  worker.js    In-container task executor (called via docker exec)
  state.js     Session persistence (sessions/*.json, logs/*.jsonl)
  dag.js       Topological sort, ready-task selection, cycle detection
  hooks.js     Event emission to JSONL logs
```

## Task Structure

Each task in the DAG has:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID, e.g. `task_1` |
| `title` | string | Short title (≤60 chars) |
| `description` | string | Detailed implementation spec |
| `dependencies` | string[] | IDs of tasks that must complete first |
| `complexity` | `low\|medium\|high` | Controls which Claude model runs the task |
| `docker_image` | string | Docker image for the task container (e.g. `node:22-alpine`) |
| `completion_criteria` | string[] | Verifiable conditions that confirm success |
| `tests` | string[] | Shell commands to validate the output |

## Model Mapping (complexity → model)

| Complexity | Model | Use when |
|------------|-------|----------|
| `low` | `claude-haiku-4-5-20251001` | Boilerplate, config, file edits |
| `medium` | `claude-sonnet-4-6` | Logic, integration, refactoring |
| `high` | `claude-opus-4-6` | Architecture, algorithms, critical decisions |

## Docker Execution

Each task runs in its own Docker container that **persists after the task** so you can inspect or continue work:

```bash
# Run with Docker
clai run <session-id> --docker [--repo /path/to/project]

# Container name format
clai-<sessionId>-<taskId>

# Exec into a running container
docker exec -it clai-sess_abc123-task_1 sh

# List all task containers
clai containers
```

- `--repo <path>` mounts the project repo at `/workspace` inside the container (defaults to cwd)
- The clai's `src/`, `node_modules/`, and `sessions/` are also mounted (read-only where safe)

## Invocation Modes

### CLI
```bash
clai start "build a REST API" [--run]
clai run <session-id> [--docker] [--repo ./my-project] [--verbose]
clai status <session-id>
clai containers
```

### Programmatic (from a code repo)
```js
import { planDAG } from './src/planner.js'
import { createSession } from './src/state.js'

const tasks = await planDAG('your goal here')
const session = createSession('your goal here', tasks)
// then run via CLI: clai run <session.id> --docker --repo .
```

## Sessions

- Stored at `sessions/<sessionId>.json`
- Event logs at `logs/<sessionId>.jsonl`
- Task containers named `clai-<sessionId>-<taskId>`
