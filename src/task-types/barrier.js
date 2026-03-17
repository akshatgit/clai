/**
 * barrier task type — blocks until all wait_for tasks complete.
 *
 * Schema fields:
 *   wait_for  string[]  task IDs that must all complete before the barrier passes
 *
 * Returns the sentinel '__barrier_pending__' if not all tasks are done yet.
 * The runner handles this sentinel by resetting the task to pending and retrying.
 */

export const BARRIER_PENDING = '__barrier_pending__'

export async function executeBarrier(session, task, _onChunk) {
  const waitFor = task.wait_for ?? []

  // If wait_for is empty the barrier passes immediately
  if (waitFor.length === 0) {
    return 'barrier: no tasks to wait for — passed immediately.'
  }

  const statuses = waitFor.map(id => ({
    id,
    status: session.dag.tasks[id]?.status ?? 'unknown',
  }))

  const allFailed = statuses.every(s => s.status === 'failed' || s.status === 'skipped')
  if (allFailed) {
    throw new Error(`barrier: all wait_for tasks failed or were skipped: [${waitFor.join(', ')}]`)
  }

  const allDone = statuses.every(s => s.status === 'completed')
  if (allDone) {
    return `barrier: all ${waitFor.length} tasks completed: [${waitFor.join(', ')}]`
  }

  // Not ready yet — signal the runner to reset and retry
  const pending = statuses.filter(s => s.status !== 'completed').map(s => `${s.id}(${s.status})`)
  if (_onChunk) _onChunk(`barrier: waiting for [${pending.join(', ')}]…\n`)
  return BARRIER_PENDING
}
