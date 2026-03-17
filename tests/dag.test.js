import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { topologicalSort, getReadyTasks, getBlockedTasks, getStats } from '../src/dag.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function t(id, { deps = [], status = 'pending' } = {}) {
  return [id, { id, title: id, description: '', dependencies: deps, status, complexity: 'low' }]
}
function tasks(...specs) {
  return Object.fromEntries(specs.map(([id, opts]) => t(id, opts)))
}

// ─── topologicalSort ──────────────────────────────────────────────────────────

describe('topologicalSort', () => {
  it('returns [] for empty input', () => {
    assert.deepEqual(topologicalSort({}), [])
  })

  it('returns single node', () => {
    assert.deepEqual(topologicalSort(tasks(['a'])), ['a'])
  })

  it('linear chain: a→b→c comes out in order', () => {
    const g = tasks(['a'], ['b', { deps: ['a'] }], ['c', { deps: ['b'] }])
    assert.deepEqual(topologicalSort(g), ['a', 'b', 'c'])
  })

  it('root always before its direct dependent', () => {
    const g = tasks(['a'], ['b', { deps: ['a'] }])
    const order = topologicalSort(g)
    assert.ok(order.indexOf('a') < order.indexOf('b'))
  })

  it('two independent roots, both present', () => {
    const g = tasks(['a'], ['b'])
    const order = topologicalSort(g)
    assert.equal(order.length, 2)
    assert.ok(order.includes('a'))
    assert.ok(order.includes('b'))
  })

  it('diamond: a→b, a→c, b,c→d — a first, d last', () => {
    const g = tasks(
      ['a'],
      ['b', { deps: ['a'] }],
      ['c', { deps: ['a'] }],
      ['d', { deps: ['b', 'c'] }],
    )
    const order = topologicalSort(g)
    assert.ok(order.indexOf('a') < order.indexOf('b'))
    assert.ok(order.indexOf('a') < order.indexOf('c'))
    assert.ok(order.indexOf('b') < order.indexOf('d'))
    assert.ok(order.indexOf('c') < order.indexOf('d'))
    assert.equal(order.length, 4)
  })

  it('wide fan-in: a,b,c,d all point to z', () => {
    const g = tasks(['a'], ['b'], ['c'], ['d'], ['z', { deps: ['a', 'b', 'c', 'd'] }])
    const order = topologicalSort(g)
    const zi = order.indexOf('z')
    assert.ok(order.indexOf('a') < zi)
    assert.ok(order.indexOf('b') < zi)
    assert.ok(order.indexOf('c') < zi)
    assert.ok(order.indexOf('d') < zi)
  })

  it('all nodes appear in output', () => {
    const g = tasks(['a'], ['b', { deps: ['a'] }], ['c', { deps: ['a'] }])
    const order = topologicalSort(g)
    assert.equal(order.length, 3)
  })

  it('throws on direct cycle (a→b, b→a)', () => {
    const g = tasks(['a', { deps: ['b'] }], ['b', { deps: ['a'] }])
    assert.throws(() => topologicalSort(g), /[Cc]ircular/)
  })

  it('throws on indirect cycle (a→b→c→a)', () => {
    const g = tasks(
      ['a', { deps: ['c'] }],
      ['b', { deps: ['a'] }],
      ['c', { deps: ['b'] }],
    )
    assert.throws(() => topologicalSort(g), /[Cc]ircular/)
  })

  it('throws on self-loop (a→a)', () => {
    const g = tasks(['a', { deps: ['a'] }])
    assert.throws(() => topologicalSort(g), /[Cc]ircular/)
  })

  it('throws on unknown dependency reference', () => {
    const g = tasks(['a', { deps: ['ghost'] }])
    assert.throws(() => topologicalSort(g), /[Uu]nknown/)
  })
})

// ─── getReadyTasks ────────────────────────────────────────────────────────────

describe('getReadyTasks', () => {
  it('returns root task when no deps and status is pending', () => {
    const g = tasks(['a'], ['b', { deps: ['a'] }])
    const order = topologicalSort(g)
    assert.deepEqual(getReadyTasks(g, order), ['a'])
  })

  it('returns task when all deps are completed', () => {
    const g = tasks(['a', { status: 'completed' }], ['b', { deps: ['a'] }])
    const order = topologicalSort(g)
    assert.ok(getReadyTasks(g, order).includes('b'))
  })

  it('does not return task with pending deps', () => {
    const g = tasks(['a'], ['b', { deps: ['a'] }])
    const order = topologicalSort(g)
    assert.ok(!getReadyTasks(g, order).includes('b'))
  })

  it('does not return completed tasks', () => {
    const g = tasks(['a', { status: 'completed' }])
    const order = topologicalSort(g)
    assert.deepEqual(getReadyTasks(g, order), [])
  })

  it('does not return running tasks', () => {
    const g = tasks(['a', { status: 'running' }])
    const order = topologicalSort(g)
    assert.deepEqual(getReadyTasks(g, order), [])
  })

  it('does not return failed tasks', () => {
    const g = tasks(['a', { status: 'failed' }])
    const order = topologicalSort(g)
    assert.deepEqual(getReadyTasks(g, order), [])
  })

  it('returns multiple independently ready tasks', () => {
    const g = tasks(['a'], ['b'], ['c', { deps: ['a', 'b'] }])
    const order = topologicalSort(g)
    const ready = getReadyTasks(g, order)
    assert.ok(ready.includes('a'))
    assert.ok(ready.includes('b'))
    assert.ok(!ready.includes('c'))
  })

  it('returns [] when everything is done', () => {
    const g = tasks(
      ['a', { status: 'completed' }],
      ['b', { deps: ['a'], status: 'completed' }],
    )
    const order = topologicalSort(g)
    assert.deepEqual(getReadyTasks(g, order), [])
  })

  it('respects provided order for stable output ordering', () => {
    const g = tasks(['a'], ['b'])
    const ready = getReadyTasks(g, ['a', 'b'])
    assert.deepEqual(ready, ['a', 'b'])
  })
})

// ─── getBlockedTasks ──────────────────────────────────────────────────────────

describe('getBlockedTasks', () => {
  it('returns pending task whose dep is failed', () => {
    const g = tasks(['a', { status: 'failed' }], ['b', { deps: ['a'] }])
    assert.deepEqual(getBlockedTasks(g), ['b'])
  })

  it('returns pending task whose dep is skipped', () => {
    const g = tasks(['a', { status: 'skipped' }], ['b', { deps: ['a'] }])
    assert.deepEqual(getBlockedTasks(g), ['b'])
  })

  it('does not block task with only completed deps', () => {
    const g = tasks(['a', { status: 'completed' }], ['b', { deps: ['a'] }])
    assert.deepEqual(getBlockedTasks(g), [])
  })

  it('does not return non-pending tasks even if deps failed', () => {
    const g = tasks(
      ['a', { status: 'failed' }],
      ['b', { deps: ['a'], status: 'completed' }],
    )
    assert.deepEqual(getBlockedTasks(g), [])
  })

  it('returns [] when no failures', () => {
    const g = tasks(['a'], ['b', { deps: ['a'] }])
    assert.deepEqual(getBlockedTasks(g), [])
  })

  it('returns [] for empty task map', () => {
    assert.deepEqual(getBlockedTasks({}), [])
  })

  it('blocks multiple tasks from one failure', () => {
    const g = tasks(
      ['a', { status: 'failed' }],
      ['b', { deps: ['a'] }],
      ['c', { deps: ['a'] }],
    )
    const blocked = getBlockedTasks(g)
    assert.ok(blocked.includes('b'))
    assert.ok(blocked.includes('c'))
  })
})

// ─── getStats ─────────────────────────────────────────────────────────────────

describe('getStats', () => {
  it('returns all-zero stats for empty input', () => {
    const s = getStats({})
    assert.equal(s.total, 0)
    assert.equal(s.completed, 0)
    assert.equal(s.failed, 0)
    assert.equal(s.skipped, 0)
    assert.equal(s.running, 0)
    assert.equal(s.pending, 0)
  })

  it('counts each status independently', () => {
    const g = tasks(
      ['a', { status: 'completed' }],
      ['b', { status: 'failed' }],
      ['c', { status: 'skipped' }],
      ['d', { status: 'running' }],
      ['e', { status: 'pending' }],
    )
    const s = getStats(g)
    assert.equal(s.total, 5)
    assert.equal(s.completed, 1)
    assert.equal(s.failed, 1)
    assert.equal(s.skipped, 1)
    assert.equal(s.running, 1)
    assert.equal(s.pending, 1)
  })

  it('total equals sum of all individual counts', () => {
    const g = tasks(
      ['a', { status: 'completed' }],
      ['b', { status: 'completed' }],
      ['c', { status: 'pending' }],
    )
    const s = getStats(g)
    assert.equal(s.total, s.completed + s.failed + s.skipped + s.running + s.pending)
  })

  it('counts multiple tasks of same status', () => {
    const g = tasks(
      ['a', { status: 'completed' }],
      ['b', { status: 'completed' }],
      ['c', { status: 'completed' }],
    )
    assert.equal(getStats(g).completed, 3)
  })

  it('all-pending returns pending=N, others=0', () => {
    const g = tasks(['a'], ['b'], ['c'])
    const s = getStats(g)
    assert.equal(s.pending, 3)
    assert.equal(s.completed, 0)
    assert.equal(s.failed, 0)
  })
})
