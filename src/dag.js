// DAG utilities: topological sort, cycle detection, ready-task query

/**
 * Returns task IDs in topological order (dependencies before dependents).
 * Throws if a circular dependency is detected.
 */
export function topologicalSort(tasks) {
  const visited = new Set()
  const visiting = new Set()
  const order = []

  function visit(id) {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Circular dependency at task: ${id}`)

    visiting.add(id)
    const task = tasks[id]
    if (!task) throw new Error(`Unknown task referenced in dependencies: ${id}`)

    for (const dep of task.dependencies) {
      visit(dep)
    }

    visiting.delete(id)
    visited.add(id)
    order.push(id)
  }

  for (const id of Object.keys(tasks)) {
    visit(id)
  }

  return order
}

/**
 * Returns IDs of tasks that are pending and have all dependencies completed.
 */
export function getReadyTasks(tasks, order) {
  return order.filter(id => {
    const task = tasks[id]
    if (task.status !== 'pending') return false
    return task.dependencies.every(dep => tasks[dep]?.status === 'completed')
  })
}

/**
 * Returns IDs of tasks whose status should be 'skipped' because a dependency failed.
 */
export function getBlockedTasks(tasks) {
  return Object.keys(tasks).filter(id => {
    const task = tasks[id]
    if (task.status !== 'pending') return false
    return task.dependencies.some(dep => {
      const depTask = tasks[dep]
      return depTask?.status === 'failed' || depTask?.status === 'skipped'
    })
  })
}

/**
 * Compute overall session progress stats.
 */
export function getStats(tasks) {
  const all = Object.values(tasks)
  return {
    total: all.length,
    completed: all.filter(t => t.status === 'completed').length,
    failed: all.filter(t => t.status === 'failed').length,
    skipped: all.filter(t => t.status === 'skipped').length,
    running: all.filter(t => t.status === 'running').length,
    pending: all.filter(t => t.status === 'pending').length,
  }
}
