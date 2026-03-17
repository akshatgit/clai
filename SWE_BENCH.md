# SWE-bench Integration Plan for clai

## Overview

SWE-bench evaluates agents on their ability to resolve real GitHub issues by producing a unified diff patch. This document describes what needs to be built to run clai against SWE-bench Lite or Verified.

## How SWE-bench Works

1. Each **instance** has: `instance_id`, `repo`, `base_commit`, `problem_statement` (the issue text), and test metadata.
2. Your agent receives the repo at `base_commit` and the issue text.
3. The agent produces a **unified diff patch** (`git diff HEAD`).
4. SWE-bench applies the patch and runs the repo's test suite to check if the issue is resolved.
5. Results are collected in a `predictions.json` file and evaluated with `sb-cli` or the local harness.

## What Needs to Be Built

### 1. `src/swe-bench/runner.js` — Main driver

A Node.js script that:
- Accepts `--dataset` (lite | verified), `--limit N`, `--instance <id>`, `--output <path>`
- Loads SWE-bench instances from the Hugging Face dataset via HTTP (or local JSON)
- For each instance:
  1. Clones the repo at `base_commit` into a temp dir
  2. Formats the issue as a clai goal: `"Fix GitHub issue: <problem_statement>"`
  3. Calls `clai start "<goal>" --run --docker --repo <tempdir>`
  4. Waits for the session to complete
  5. Runs `git diff HEAD` in the temp dir to capture the patch
  6. Appends `{ instance_id, model_patch, model_name_or_path: "clai" }` to predictions
- Writes final `predictions.json`
- Cleans up temp dirs

### 2. `src/swe-bench/fetch-instances.js` — Dataset loader

Fetches SWE-bench instances from Hugging Face:
- `princeton-nlp/SWE-bench_Lite` — 300 instances (recommended for testing)
- `princeton-nlp/SWE-bench_Verified` — 500 instances

Returns an array of `{ instance_id, repo, base_commit, problem_statement }` objects.

Uses the Hugging Face datasets HTTP API (no Python/datasets library needed):
```
https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Lite&config=default&split=test&offset=0&limit=100
```

### 3. `src/swe-bench/extract-patch.js` — Patch extractor

After clai finishes, runs `git diff HEAD` inside the repo dir and returns the unified diff string. Also handles the case where clai's Docker containers wrote changes via bind mounts.

### 4. `src/swe-bench/goal-formatter.js` — Issue → clai goal

Converts a SWE-bench instance into a well-structured clai goal:

```
Fix this GitHub issue in the <repo> codebase:

<problem_statement>

The repository is already checked out at the relevant commit.
Make the minimum changes needed to resolve the issue.
Do not modify test files.
```

### 5. New CLI command: `clai swe-bench`

Adds a `swe-bench` subcommand to `src/index.js`:

```bash
clai swe-bench run --dataset lite --limit 10 --output ./predictions.json
clai swe-bench run --instance django__django-1234 --output ./predictions.json
clai swe-bench status ./predictions.json   # show how many instances completed
```

### 6. Patch capture: `--patch-output` flag on `clai run`

Adds `--patch-output <file>` to the `run` command:
- After all tasks complete, runs `git diff HEAD` in the `--repo` directory
- Writes the diff to `<file>`
- This lets the SWE-bench runner retrieve the patch cleanly without coupling to clai internals

## File Structure

```
src/
  swe-bench/
    runner.js          # Main orchestration loop
    fetch-instances.js # Hugging Face dataset loader
    extract-patch.js   # git diff after clai run
    goal-formatter.js  # issue → clai goal string
```

## Predictions Format

```json
[
  {
    "instance_id": "django__django-11099",
    "model_patch": "diff --git a/django/db/models/sql/compiler.py ...",
    "model_name_or_path": "clai"
  }
]
```

## Evaluation

After generating `predictions.json`:

```bash
# Option 1: sb-cli (cloud, recommended)
pip install sb-cli
sb-cli submit --dataset swe-bench_lite --split test --predictions ./predictions.json

# Option 2: Local evaluation
pip install swebench
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path ./predictions.json \
  --max_workers 4 \
  --run_id clai-eval
```

## Implementation Order

1. `fetch-instances.js` — dataset loader (no deps)
2. `goal-formatter.js` — pure string formatting (no deps)
3. `extract-patch.js` — git diff utility (no deps)
4. `runner.js` — ties it all together
5. `--patch-output` flag in `src/index.js`
6. `clai swe-bench` subcommand in `src/index.js`

## Key Constraints

- **No Python required** — everything runs in Node.js; Docker handles the per-task environments
- **Parallel runs**: runner.js should support `--concurrency N` (default 1) to run multiple instances simultaneously
- **Timeout per instance**: default 10 minutes; configurable via `--timeout`
- **Resume**: skip instances already present in output predictions.json
- **Error handling**: if clai run fails or produces empty patch, record `model_patch: ""` and continue

## Testing

```bash
# Quick smoke test: one instance
clai swe-bench run --instance astropy__astropy-12907 --output /tmp/test-pred.json

# Check the patch
cat /tmp/test-pred.json | jq '.[0].model_patch'
```
