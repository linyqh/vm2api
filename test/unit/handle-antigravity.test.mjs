import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { handleAntigravityProtocol } from '../../src/lib/protocol/handle-antigravity.mjs'
import { createAntigravityPoolRuntime } from '../../src/lib/pool/antigravity-slot-pool.mjs'
import { createAntigravityResponseStore } from '../../src/lib/protocol/antigravity-response-store.mjs'

const slot = {
  id: 'vm-ag-01',
  platform: 'antigravity',
  status: 'running',
  schedulable: true,
  antigravity: { authenticated: true },
  proxy: { id: 'px-test', host: '1.2.3.4', port: 1080 },
}
const success = {
  ok: true,
  status: 200,
  content: [{ type: 'text', text: 'Hello' }],
  usage: { input_tokens: 10, output_tokens: 2 },
  stop_reason: 'end_turn',
  terminalState: 'verified',
}

async function invoke({
  protocol = 'openai.chat',
  body,
  slots = [slot],
  inference = async () => success,
  requestPatch = {},
  responsePatch = {},
  accountGate = null,
  extraOps = {},
  runtime = createAntigravityPoolRuntime(),
  store = createAntigravityResponseStore(),
  keyStore = null,
} = {}) {
  const req = Object.assign(
    new EventEmitter(),
    { headers: {}, apiKeyKind: 'managed', apiKeyRecord: { id: 'key-one' } },
    requestPatch,
  )
  const res = Object.assign(
    new EventEmitter(),
    {
      headersSent: false,
      writableEnded: false,
      writableLength: 0,
      chunks: [],
      write(chunk) {
        this.chunks.push(chunk)
      },
      end() {
        this.writableEnded = true
      },
    },
    responsePatch,
  )
  const logBag = {}
  const stats = { requests: 0, errors: 0, by_route: {} }
  const actualBody =
    body ||
    (protocol === 'openai.responses'
      ? { model: 'antigravity/model-one', input: 'hello' }
      : { model: 'antigravity/model-one', messages: [{ role: 'user', content: 'hello' }] })
  let runs = 0,
    billed = 0
  await handleAntigravityProtocol({
    req,
    res,
    protocol,
    inbound: actualBody,
    ctx: { body: actualBody },
    logBag,
    stats,
    json: (response, status, value) => {
      response.status = status
      response.body = value
      response.end()
    },
    writeSSEHeaders: (response) => {
      response.headersSent = true
      response.status = 200
    },
    routing: { antigravity: { enabled: true, models: ['model-one'] }, pool: { fallback_wait_timeout_ms: 1 } },
    projectRoot: '/unused',
    apiKeyStore: keyStore,
    accountGate,
    recordUsage: () => {
      billed++
    },
    ops: {
      keyScope: () => ({ group_type: 'all' }),
      listVms: () => slots,
      getVm: (_root, id) => slots.find((vm) => vm.id === id),
      supportsModel: () => true,
      runtime,
      responseStore: store,
      runInference: async (args) => {
        runs++
        return inference(args, runs)
      },
      ...extraOps,
    },
  })
  return { req, res, logBag, stats, runs, billed, runtime, store }
}

test('disconnected requests never start upstream inference', async () => {
  for (const patches of [
    { requestPatch: { aborted: true } },
    { responsePatch: { destroyed: true } },
    { responsePatch: { writableEnded: true } },
  ]) {
    const h = await invoke(patches)
    assert.equal(h.runs, 0)
    assert.equal(h.logBag.final_state, 'cancelled')
  }
  const request = new AbortController()
  const h = await invoke({
    accountGate: async () => {
      request.abort()
      return false
    },
    requestPatch: {
      once(name, listener) {
        if (name === 'aborted') request.signal.addEventListener('abort', listener)
      },
      off() {},
    },
  })
  assert.equal(h.runs, 0)
  assert.equal(h.logBag.final_state, 'cancelled')
})

test('Antigravity handler returns native envelopes and usage for all three public protocols', async () => {
  for (const protocol of ['openai.chat', 'openai.responses', 'anthropic.messages']) {
    const h = await invoke({ protocol })
    assert.equal(h.res.status, 200)
    assert.equal(h.runs, 1)
    assert.equal(h.billed, 1)
    assert.equal(h.logBag.vm_id, slot.id)
    assert.equal(h.logBag.input_tokens, 10)
    assert.equal(h.logBag.final_state, 'verified')
    assert.equal(h.runtime.snapshot(slot.id).inFlight, 0)
    assert.equal(
      protocol === 'openai.chat'
        ? h.res.body.choices[0].message.content
        : protocol === 'anthropic.messages'
          ? h.res.body.content[0].text
          : h.res.body.output_text,
      'Hello',
    )
  }
})

test('Antigravity stream preserves deltas and ends with exactly one verified terminal', async () => {
  const h = await invoke({
    body: {
      model: 'antigravity/model-one',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
      stream_options: { include_usage: true },
    },
    inference: async ({ onEvent }) => {
      onEvent({ type: 'text_delta', text: 'Hel' })
      onEvent({ type: 'text_delta', text: 'lo' })
      return success
    },
  })
  const stream = h.res.chunks.join('')
  assert.match(stream, /"content":"Hel"/)
  assert.match(stream, /"content":"lo"/)
  assert.equal(stream.match(/\[DONE\]/g)?.length, 1)
  assert.match(stream, /"prompt_tokens":10/)
})

test('Uncommitted transient failures switch accounts, while committed streams never replay', async () => {
  const slots = [slot, { ...slot, id: 'vm-ag-02' }]
  const h = await invoke({
    slots,
    inference: async (_args, count) =>
      count === 1 ? { ok: false, status: 429, code: 'quota_exhausted', message: 'Upstream quota exhausted' } : success,
  })
  assert.equal(h.runs, 2)
  assert.equal(h.res.status, 200)
  const partial = await invoke({
    slots,
    body: { model: 'antigravity/model-one', stream: true, messages: [{ role: 'user', content: 'hello' }] },
    inference: async ({ onEvent }) => {
      onEvent({ type: 'text_delta', text: 'part' })
      return { ok: false, status: 502, code: 'upstream_stream_incomplete', message: 'Stream interrupted' }
    },
  })
  assert.equal(partial.runs, 1)
  assert.match(partial.res.chunks.join(''), /upstream_stream_incomplete/)
  assert.doesNotMatch(partial.res.chunks.join(''), /\[DONE\]/)
})

test('Responses continuation carries canonical history only for its key and model', async () => {
  const store = createAntigravityResponseStore()
  const first = await invoke({ protocol: 'openai.responses', store })
  const body = { model: 'antigravity/model-one', previous_response_id: first.res.body.id, input: 'continue' }
  let history
  const next = await invoke({
    protocol: 'openai.responses',
    body,
    store,
    inference: async ({ request }) => {
      history = request.messages
      return success
    },
  })
  assert.equal(next.res.status, 200)
  assert.equal(history.length, 3)
  assert.equal(history[1].role, 'assistant')
  const stolen = await invoke({
    protocol: 'openai.responses',
    body,
    store,
    requestPatch: { apiKeyRecord: { id: 'key-other' } },
  })
  assert.equal(stolen.res.status, 404)
  assert.equal(stolen.runs, 0)
  const noStore = await invoke({
    protocol: 'openai.responses',
    body: { model: 'antigravity/model-one', input: 'private', store: false },
    store,
  })
  const missing = await invoke({
    protocol: 'openai.responses',
    body: { model: 'antigravity/model-one', input: 'continue', previous_response_id: noStore.res.body.id },
    store,
  })
  assert.equal(missing.res.status, 404)
})

test('Managed key admission/release is enforced even on upstream errors', async () => {
  let acquired = 0,
    released = 0
  const keyStore = {
    acquire() {
      acquired++
      return { ok: true }
    },
    release() {
      released++
    },
  }
  const h = await invoke({
    keyStore,
    inference: async () => {
      throw new Error('private upstream diagnostic')
    },
  })
  assert.equal(acquired, 1)
  assert.equal(released, 1)
  assert.equal(h.res.status, 502)
  assert.doesNotMatch(JSON.stringify(h.res.body), /private upstream diagnostic/)
  const rejected = await invoke({
    keyStore: { acquire: () => ({ ok: false, status: 429, code: 'key_concurrency', message: 'Full' }) },
  })
  assert.equal(rejected.runs, 0)
  assert.equal(rejected.res.status, 429)
})

test('Tenant ownership and live pool membership cannot be widened by an ordinary key pin', async () => {
  const h = await invoke({
    slots: [{ ...slot, owner_user_id: 'another-user' }],
    requestPatch: { headers: { 'x-kin-vm': slot.id } },
  })
  assert.equal(h.runs, 0)
  assert.equal(h.res.status, 503)
  const empty = await invoke({
    extraOps: {
      keyScope: () => ({ group_type: 'all', vm_pool_id: 'pool_12345678', allowed_vms: [], vm_pool_error: 'empty' }),
    },
  })
  assert.equal(empty.res.status, 403)
  assert.equal(empty.runs, 0)
})
