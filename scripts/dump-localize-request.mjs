/**
 * Zero-cost diagnostic: prints the exact JSON body that would be sent to
 * the Anthropic API for a localizeIssue call, without making any API call.
 *
 * Usage:  node scripts/dump-localize-request.mjs [issue text]
 */

import { MODELS } from '../src/client.js'

// Import the tools directly from the localize module internals.
// We re-create the request object the same way localizeIssue does.
const { default: localizeMod } = await import('../src/localize.js').catch(() => ({}))

// Reproduce the LOCALIZE_TOOLS + prompt construction from localize.js
// (copied verbatim so this reflects the real request)
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/localize.js'), 'utf8'
)
console.error('[dump] Loaded localize.js source, extracting tools via dynamic eval...\n')

// Actually just intercept the client call by monkey-patching
import { _setClient } from '../src/client.js'

let capturedRequest = null
_setClient({
  messages: {
    create: async (params, opts) => {
      capturedRequest = { params, opts }
      // Simulate a submit_report response so localizeIssue exits cleanly
      return {
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          id: 'tu_dry_run',
          name: 'submit_report',
          input: {
            summary: 'DRY RUN',
            relevant_files: [],
            fix_hypothesis: 'DRY RUN',
          },
        }],
      }
    },
  },
})

const { localizeIssue } = await import('../src/localize.js')

const issueText = process.argv[2] || 'Sample bug: function crashes when input is empty'
const repoPath = process.argv[3] || '/tmp/example-repo'

await localizeIssue(issueText, repoPath)

console.log(JSON.stringify(capturedRequest?.params ?? {}, null, 2))
console.error('\n[dump] Tools in request:', capturedRequest?.params?.tools?.map(t => t.name))
console.error('[dump] Message count:', capturedRequest?.params?.messages?.length)
console.error('[dump] Model:', capturedRequest?.params?.model)
console.error('[dump] max_tokens:', capturedRequest?.params?.max_tokens)
console.error('[dump] Has thinking:', !!capturedRequest?.params?.thinking)
console.error('[dump] Has output_config:', !!capturedRequest?.params?.output_config)
