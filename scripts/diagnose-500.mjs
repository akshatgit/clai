/**
 * Minimal diagnostic: send the exact localizeIssue request to Anthropic
 * with max_tokens: 1 to see the error without burning tokens.
 */
import Anthropic from '@anthropic-ai/sdk'
import { MODELS } from '../src/client.js'

// Re-import the tools directly from localize.js internals by capturing them
import { _setClient } from '../src/client.js'

let capturedParams = null
_setClient({
  messages: {
    create: async (params) => {
      capturedParams = params
      return {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'x', name: 'submit_report', input: { summary: 'x', relevant_files: [], fix_hypothesis: 'x' } }],
      }
    },
  },
})

const { localizeIssue } = await import('../src/localize.js')
await localizeIssue('test', '/tmp')

// Now make the real call with max_tokens: 1
const realClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

console.error(`[diag] Sending request to Anthropic API...`)
console.error(`[diag] Model: ${capturedParams.model}`)
console.error(`[diag] Tools: ${capturedParams.tools.map(t => t.name).join(', ')}`)

try {
  const res = await realClient.messages.create({
    ...capturedParams,
    max_tokens: 1,   // use 1 token — we just want to know if the request is accepted
  })
  console.log(`[diag] ✓ SUCCESS — stop_reason=${res.stop_reason}, blocks=${res.content.length}`)
  console.log('[diag] The request format is accepted. 500s you saw were transient Anthropic errors.')
} catch (err) {
  console.error(`[diag] ✗ ERROR — status=${err.status}`)
  console.error(`[diag] message: ${err.message}`)
  console.error(`[diag] error body: ${JSON.stringify(err.error ?? err.body ?? {}, null, 2)}`)
}
