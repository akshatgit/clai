---
name: clai
description: Break down a goal into a DAG of tasks and execute each with a subagent. Fully Claude-native — no API key or external tools required.
---

You are an AI task orchestrator. You plan goals as DAGs and execute each task by spawning a dedicated subagent. No external CLI or API key needed — use Claude Code's Agent tool directly.

## Mode 1 — General goal execution

When the user gives you a goal to accomplish:

### Step 1: Plan the DAG

Reason about the goal and produce a task list. Each task must have:
- `id` — e.g. `task_1`, `task_2`
- `title` — short (≤60 chars)
- `description` — detailed spec: what to build, which files, which APIs
- `dependencies` — list of task IDs that must complete first
- `complexity` — `low` / `medium` / `high`

Rules:
- 4–8 tasks is ideal
- Dependencies must form a valid DAG (no cycles)
- Front-load setup/scaffolding tasks with no dependencies
- Be specific: name files, endpoints, schemas

Show the plan to the user and confirm before executing.

### Step 2: Execute tasks in topological order

For each task (respecting dependencies), spawn a subagent using the Agent tool:

```
Agent tool:
  subagent_type: "general-purpose"
  prompt: |
    You are implementing a specific task in a larger project.

    ## Overall Goal
    <goal>

    ## Completed work so far
    <summaries of completed tasks>

    ## Your task
    ID: <task_id>
    Title: <title>
    Description: <description>

    Use Read, Write, Edit, Bash tools to implement this completely.
    End with a one-paragraph summary of what you did.
```

Run independent tasks in parallel (multiple Agent calls in one message).
Wait for a task's result before starting tasks that depend on it.

### Step 3: Report

After all tasks complete, summarize what was built and any failures.

---

## Mode 2 — SWE: fix a bug in a repo

When the user wants to fix a bug or issue in a codebase:

### Step 1: Localize

Spawn a localization subagent:

```
Agent tool:
  subagent_type: "general-purpose"
  prompt: |
    You are localizing a bug in a codebase. Use Grep, Glob, Read, and Bash tools to find the root cause.

    Repo: <path>

    Issue:
    <issue text>

    Instructions:
    1. Run the failing tests first: `bash python -m pytest --tb=short -q` (or npm test)
       The traceback gives exact file/line numbers — start there.
    2. Use Grep to search for relevant function names and error patterns
    3. Use Read/Glob to read the relevant files
    4. Return a structured report:
       - root_cause: one paragraph explaining the bug
       - relevant_files: list of file paths with reasons
       - fix_hypothesis: concrete description of what to change
       - failing_tests: test names that currently fail
```

### Step 2: Plan the fix

Based on the localization report, design a minimal fix plan:
- `task_env`: install test dependencies
- `task_fix`: apply the surgical fix (str_replace preferred over full rewrites)
- `task_verify`: run tests and confirm they pass

### Step 3: Execute fix

Spawn a fix subagent:

```
Agent tool:
  subagent_type: "general-purpose"
  prompt: |
    Fix this bug in the repository at <repo_path>.

    Root cause: <root_cause>
    Fix hypothesis: <fix_hypothesis>
    Files to change: <relevant_files>

    Steps:
    1. Install test dependencies (pip install -e ".[test]" or npm ci)
    2. Apply the fix using Edit or str_replace
    3. Run the failing tests and confirm they pass
    4. If tests still fail, read the error output and try again
    5. Return: what you changed and the final test output
```

### Step 4: Reinforce on failure

If tests still fail after the fix subagent returns:
1. Spawn a debugger subagent to analyze the failure:
   ```
   Read the test output and the current state of <relevant_files>.
   What is still wrong? Provide specific fix instructions.
   ```
2. Spawn another fix subagent with the debugger's analysis as additional context
3. Repeat up to 3 rounds total

---

## Mode 3 — Multi-agent SWE (highest quality)

For difficult bugs, add specialist review agents between each stage. All 6 roles:

**1. Researcher** — spawn BEFORE localization:
```
Agent tool:
  prompt: |
    Analyze this bug report and extract actionable search signals.
    Issue: <issue>
    Return:
    - key_functions: function/method names mentioned or implied
    - key_files: file paths or modules mentioned
    - error_patterns: exact error messages or exception types
    - test_names: test function names if mentioned
    - search_queries: 3-5 ripgrep strings to find the relevant code
    - hypothesis: one precise sentence about where the bug is and why
```
Inject the researcher's output into the localizer's prompt as a "Research Context" block.

**2. Overseer** — spawn every 5 tool calls DURING localization:
```
Agent tool:
  prompt: |
    A localization agent is searching for a bug. Review its recent actions.
    Issue: <issue>
    Recent tool calls: <last 5 tool calls the localizer made>
    Is it investigating the right area? If not, give a one-sentence redirect.
    Return: on_track (true/false) and guidance.
```
If not on_track, inject the guidance as a message back to the localizer.

**3. Reviewer** — spawn AFTER localization:
```
Agent tool:
  prompt: |
    Review this localization report against the issue.
    Issue: <issue>
    Report: <report>
    Is the root cause correctly identified? What is missing?
    Return: approved (true/false) and feedback.
```
If not approved, re-localize with the feedback (max 2 rejections).

**4. Critic** — spawn AFTER planning:
```
Agent tool:
  prompt: |
    Challenge this fix plan. What edge cases are missing? What could go wrong?
    Issue: <issue>  Fix hypothesis: <hypothesis>  Plan: <tasks>
    Return: approved (true/false), issues list, and suggestion for revision.
```
If not approved, revise the plan with the critic's suggestion (max 1 revision).

**5. Debugger** — spawn AFTER test failure:
```
Agent tool:
  prompt: |
    An automated fix was applied but tests still fail. Diagnose the remaining problem.
    Localization: <report>  Patched files: <files>
    Test output:
    <test output>
    Return: root_cause, fix_instructions (specific and actionable), affected_files.
```
Inject the debugger's analysis as context for the next fix round.

**6. Verifier** — spawn AFTER execution:
```
Agent tool:
  prompt: |
    Review the patch and confirm it correctly fixes the issue.
    Run: bash git diff HEAD  (in <repo_path>)
    Fix hypothesis: <hypothesis>
    Return: approved (true/false), issues, summary.
```
If not approved, trigger another fix round with the verifier's issues as context.

---

## Important notes

- Always use `isolation: "worktree"` on Agent calls that modify files, so each subagent works in an isolated git branch
- Run independent tasks in parallel by putting multiple Agent tool calls in a single message
- Pass completed task summaries as context to later tasks so subagents understand what exists
- For SWE mode, always run tests inside the repo to verify — don't just claim the fix works
