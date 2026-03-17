/**
 * Task template engine — clones task specs with variable substitution.
 * Used by for_each and while to generate concrete tasks from templates.
 */

/**
 * Deep-clone a task template with a new ID and variable substitution.
 * Replaces {{key}} placeholders in title, description, completion_criteria, tests.
 *
 * @param {object} templateTask  - Source task object
 * @param {string} newId         - ID for the cloned task
 * @param {object} variables     - Map of placeholder keys to replacement values
 * @returns {object}             - New task object (does not modify templateTask)
 */
export function cloneTask(templateTask, newId, variables = {}) {
  const clone = JSON.parse(JSON.stringify(templateTask))
  clone.id = newId

  function substitute(str) {
    if (typeof str !== 'string') return str
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) =>
      key in variables ? String(variables[key]) : `{{${key}}}`
    )
  }

  clone.title = substitute(clone.title)
  clone.description = substitute(clone.description)
  clone.completion_criteria = (clone.completion_criteria ?? []).map(substitute)
  clone.tests = (clone.tests ?? []).map(substitute)

  // Reset runtime state
  clone.status = 'pending'
  clone.result = null
  clone.started_at = null
  clone.completed_at = null
  clone.attempts = 0
  clone.iteration_count = 0

  return clone
}

/**
 * Resolve a for_each items spec into a concrete array.
 * Accepts:
 *   - A plain array (returned as-is)
 *   - "result_of:<taskId>" — parse the result of a completed task:
 *       tries JSON.parse first, then splits on newlines
 *
 * @param {string|string[]} itemsSpec
 * @param {object} session
 * @returns {string[]}
 */
export function resolveItems(itemsSpec, session) {
  if (Array.isArray(itemsSpec)) return itemsSpec

  if (typeof itemsSpec === 'string' && itemsSpec.startsWith('result_of:')) {
    const taskId = itemsSpec.slice('result_of:'.length).trim()
    const task = session.dag.tasks[taskId]
    if (!task?.result) throw new Error(`resolveItems: task "${taskId}" has no result`)

    try {
      const parsed = JSON.parse(task.result)
      if (Array.isArray(parsed)) return parsed
    } catch { /* fall through to line split */ }

    return task.result.split('\n').map(l => l.trim()).filter(Boolean)
  }

  throw new Error(`resolveItems: cannot resolve items spec: ${JSON.stringify(itemsSpec)}`)
}
