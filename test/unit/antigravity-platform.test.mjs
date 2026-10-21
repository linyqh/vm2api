import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePlatformId, platformDescriptor } from '../../src/lib/platforms/registry.mjs'
import { normalizeVmKind, isClaudeVm, isCodexVm, isAntigravityVm, stampVmKind } from '../../src/lib/vm/vm-kind.mjs'
import { detectInboundPlatform } from '../../src/lib/protocol/platform-detect.mjs'
import { evaluateSlotGate } from '../../src/lib/pool/schedule-eligibility.mjs'
import { normalizeKeyScope, keyAllowsVm, keyScopeFromRecord, applyVmPool } from '../../src/lib/admin/key-scope.mjs'
import { scopeStickyKey } from '../../src/lib/pool/sticky-router.mjs'
import { gatewayModelCatalog, validateOfficialModel, resolveCatalogModel } from '../../src/lib/protocol/models.mjs'
import {
  ANTIGRAVITY_CAPABILITIES,
  antigravityUpstreamModel,
  normalizeAntigravityRouting,
  listAntigravityPublicModels,
  validateAntigravityRoutingPatch,
} from '../../src/lib/protocol/antigravity-route.mjs'

const ag = { id: 'vm-ag-01', platform: 'antigravity', family: 'antigravity' }

test('explicit account platform owns credentials even with leftover provider fields', () => {
  const mixed = { ...ag, family: 'codex', codex_kernel: true, claude: { has_access: true } }
  assert.deepEqual(normalizeVmKind(mixed), { platform: 'antigravity', family: 'antigravity', kind: 'antigravity' })
  assert.equal(isAntigravityVm(mixed), true)
  assert.equal(isClaudeVm(mixed), false)
  assert.equal(isCodexVm(mixed), false)
  assert.equal(evaluateSlotGate(mixed).reason, 'antigravity_vm')
  assert.equal(normalizeVmKind({ platform: 'anthropic', family: 'antigravity' }).kind, 'claude')
  stampVmKind(mixed)
  assert.equal(mixed.claude, undefined)
  assert.equal(mixed.codex_kernel, undefined)
  assert.deepEqual(mixed.antigravity, {})
  assert.equal(normalizePlatformId('GPT'), 'openai')
  assert.equal(platformDescriptor('antigravity').label, 'Antigravity')
})

test('unknown explicit platform never falls through to Claude or legacy Codex', () => {
  const unknown = { platform: 'unsupported', family: 'claude', codex_kernel: true }
  assert.equal(normalizeVmKind(unknown).kind, 'unknown')
  assert.equal(isClaudeVm(unknown), false)
  assert.equal(isCodexVm(unknown), false)
  assert.equal(evaluateSlotGate(unknown).ok, false)
  assert.throws(() => stampVmKind(unknown), { code: 'platform_not_supported' })
  assert.equal(normalizeVmKind({}).kind, 'claude')
  assert.equal(normalizeVmKind({ codex_kernel: true }).kind, 'codex')
})

test('Antigravity namespace survives model vendor detection', () => {
  for (const id of ['claude-sonnet-test', 'gemini-test', 'gpt-test']) {
    assert.deepEqual(detectInboundPlatform(`antigravity/${id}`), { ok: true, platform: 'antigravity', model: id })
  }
  assert.equal(detectInboundPlatform('Antigravity/gemini-test').platform, 'antigravity')
  assert.equal(detectInboundPlatform('claude-sonnet-test').platform, 'anthropic')
  assert.equal(detectInboundPlatform('gemini-test').ok, false)
  for (const id of [
    'antigravity',
    'antigravity/',
    'antigravity//claude-test',
    'antigravity/../claude-test',
    'prefix/antigravity/claude-test',
  ]) {
    assert.equal(detectInboundPlatform(id).ok, false, id)
  }
  assert.equal(antigravityUpstreamModel('--model'), null)
  assert.equal(antigravityUpstreamModel('gemini test'), null)
  assert.equal(validateOfficialModel('antigravity/claude-sonnet-5').error.code, 'platform_mismatch')
  assert.equal(resolveCatalogModel('antigravity/claude-sonnet-5', ['claude-sonnet-5']).ok, false)
})

test('Antigravity key scope intersects platform, live pool and VM list', () => {
  const scope = normalizeKeyScope({ group_type: 'antigravity', allowed_vms: [ag.id] })
  assert.equal(keyAllowsVm(scope, ag), true)
  assert.equal(keyAllowsVm(scope, { id: ag.id, platform: 'anthropic' }), false)
  assert.equal(keyAllowsVm(scope, { ...ag, id: 'vm-other' }), false)
  const claude = normalizeKeyScope({ group_type: 'anthropic', allowed_vms: [ag.id] })
  assert.equal(keyAllowsVm(claude, ag), false)
  const pool = applyVmPool({ ...scope, vm_pool_id: 'pool_abcdef01' }, () => ({ enabled: true, vm_ids: ['vm-other'] }))
  assert.equal(keyAllowsVm(pool, ag), false)
  assert.equal(keyAllowsVm(pool, { id: 'vm-other', platform: 'anthropic' }), false)
  assert.equal(keyAllowsVm(keyScopeFromRecord({ group_type: 'unsupported' }), ag), false)
})

test('platform sticky namespaces never reuse another platform conversation', () => {
  const keys = ['anthropic', 'openai', 'antigravity'].map((platform) => scopeStickyKey('key:session', platform))
  assert.equal(new Set(keys).size, 3)
  assert.equal(keys[2], 'p:antigravity:key:session')
  assert.equal(scopeStickyKey(keys[2], 'antigravity'), keys[2])
})

test('routing remains opt-in and advertises its independent API capabilities', () => {
  const defaults = normalizeAntigravityRouting()
  assert.deepEqual(defaults, {
    enabled: false,
    cli_bin: 'agy',
    models: [],
    max_sessions: 1,
    idle_ttl_seconds: 600,
    timeout_ms: 180000,
  })
  assert.deepEqual(listAntigravityPublicModels({ models: ['gemini-test'] }), [])
  assert.equal(ANTIGRAVITY_CAPABILITIES.client_tools, true)
  assert.equal(ANTIGRAVITY_CAPABILITIES.history_import, true)
  assert.deepEqual(ANTIGRAVITY_CAPABILITIES.protocols, [
    'anthropic.messages',
    'openai.chat',
    'openai.responses',
    'openai.completions',
  ])
  for (const config of [
    null,
    [],
    { enabled: 'true' },
    { max_sessions: 0 },
    { timeout_ms: 999 },
    { models: ['--bad'] },
    { cli_bin: 'agy\nother' },
  ]) {
    assert.throws(() => validateAntigravityRoutingPatch({ antigravity: config }), { code: 'invalid_antigravity' })
  }
  assert.doesNotThrow(() => validateAntigravityRoutingPatch({ unrelated_setting: true }))
})

test('local catalog preserves platform and vendor separately and filters by key group', () => {
  const antigravityRouting = {
    enabled: true,
    models: [
      { id: 'claude-test', vendor: 'anthropic', display_name: 'AG Claude' },
      'gemini-test',
      { id: 'disabled-test', enabled: false },
      'CLAUDE-TEST',
    ],
  }
  const agCatalog = gatewayModelCatalog({ groupType: 'antigravity', antigravityRouting })
  assert.deepEqual(
    agCatalog.data.map((row) => row.id),
    ['antigravity/claude-test', 'antigravity/gemini-test'],
  )
  const model = agCatalog.data[0]
  assert.equal(model.platform, 'antigravity')
  assert.equal(model.vendor, 'anthropic')
  assert.equal(model.upstream_model, 'claude-test')
  assert.equal(model.owned_by, 'anthropic')
  for (const groupType of ['anthropic', 'openai', 'unknown']) {
    assert.equal(
      gatewayModelCatalog({ groupType, antigravityRouting }).data.some((row) => row.platform === 'antigravity'),
      false,
    )
  }
  assert.equal(gatewayModelCatalog({ groupType: 'antigravity' }).data.length, 0)
})
