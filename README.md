# clai

AI-powered task orchestrator. Give it a goal — it plans a DAG of tasks and executes them with Claude.

```
clai start "build a REST API with auth and tests" --run
```

## How it works

1. **Plan** — Claude Opus reads your goal and designs a task DAG (directed acyclic graph) with dependencies, complexity levels, and completion criteria.
2. **Execute** — Tasks run in topological order. Each task gets its own Claude model (Haiku → Sonnet → Opus) based on complexity.
3. **Inspect** — Sessions are persisted. Resume, re-run failed tasks, or visualize the DAG at any time.

## Install

```bash
git clone https://github.com/akshatgit/clai
cd clai
npm install -g .
export ANTHROPIC_API_KEY=sk-...
```

### Claude Code skill (optional)

To invoke clai directly inside Claude Code with `/clai`:

```bash
mkdir -p ~/.claude/skills
cp skills/clai.md ~/.claude/skills/clai.md
```

Then in any Claude Code session:

```
/clai build a REST API with auth and tests
```

## Usage

```bash
# Plan a session (and optionally run it immediately)
clai start "your goal here"
clai start "your goal here" --run

# Run a session
clai run <session-id>
clai run <session-id> --verbose          # stream Claude's output live
clai run <session-id> --docker           # run each task in its own container
clai run <session-id> --docker --repo .  # mount your project at /workspace

# Re-run a single task
clai run <session-id> --task task_3

# Check status
clai status <session-id>
clai status <session-id> --result task_2  # print full task output

# List all sessions
clai list

# Visualize the DAG
clai viz <session-id>           # terminal (layered view)
clai viz <session-id> --html    # interactive Mermaid chart in browser

# View event logs
clai logs <session-id>
clai logs <session-id> --raw    # raw JSONL

# Web UI (all sessions + DAG viewer)
clai serve
clai serve --port 8080

# Docker containers
clai containers

# Exec into a running task container
clai exec <session-id> <task-id>

# Manually mark a task as completed (then run downstream tasks)
clai accept <session-id> <task-id>
clai accept <session-id> <task-id> --message "fixed schema manually"
```

## Task DAG

Each task has:

| Field | Description |
|---|---|
| `id` | Unique ID (`task_1`, `task_2`, …) |
| `title` | Short title (≤60 chars) |
| `description` | Detailed implementation spec |
| `dependencies` | IDs of tasks that must complete first |
| `complexity` | `low` / `medium` / `high` → controls which Claude model runs it |
| `docker_image` | Container image (e.g. `node:22-alpine`) |
| `completion_criteria` | Verifiable conditions for success |
| `tests` | Shell commands to validate output |

## Model mapping

| Complexity | Model | When |
|---|---|---|
| `low` | Haiku 4.5 | Boilerplate, config, file edits |
| `medium` | Sonnet 4.6 | Logic, integration, refactoring |
| `high` | Opus 4.6 | Architecture, algorithms, critical decisions |

## Visualization

Three ways to inspect a session's task graph:

**Terminal** — layered ASCII view, works over SSH:
```bash
clai viz <session-id>
```

**HTML** — generates a Mermaid flowchart and opens it in the browser. Nodes are colour-coded by status (pending/running/completed/failed). Each node expands to show the full task result:
```bash
clai viz <session-id> --html
```

**Web server** — live dashboard listing all sessions. Click any session to see its interactive DAG. Refresh to see status updates as tasks run:
```bash
clai serve              # http://localhost:4242
clai serve --port 8080
```

To view remotely (e.g. clai running on a server):
```bash
ssh -L 4242:localhost:4242 user@server
# then open http://localhost:4242
```

## Sessions

- State: `sessions/<id>.json`
- Event log: `logs/<id>.jsonl`
- Docker containers: `clai-<session-id>-<task-id>`

## Architecture

```
src/
  index.js        CLI (commander) — start, run, status, list, logs, viz, serve, containers, exec, accept
  planner.js      Claude Opus plans the task DAG (structured JSON output)
  executor.js     Claude executes tasks via tool use (write_file, run_command, read_file)
  docker.js       Docker container runner — RO base mount + RW overlays per output path
  worker.js       In-container task executor (called via docker exec)
  state.js        Session persistence (sessions/*.json)
  dag.js          Topological sort, ready-task selection, cycle detection
  hooks.js        Event emission to JSONL logs
  commands/
    exec.js       Handler for clai exec
    accept.js     Handler for clai accept
```
