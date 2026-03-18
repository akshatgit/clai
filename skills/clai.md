---
name: clai
description: Break down a goal into a task DAG and execute it with clai, or fix bugs with the SWE pipeline
---

Use the clai CLI to plan and execute the user's goal end-to-end.

## Setup (first time only)

Before running any clai command, check if clai is installed and an API key is available:

```bash
which clai || echo "NOT INSTALLED"
echo ${ANTHROPIC_API_KEY:+set} || echo "NO KEY"
```

If clai is not installed:
```bash
git clone https://github.com/akshatgit/clai && cd clai && npm install -g .
```

If no API key is set, ask the user which option they prefer:

**Option A — Anthropic API key** (get one at console.anthropic.com/settings/keys):
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Option B — LiteLLM proxy** (if the user has their own Claude setup):
```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_API_KEY=anything
```

**Option C — Claude Code's own session** (no separate key needed):
Instead of shelling out to clai, implement the goal directly using Claude Code's built-in tools (Read, Write, Bash, Edit). Use clai only for planning guidance — run `clai start "<goal>" --plan-only` to get the task DAG, then execute each task yourself using Claude Code tools.

## General task execution

1. Run `clai start "<goal>" --run` to plan a task DAG and execute it immediately.
   - If the user wants to review before running: `clai start "<goal>"` then `clai run <session-id>`.
2. After execution, run `clai status <session-id>` and report which tasks completed, failed, or were skipped.
3. For any failed tasks, offer to re-run them: `clai run <session-id> --task <task-id>`.
4. To show the task graph: `clai viz <session-id>`.

Key flags for `clai run` / `clai start`:
- `--verbose` — stream Claude's output live
- `--docker` — run each task in its own container
- `--docker --repo .` — mount the current project at /workspace in each container

## SWE mode — fix a bug in a repo

Use `clai swe` when the user wants to fix a bug or issue in an existing codebase.

Pipeline: Localize root cause → Plan surgical fix → Execute with test loop → Reinforce on failure

```bash
clai swe "<issue description>" --repo <path-to-repo>
clai swe "<issue>" --repo . --docker           # run fix tasks in containers
clai swe "<issue>" --repo . --rounds 5         # more reinforcement rounds
clai swe "<issue>" --repo . --plan-only        # inspect localization + plan without executing
clai swe "<issue>" --repo . --verbose          # stream all output live
```

## Multi-agent SWE mode — highest quality fixes

Add `--multi` to enable a panel of specialist agents (all Opus) that check and challenge every stage:

- **Researcher** — extracts key files, functions, error patterns from the issue before searching
- **Overseer** — checks the localizer every 5 tool calls and redirects if off track
- **Reviewer** — validates the localization report before planning
- **Critic** — challenges the fix plan and forces revisions if edge cases are missing
- **Debugger** — interprets test failures and provides targeted fix instructions
- **Verifier** — reviews the final git diff before submission

```bash
clai swe --multi "<issue>" --repo <path>                        # all roles
clai swe --multi --roles researcher,critic "<issue>" --repo .   # specific roles only
```

## Other useful commands

```bash
clai list                                      # list all sessions
clai logs <session-id>                         # event log
clai serve                                     # web UI at http://localhost:4242
clai containers                                # list Docker containers
clai exec <session-id> <task-id>               # shell into a task container
clai accept <session-id> <task-id>             # manually mark a task completed
clai swe-bench run --dataset lite --limit 10   # run SWE-bench evaluation
```
