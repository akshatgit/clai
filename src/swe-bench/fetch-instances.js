// src/swe-bench/fetch-instances.js
// Fetches SWE-bench instances from the Hugging Face datasets HTTP API.
// No Python or datasets library required — uses native Node fetch.

const HF_BASE = 'https://datasets-server.huggingface.co/rows'

const DATASET_IDS = {
  lite:     'princeton-nlp/SWE-bench_Lite',
  verified: 'princeton-nlp/SWE-bench_Verified',
}

/**
 * Fetch SWE-bench instances from Hugging Face.
 *
 * @param {'lite'|'verified'} dataset  Which dataset to use
 * @param {{ limit?: number, instanceId?: string }} opts
 * @returns {Promise<Array<{ instance_id, repo, base_commit, problem_statement }>>}
 */
export async function fetchInstances(dataset = 'lite', { limit = 300, instanceId = null } = {}) {
  const datasetId = DATASET_IDS[dataset]
  if (!datasetId) throw new Error(`Unknown dataset: ${dataset}. Use 'lite' or 'verified'.`)

  // If a specific instance ID is requested, we still page through until we find it
  const batchSize = 100
  const results = []
  let offset = 0

  while (true) {
    const url = new URL(HF_BASE)
    url.searchParams.set('dataset', datasetId)
    url.searchParams.set('config', 'default')
    url.searchParams.set('split', 'test')
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('limit', String(batchSize))

    const res = await fetch(url.toString())
    if (!res.ok) {
      throw new Error(`HuggingFace API error ${res.status}: ${await res.text()}`)
    }

    const body = await res.json()
    const rows = body.rows ?? []
    if (rows.length === 0) break

    for (const row of rows) {
      const r = row.row
      const instance = {
        instance_id:       r.instance_id,
        repo:              r.repo,
        base_commit:       r.base_commit,
        problem_statement: r.problem_statement,
      }

      // Filter by instance ID if requested
      if (instanceId) {
        if (instance.instance_id === instanceId) return [instance]
      } else {
        results.push(instance)
        if (results.length >= limit) return results
      }
    }

    offset += rows.length

    // No more pages
    if (rows.length < batchSize) break
    // Also stop if we have reached the total
    if (body.num_rows_total && offset >= body.num_rows_total) break
  }

  if (instanceId) throw new Error(`Instance not found: ${instanceId}`)
  return results
}
