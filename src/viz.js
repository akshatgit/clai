/**
 * Terminal DAG visualizer — shared between `clai viz` and `clai swe-bench run --viz`.
 */

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  red:     '\x1b[31m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
}

const icon = {
  pending:   `${c.gray}○${c.reset}`,
  running:   `${c.cyan}◉${c.reset}`,
  completed: `${c.green}✓${c.reset}`,
  failed:    `${c.red}✗${c.reset}`,
  skipped:   `${c.yellow}⊘${c.reset}`,
}

function computeLevels(tasks, order) {
  const levels = {}
  for (const id of order) {
    const deps = tasks[id].dependencies
    levels[id] = deps.length === 0
      ? 0
      : Math.max(...deps.map(d => levels[d] ?? 0)) + 1
  }
  return levels
}

/**
 * Print a layered DAG view for a session to stdout.
 * @param {object} session
 * @param {object} opts
 * @param {string} opts.label   - Optional heading prefix (e.g. "Round 1/3")
 * @param {boolean} opts.hint   - Whether to print the `clai viz --html` hint (default true)
 */
export function terminalViz(session, { label = '', hint = true } = {}) {
  const { tasks, order } = session.dag
  const levels = computeLevels(tasks, order)
  const maxLevel = Math.max(...Object.values(levels))

  const heading = label
    ? `${label} — ${session.goal.slice(0, 60)}`
    : `DAG: ${session.goal.slice(0, 70)}`
  console.log(`\n${c.bold}${c.blue}══ ${heading} ══${c.reset}`)
  console.log(`${c.dim}   session: ${session.id}${c.reset}`)

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const ids = order.filter(id => levels[id] === lvl)
    const levelLabel = lvl === 0 ? 'roots' : `level ${lvl}`
    console.log(`\n${c.bold}${c.blue}Level ${lvl}${c.reset}  ${c.dim}${levelLabel}${c.reset}`)
    console.log(`  ${'─'.repeat(52)}`)

    for (const id of ids) {
      const t = tasks[id]
      const deps = t.dependencies.length > 0
        ? `  ${c.gray}← [${t.dependencies.join(', ')}]${c.reset}`
        : ''
      const cx = t.complexity === 'high' ? c.red : t.complexity === 'medium' ? c.yellow : c.green
      console.log(`  ${icon[t.status] ?? icon.pending} ${c.bold}${id}${c.reset}  ${t.title}  ${cx}[${t.complexity}]${c.reset}${deps}`)
      console.log(`     ${c.dim}${t.description.slice(0, 80)}${t.description.length > 80 ? '…' : ''}${c.reset}`)
    }
  }

  console.log()
  if (hint) {
    console.log(`${c.dim}   → clai viz ${session.id} --html  (interactive graph)${c.reset}`)
  }
}
