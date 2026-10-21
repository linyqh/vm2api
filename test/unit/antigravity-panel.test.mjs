import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import { prepareAntigravityChat, scopeAntigravitySession } from '../../src/lib/admin/antigravity-panel.mjs'
import { buildVmDetail } from '../../src/lib/admin/panel-api.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

const routing = { antigravity: { enabled: true, models: ['gemini-example'] } }
const vm = {
  id: 'vm-ag',
  platform: 'antigravity',
  family: 'antigravity',
  owner_user_id: 'u-1',
  runtime: { type: 'docker' },
}
const tenant = { panelUserId: 'u-1', panelUser: 'alice', panelRole: 'user' }
const admin = { apiKeyKind: 'master', panelRole: 'admin' }

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ag-panel-'))
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  return project
}

function harness(project, who, body, extra = {}) {
  const response = new EventEmitter()
  const handler = createPanelHandler({
    cfg: { paths: { project } },
    routingConfig: routing,
    ...extra,
    requireAuth(req) {
      Object.assign(req, who)
      return true
    },
    readBody: async () => body,
    json(_res, status, payload) {
      Object.assign(response, { status, body: payload })
      return true
    },
  })
  return {
    response,
    async call(method, suffix) {
      const req = Object.assign(new EventEmitter(), { method, headers: {} })
      await handler(req, response, new URL(`http://localhost/api/panel/${suffix}`))
      return response
    },
  }
}

test('routing GET exposes Antigravity defaults and only normalized public configuration', async (t) => {
  const project = fixture(t)
  const defaults = {
    enabled: false,
    cli_bin: 'agy',
    models: [],
    max_sessions: 1,
    idle_ttl_seconds: 600,
    timeout_ms: 180000,
  }
  const h = harness(
    project,
    admin,
    {},
    {
      routingConfig: {},
      stickyRouter: { stats: () => ({}) },
    },
  )
  await h.call('GET', 'routing')
  assert.equal(h.response.status, 200)
  assert.deepEqual(h.response.body.data.antigravity, defaults)

  const configured = harness(
    project,
    admin,
    {},
    {
      routingConfig: {
        antigravity: {
          enabled: true,
          models: ['antigravity/gemini-example'],
          token: 'private-cli-token',
          keyring: { password: 'private-keyring-password' },
        },
      },
      stickyRouter: { stats: () => ({}) },
    },
  )
  await configured.call('GET', 'routing')
  assert.equal(configured.response.status, 200)
  assert.deepEqual(configured.response.body.data.antigravity, {
    ...defaults,
    enabled: true,
    models: [{ id: 'gemini-example', display_name: 'gemini-example', vendor: null, enabled: true }],
  })
  assert.doesNotMatch(JSON.stringify(configured.response.body), /private-cli-token|private-keyring-password/)
})

test('routing PUT persists Antigravity settings and GET returns them for the settings panel', async (t) => {
  const project = fixture(t)
  const routingConfigPath = path.join(project, 'routing.json')
  const routingConfig = {}
  const stickyRouter = { stats: () => ({}), reloadConfig() {} }
  const runtime = createRoutingRuntime({
    cfg: { paths: { project } },
    routingConfigPath,
    routingConfig,
    stickyRouter,
    accountQuota: { reloadConfig() {}, applyTierConcurrency() {}, applyTierRpm() {} },
  })
  const expected = {
    enabled: true,
    cli_bin: '/home/kincli/.local/bin/agy',
    models: [{ id: 'gemini-example', display_name: 'Gemini example', vendor: 'google', enabled: true }],
    max_sessions: 3,
    idle_ttl_seconds: 900,
    timeout_ms: 240000,
  }
  const h = harness(
    project,
    admin,
    { antigravity: { ...expected, token: 'private-cli-token' } },
    {
      cfg: { paths: { project }, limits: { max_body_bytes: 4096 } },
      routingConfig,
      stickyRouter,
      persistRoutingPatch: runtime.persistRoutingPatch,
    },
  )
  await h.call('PUT', 'routing')
  assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
  assert.deepEqual(h.response.body.data.antigravity, expected)
  assert.deepEqual(JSON.parse(fs.readFileSync(routingConfigPath, 'utf8')).antigravity, expected)

  await h.call('GET', 'routing')
  assert.equal(h.response.status, 200)
  assert.deepEqual(h.response.body.data.antigravity, expected)
  assert.doesNotMatch(JSON.stringify(h.response.body), /private-cli-token/)
})

test('experimental input rejects history, tools, disallowed models and invalid session ids', () => {
  const good = { model: 'antigravity/gemini-example', prompt: 'hello' }
  assert.equal(prepareAntigravityChat({ vm, routing, body: good }).ok, true)
  for (const body of [
    { ...good, messages: [] },
    { ...good, tools: [] },
    { ...good, system: 'x' },
    { ...good, model: 'gpt-5' },
    { ...good, prompt: '' },
    { ...good, session_id: '../x' },
  ])
    assert.equal(prepareAntigravityChat({ vm, routing, body }).ok, false)
  assert.equal(prepareAntigravityChat({ vm, routing: {}, body: good }).status, 503)
  assert.equal(
    prepareAntigravityChat({ vm: { ...vm, policy: { allowed_models: ['other'] } }, routing, body: good }).status,
    403,
  )
  assert.notEqual(scopeAntigravitySession('session', 'alice'), scopeAntigravitySession('session', 'bob'))
})

test('tenant chat uses a scoped session, returns verified text, and close reuses that scope', async (t) => {
  const project = fixture(t)
  let bridgeId
  const h = harness(
    project,
    tenant,
    { model: 'gemini-example', prompt: 'hello', session_id: 'session-1' },
    {
      runAntigravityText: async (input) => {
        bridgeId = input.sessionId
        assert.equal(input.model, 'gemini-example')
        assert.equal(input.prompt, 'hello')
        assert.equal(input.signal.aborted, false)
        return { ok: true, response: 'world', terminalState: 'verified', usage: { input_tokens: 2 } }
      },
    },
  )
  await h.call('POST', 'vms/vm-ag/antigravity/chat')
  assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
  assert.deepEqual(h.response.body.data.text, 'world')
  assert.equal(h.response.body.data.session_id, 'session-1')
  assert.notEqual(bridgeId, 'session-1')
  const close = harness(
    project,
    tenant,
    { session_id: 'session-1' },
    {
      routingConfig: {}, // Disabling new calls must still allow cleanup.
      closeAntigravityTextSession: async (input) => {
        assert.equal(input.sessionId, bridgeId)
        return { ok: true }
      },
    },
  )
  await close.call('POST', 'vms/vm-ag/antigravity/close')
  assert.equal(close.response.status, 200)
  assert.equal(close.response.body.data.closed, true)
})

test('foreign tenants and read-only operators cannot start text sessions', async (t) => {
  const project = fixture(t)
  for (const who of [
    { ...tenant, panelUserId: 'u-2' },
    { panelUser: 'operator', panelRole: 'super' },
  ]) {
    const h = harness(
      project,
      who,
      { model: 'gemini-example', prompt: 'hello' },
      {
        runAntigravityText() {
          throw new Error('must not run')
        },
      },
    )
    await h.call('POST', 'vms/vm-ag/antigravity/chat')
    assert.ok([403, 404].includes(h.response.status), JSON.stringify(h.response.body))
  }
})

test('status remains read-only and VM detail never calls Claude health or process probes', async (t) => {
  const project = fixture(t)
  const h = harness(
    project,
    tenant,
    {},
    {
      antigravityBridgeStatus: async () => ({
        ready: false,
        authenticated: null,
        code: 'antigravity_bridge_unavailable',
      }),
    },
  )
  await h.call('GET', 'vms/vm-ag/antigravity/status')
  assert.equal(h.response.status, 200)
  assert.equal(h.response.body.data.authenticated, null)
  const result = await buildVmDetail({
    cfg: { paths: { project } },
    id: 'vm-ag',
    routingConfig: routing,
    kernelHealth() {
      throw new Error('must not inspect Claude kernel')
    },
    slotProcessStatus() {
      throw new Error('must not inspect Claude process')
    },
  })
  assert.equal(result.data.vm.id, 'vm-ag')
  assert.equal(result.data.vm.platform, 'antigravity')
  assert.equal(result.data.account, null)
  assert.equal(result.data.official_cc, null)
  assert.equal(result.data.kernel.credential_owner, 'antigravity')
})

test('AG creation defaults to stopped local Docker and never seeds Claude config', async (t) => {
  const project = fixture(t)
  const h = harness(project, admin, { platform: 'antigravity', status: 'running', auto_allocate_proxy: false })
  await h.call('POST', 'vms/create')
  assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
  const saved = h.response.body.data.vm
  assert.equal(saved.platform, 'antigravity')
  assert.equal(saved.runtime_type, 'docker')
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.schedulable, false)
  assert.equal(fs.existsSync(path.join(project, 'vms', saved.id, 'cli-home', '.claude')), false)
})

test('AG rejects generic credential and scheduling mutations', async (t) => {
  const project = fixture(t)
  for (const [method, suffix, body] of [
    ['POST', 'vms/import', { vm_id: vm.id, token: 'secret' }],
    ['POST', 'vms/vm-ag/oauth/refresh', {}],
    ['POST', 'vms/vm-ag/schedulable', { schedulable: true }],
    ['POST', 'vms/vm-ag/activate', {}],
    ['POST', 'vms/vm-ag/credential/clear', {}],
    ['PATCH', 'vms/vm-ag', { inference_engine: 'rust' }],
    ['PUT', 'model-policy', { platform: 'antigravity', policy: {} }],
  ]) {
    const h = harness(project, admin, body)
    await h.call(method, suffix)
    assert.equal(h.response.status, 400, `${suffix}: ${JSON.stringify(h.response.body)}`)
  }
})

test('generic AG requests bypass Claude cached health and never enter either scheduler', async () => {
  for (const enabled of [false, true]) {
    const res = Object.assign(new EventEmitter(), { headersSent: false })
    const body = { model: 'antigravity/gemini-example', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
    const handler = createHandleProtocol({
      cfg: { rewrite: { enabled: false }, intercept: { rules: [] }, limits: { max_body_bytes: 1024 }, paths: {} },
      requireAuth: () => true,
      readBody: async () => body,
      json(_res, status, payload) {
        Object.assign(res, { status, body: payload })
      },
      requestLog: { start: () => ({ request_id: 'ag-unsupported' }), finish() {} },
      stats: { errors: 0 },
      groupsRepo: { rateMultiplier: () => 1 },
      getRoutingConfig: () => ({ antigravity: { enabled } }),
      getHealthMonitor: () => ({
        decide() {
          throw new Error('must not use cached Claude health')
        },
      }),
      getFailoverRunner() {
        throw new Error('must not schedule Claude')
      },
    })
    await handler.handleProtocol({ headers: {}, apiKeyKind: 'master' }, res, 'anthropic.messages', '/v1/messages')
    assert.equal(res.status, enabled ? 400 : 503, JSON.stringify(res.body))
    assert.equal(res.body.error.code, enabled ? 'antigravity_experimental_text_only' : 'antigravity_disabled')
  }
})
