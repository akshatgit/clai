// src/swe-bench/extract-patch.js
// Runs `git diff HEAD` in a given directory and returns the unified diff string.
// Used after clai finishes so Docker bind-mount changes are captured.

import { execSync } from 'child_process'

/**
 * Run `git diff HEAD` in repoDir and return the unified diff string.
 * Returns an empty string if there are no changes or if git fails.
 *
 * @param {string} repoDir  Absolute path to the git repository
 * @returns {string}
 */
export function extractPatch(repoDir) {
  try {
    const diff = execSync('git diff HEAD', {
      cwd: repoDir,
      encoding: 'utf8',
      // Allow large diffs — SWE-bench patches can be substantial
      maxBuffer: 10 * 1024 * 1024,
    })
    return diff ?? ''
  } catch (err) {
    // git may exit non-zero in unusual states; return empty patch on error
    return ''
  }
}
