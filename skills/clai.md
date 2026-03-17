---
name: clai
description: Break down a goal into a task DAG and execute it with clai
---

Use the clai CLI to plan and execute the user's goal end-to-end.

Steps:
1. Run `clai start "<goal>" --run` to plan a task DAG and execute it immediately.
   - If the user wants to review before running: `clai start "<goal>"` then `clai run <session-id>`.
2. After execution, run `clai status <session-id>` and report which tasks completed, failed, or were skipped.
3. For any failed tasks, offer to re-run them: `clai run <session-id> --task <task-id>`.
4. To show the task graph: `clai viz <session-id>`.

Flags to know:
- `--verbose` — stream Claude's output live
- `--docker` — run each task in its own container
- `--docker --repo .` — mount the current project at /workspace in each container
