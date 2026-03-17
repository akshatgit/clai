// src/swe-bench/goal-formatter.js
// Converts a SWE-bench instance into a well-structured clai goal string.

/**
 * Format a SWE-bench instance as a clai goal.
 *
 * @param {{ instance_id: string, repo: string, problem_statement: string }} instance
 * @returns {string}
 */
export function formatGoal(instance) {
  return `Fix this GitHub issue in the ${instance.repo} codebase:

${instance.problem_statement}

The repository is already checked out at the relevant commit.
Make the minimum changes needed to resolve the issue.
Do not modify test files.`
}
