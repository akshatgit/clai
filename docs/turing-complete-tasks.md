# Turing-Complete Task Types

Design plan for expanding clai beyond static DAGs into a full workflow engine.

## The Problem with Pure DAGs

A DAG is acyclic by definition — no loops, no branching, no dynamic task creation. To get Turing completeness you need:

- **Conditionals** — branching based on task results
- **Loops** — cycles with a termination condition
- **Dynamic task generation** — tasks that spawn subtasks at runtime

---

## New Task Types

### `execute` (existing default)
Claude implements the task using write_file/run_command/read_file tools.

### `branch`
Evaluates a condition against prior task results and activates one of N downstream paths. All other paths are skipped.

```json
{
  "id": "task_3",
  "type": "branch",
  "condition": "last task result contains 'ALL TESTS PASSED'",
  "on_true": ["task_4_deploy"],
  "on_false": ["task_4_fix"]
}
```

### `for_each`
Expands a list into N parallel child tasks at runtime using a task template. The list can be hardcoded or extracted from a prior task's result.

```json
{
  "id": "task_2",
  "type": "for_each",
  "items": ["auth", "payments", "notifications"],
  "template": "task_impl_template",
  "collect_into": "task_5_merge"
}
```

### `while`
Evaluates a condition after each iteration. Spawns a new iteration task if the condition is true, moves on if false. `max_iterations` prevents infinite loops.

```json
{
  "id": "task_4",
  "type": "while",
  "condition": "test suite is still failing",
  "body": "task_fix_template",
  "max_iterations": 5
}
```

### `barrier`
Blocks until a dynamic set of task IDs all complete. Useful after `for_each` to collect all parallel results before proceeding.

```json
{
  "id": "task_5",
  "type": "barrier",
  "wait_for": ["task_impl_auth", "task_impl_payments", "task_impl_notifications"]
}
```

### `wait`
Pauses execution until an external condition is met — a file exists, a port responds, a URL is healthy. Polls on an interval with a configurable timeout.

```json
{
  "id": "task_6",
  "type": "wait",
  "until": "curl -sf http://localhost:3000/health",
  "timeout_seconds": 60,
  "poll_interval_seconds": 5
}
```

---

## Architecture Changes

### New files

```
src/
  task-types/
    execute.js      existing — Claude implements via tool use
    branch.js       condition eval → activates/skips downstream paths
    for-each.js     expands template into N child tasks at runtime
    while.js        spawns iteration, evaluates condition, loops or exits
    barrier.js      blocks until a dynamic set of tasks complete
    wait.js         polls an external condition until met or timeout

  runtime.js        replaces the simple runner loop in index.js
                    dispatches to task-types/, handles dynamic task insertion
  condition.js      evaluates conditions (Claude / JS expression / shell command)
  template.js       clones task templates with variable substitution
```

### Runtime loop change

The current runner picks ready tasks from a static DAG. The new runtime must be **dynamic** — task types like `for_each` and `while` insert new tasks into `session.dag.tasks` at runtime, and the scheduler re-evaluates the ready set after each insertion.

### Session state extension

```json
{
  "dag": {
    "tasks": { "...": "..." },
    "order": ["..."],
    "dynamic_tasks": []
  }
}
```

`dynamic_tasks` tracks tasks added at runtime (for_each children, while iterations) separately from the planner-generated tasks. Useful for viz and debugging.

### Condition evaluation (`condition.js`)

Three evaluation modes, selected automatically by format:

| Format | Example | Evaluator |
|---|---|---|
| Natural language | `"tests are passing"` | Claude reads prior task results and decides |
| Shell command | `"exit: npm test"` | Run in container, true if exit code 0 |
| JS expression | `"js: result.includes('PASS')"` | Evaluated in Node.js with task result in scope |

---

## Turing Completeness Argument

`while` (unbounded iteration) + `branch` (conditionals) + `execute` (arbitrary computation via Claude + shell) = Turing complete.

`max_iterations` on while loops makes it a **bounded Turing machine** in practice — infinite loops aren't useful in an orchestrator and would exhaust API credits anyway.

---

## Implementation Phases

| Phase | Scope | Key challenge |
|---|---|---|
| 1 | Add `type` field to task schema, refactor runner to dispatch by type | Backwards compatible — default type is `execute` |
| 2 | `branch` + `barrier` | No dynamic task generation, just activation/skipping |
| 3 | `for_each` | Dynamic task insertion + template variable substitution |
| 4 | `while` | Looping with per-task iteration counter + max_iterations guard |
| 5 | `wait` | Polling loop with timeout, runs in container |
| 6 | Update planner prompt | Claude should be able to design DAGs with the new types |

Start with **Phase 1 + 2** — `branch` and `barrier` are immediately useful for real workflows (deploy only if tests pass, wait for all parallel tasks) and don't require the harder dynamic task insertion problem.

---

## Example: Self-healing build pipeline

A real workflow using multiple new task types:

```
task_1 [execute]    scaffold project
task_2 [execute]    write implementation
task_3 [execute]    run tests
task_4 [branch]     did tests pass?
  on_true  → task_5 [execute]   deploy
  on_false → task_6 [while]     fix loop (max 3 iterations)
               body → task_fix [execute]  ask Claude to fix failures
               then → task_3            re-run tests
task_7 [barrier]    wait for task_5 or task_6 to finish
task_8 [execute]    write summary report
```

This pipeline is not expressible as a pure DAG — it requires the `branch` and `while` types.
