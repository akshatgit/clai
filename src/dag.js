// DAG utilities: topological sort, cycle detection, ready-task query

/**
 * Returns task IDs in topological order (dependencies before dependents).
 * Throws if a circular dependency is detected.
 * Template tasks (used by for_each/while as specs) are included in the sort
 * but will be skipped by the runner.
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
 * Considers both static (session.dag.order) and dynamic tasks.
 */
export function getReadyTasks(tasks, order) {
  return order.filter(id => {
    const task = tasks[id]
    if (!task || task.status !== 'pending') return false
    return task.dependencies.every(dep => tasks[dep]?.status === 'completed')
  })
}

/**
 * Returns IDs of tasks whose status should be 'skipped' because a dependency failed.
 * barrier tasks use a special rule: only skipped if ALL wait_for tasks failed/skipped.
 */
export function getBlockedTasks(tasks) {
  // Build a set of body-template IDs whose parent while task is skipped/failed.
  // These templates should never run standalone — they only run as cloned iterations.
  const blockedBodies = new Set()
  for (const t of Object.values(tasks)) {
    if (t.type === 'while' && t.body && (t.status === 'skipped' || t.status === 'failed')) {
      blockedBodies.add(t.body)
    }
  }

  return Object.keys(tasks).filter(id => {
    const task = tasks[id]
    if (task.status !== 'pending') return false

    if (blockedBodies.has(id)) return true

    if (task.type === 'barrier') {
      const waitFor = task.wait_for?.length ? task.wait_for : task.dependencies
      return waitFor.length > 0 && waitFor.every(dep => {
        const s = tasks[dep]?.status
        return s === 'failed' || s === 'skipped'
      })
    }

    return task.dependencies.some(dep => {
      const s = tasks[dep]?.status
      return s === 'failed' || s === 'skipped'
    })
  })
}

/**
 * Validate cross-references introduced by control-flow task types.
 * Called from createSession and insertDynamicTasks.
 * @param {object} tasks
 */
export function validateTaskReferences(tasks) {
  for (const [id, task] of Object.entries(tasks)) {
    const type = task.type ?? 'execute'

    if (type === 'branch') {
      for (const ref of [...(task.on_true ?? []), ...(task.on_false ?? [])]) {
        if (!tasks[ref]) throw new Error(`branch "${id}": unknown task ref "${ref}"`)
      }
    }

    if (type === 'for_each') {
      if (task.template && !tasks[task.template]) {
        throw new Error(`for_each "${id}": template task "${task.template}" not found`)
      }
      if (task.collect_into && !tasks[task.collect_into]) {
        throw new Error(`for_each "${id}": collect_into task "${task.collect_into}" not found`)
      }
    }

    if (type === 'while') {
      if (task.body && !tasks[task.body]) {
        throw new Error(`while "${id}": body template "${task.body}" not found`)
      }
    }
  }
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
