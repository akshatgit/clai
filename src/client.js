import Anthropic from '@anthropic-ai/sdk'

const useBlackbox = !process.env.ANTHROPIC_API_KEY && !!process.env.BLACKBOX_API_KEY
const DEBUG = !!process.env.DEBUG

function debugWrap(c) {
  const orig = c.messages.create.bind(c.messages)
  c.messages.create = async (params, opts) => {
    if (DEBUG) {
      console.error('\n[debug] → messages.create', JSON.stringify({
        model: params.model,
        max_tokens: params.max_tokens,
        tools: params.tools?.map(t => t.name),
        thinking: params.thinking,
        messages: params.messages?.map(m => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? m.content.slice(0, 200)
            : Array.isArray(m.content) ? `[${m.content.length} blocks]` : m.content,
        })),
      }, null, 2))
    }
    try {
      const res = await orig(params, opts)
      if (DEBUG) console.error(`[debug] ← stop_reason=${res.stop_reason} blocks=${res.content?.length}`)
      return res
    } catch (err) {
      if (DEBUG) console.error('[debug] ✗ error:', err.message, err.status, JSON.stringify(err.error ?? ''))
      throw err
    }
  }
  return c
}

const _baseClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.BLACKBOX_API_KEY,
  maxRetries: 0,  // We handle retries ourselves to properly respect retry-after
  ...(useBlackbox || process.env.ANTHROPIC_BASE_URL
    ? { baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.blackbox.ai' }
    : {}),
  ...(useBlackbox
    ? { defaultHeaders: { 'Authorization': `Bearer ${process.env.BLACKBOX_API_KEY}` } }
    : {}),
})

// Wrap messages.create with retry-after-aware retry logic.
// On 429 rate limit errors, wait exactly as long as the server asks then retry.
// No cap on retries — we're fine waiting as long as needed.
const _origCreate = _baseClient.messages.create.bind(_baseClient.messages)
_baseClient.messages.create = async function retryCreate(params, opts) {
  while (true) {
    try {
      return await _origCreate(params, opts)
    } catch (err) {
      if (err.status !== 429) throw err
      const retryAfter = parseInt(err.headers?.['retry-after'] ?? '60', 10)
      const waitMs = (isNaN(retryAfter) ? 60 : retryAfter) * 1000
      console.error(`[rate-limit] 429 — waiting ${waitMs / 1000}s (retry-after header)…`)
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
}

let _client = debugWrap(_baseClient)

// Proxy so that swapping _client via _setClient is visible to all importers
// without them having to re-import or use a getter.
export const client = new Proxy({}, { get: (_, prop) => _client[prop] })

export function _setClient(mock) { _client = DEBUG ? debugWrap(mock) : mock }

// Model IDs differ between Anthropic and Blackbox AI.
// Blackbox AI's /v1/messages endpoint requires the "blackboxai/anthropic/" prefix
// and uses dots instead of dashes in version numbers.
export const MODELS = useBlackbox ? {
  low:    'blackboxai/anthropic/claude-haiku-4.5',
  medium: 'blackboxai/anthropic/claude-sonnet-4.6',
  high:   'blackboxai/anthropic/claude-opus-4.6',
} : {
  low:    'claude-haiku-4-5-20251001',
  medium: 'claude-sonnet-4-6',
  high:   'claude-opus-4-6',
}
