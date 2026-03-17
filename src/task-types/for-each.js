/**
 * for_each task type — expands a list into N parallel child tasks at runtime.
 *
 * Schema fields:
 *   items        string[] | "result_of:<taskId>"   items to iterate over
 *   template     string   task ID of the template task to clone per item
 *   collect_into string   (optional) task ID of a downstream barrier to wire up
 */

import { cloneTask, resolveItems } from '../template.js'
import { insertDynamicTasks } from '../state.js'

export async function executeForEach(session, task, _onChunk) {
  const items = resolveItems(task.items, session)

  const templateTask = session.dag.tasks[task.template]
  if (!templateTask) {
    throw new Error(`for_each: template task "${task.template}" not found`)
  }

  // Generate one concrete task per item
  const newTasks = items.map((item, i) => {
    const newId = `${task.template}_${task.id}_${i}`
    const clone = cloneTask(templateTask, newId, { item, index: i, i })
    clone.dependencies = [task.id]
    return clone
  })

  const newIds = newTasks.map(t => t.id)

  // Wire up the collect_into task if present
  if (task.collect_into) {
    const collector = session.dag.tasks[task.collect_into]
    if (collector) {
      // Add generated IDs to its dependencies and wait_for
      collector.dependencies = [...new Set([...collector.dependencies, ...newIds])]
      if (collector.type === 'barrier') {
        collector.wait_for = [...new Set([...(collector.wait_for ?? []), ...newIds])]
      }
    }
  }

  // Mark template as skipped — it was a spec, not directly executable
  session.dag.tasks[task.template].status = 'skipped'

  // Insert the new tasks and recompute order
  insertDynamicTasks(session, newTasks)

  if (_onChunk) _onChunk(`for_each: inserted ${newTasks.length} tasks: [${newIds.join(', ')}]\n`)
  return `for_each: expanded "${task.template}" into ${newTasks.length} tasks over items: [${items.map(String).join(', ')}]`
}
