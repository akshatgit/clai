```
  ██████╗██╗      █████╗ ██╗
 ██╔════╝██║     ██╔══██╗██║
 ██║     ██║     ███████║██║
 ██║     ██║     ██╔══██║██║
 ╚██████╗███████╗██║  ██║██║
  ╚═════╝╚══════╝╚═╝  ╚═╝╚═╝
```

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

## SWE mode — automated bug fixing

`clai swe` is a self-contained agentic loop for fixing bugs in an existing repo:

1. **Localize** — Claude navigates the repo (file tree, code search, test runs) and produces a `LocalizationReport` pinpointing root-cause files and functions.
2. **Plan** — `planSWE()` designs a minimal 3-phase fix: apply patch → test-fix while-loop → summary.
3. **Execute** — The fix runs with full reinforcement: if tests still fail, Claude re-localizes with context from the previous attempt and tries again (up to `--rounds` times).

```bash
# Fix a bug (up to 3 reinforcement rounds by default)
clai swe "TypeError in auth middleware" --repo ./my-app

# Run in Docker containers
clai swe "auth middleware fails on expired tokens" --repo ./app --docker

# More rounds for stubborn bugs
clai swe "flaky pagination query" --repo ./api --rounds 5

# Inspect localization + plan without executing
clai swe "null pointer in user service" --repo ./app --plan-only

# Stream Claude's reasoning live
clai swe "broken CSV export" --repo ./app --verbose
```

### Multi-agent mode

Add `--multi` to enable a full panel of specialist agents — all running Opus — that check and challenge each stage of the pipeline:

| Role | When | Does |
|---|---|---|
| **Researcher** | Before localization | Extracts key functions, files, error patterns, and a search hypothesis from the issue |
| **Overseer** | Every 5 tool calls during localization | Checks if the localizer is on the right track; injects a redirect if not |
| **Reviewer** | After localization | Validates the localization report before planning; rejects and re-localizes if incomplete |
| **Critic** | After planning | Challenges the fix plan; forces a revision if edge cases are missing |
| **Debugger** | After test failure | Reads the traceback, identifies root cause, provides targeted fix instructions for the next round |
| **Verifier** | After execution | Reviews the `git diff` patch before final submission |

```bash
# All roles enabled (Researcher → Overseer → Reviewer → Critic → Debugger → Verifier)
clai swe --multi "separability_matrix returns wrong result for nested CompoundModels" --repo ./astropy

# Enable specific roles only
clai swe --multi --roles researcher,critic,debugger_ "bug description" --repo ./my-repo

# Combine with other flags
clai swe --multi --docker --rounds 5 --verbose "issue text" --repo ./app
```

#### Custom model backend (LiteLLM / proxy)

Point clai at any OpenAI-compatible proxy:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000   # LiteLLM or other proxy
export ANTHROPIC_API_KEY=anything                 # required by SDK, value ignored by proxy
clai swe --multi "bug description" --repo ./app
```

## Turing-complete task types

In addition to plain tasks, the planner can emit control-flow task types that make DAGs Turing-complete at runtime:

| Type | Description |
|---|---|
| `branch` | Evaluates a condition; activates `on_true` or `on_false` dependency paths |
| `for_each` | Expands a list into N parallel child tasks at runtime |
| `while` | Loops by spawning body + next-check task chains (DAG stays acyclic) |
| `barrier` | Blocks until all `wait_for` tasks complete |
| `wait` | Polls a shell command until exit code 0 or timeout |

These compose with regular tasks and with each other. All new task types are backwards compatible — sessions without them work exactly as before.

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
  index.js          CLI (commander) — start, run, status, list, logs, viz, serve, swe, swe-bench
  planner.js        Claude Opus plans the task DAG (structured JSON output)
  executor.js       Claude executes tasks via tool use (write_file, run_command, read_file, str_replace)
  localize.js       Agentic repo navigator — pinpoints root-cause files/functions
  reinforce.js      Outer reinforcement loop — re-localizes on failure with prior context
  reinforce-multi.js  Multi-agent reinforcement loop — adds role hooks at every pipeline stage
  roles.js          All six specialist roles (Researcher, Overseer, Reviewer, Critic, Debugger, Verifier)
  runner.js         Dispatches tasks by type (plain, branch, for_each, while, barrier, wait)
  client.js         Anthropic SDK wrapper with retry-after-aware rate limit handling
  docker.js         Docker container runner — host-side executor with docker exec proxy
  condition.js      Evaluates shell / JS expression / natural language conditions
  template.js       cloneTask with {{variable}} substitution, resolveItems
  state.js          Session persistence (sessions/*.json)
  dag.js            Topological sort, ready-task selection, cycle detection, barrier-awareness
  hooks.js          Event emission to JSONL logs
  viz.js            Terminal + HTML DAG visualizer
  task-types/
    branch.js       branch task handler
    for-each.js     for_each task handler
    while.js        while task handler
    barrier.js      barrier task handler
    wait.js         wait task handler
  commands/
    exec.js         Handler for clai exec
    accept.js       Handler for clai accept
```
