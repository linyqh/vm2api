import crypto from 'node:crypto'
import {
  normalizeAntigravityRouting,
  antigravityModelId,
  resolveAntigravityVariant,
  ANTIGRAVITY_CAPABILITIES,
} from '../protocol/antigravity-route.mjs'
import { isAntigravityVm } from '../vm/vm-kind.mjs'
import { antigravitySlotAllowsModel } from '../pool/antigravity-slot-pool.mjs'

function failure(status, code, message) {
  return { ok: false, status, error: { code, message } }
}

export function scopeAntigravitySession(sessionId, actor = 'master') {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(sessionId)) return null
  const scope = crypto.createHash('sha256').update(String(actor)).digest('hex').slice(0, 16)
  return `panel-${scope}-${sessionId}`
}

export function prepareAntigravityChat({ vm, routing, body, actor = 'master' } = {}) {
  if (!vm || !isAntigravityVm(vm)) return failure(400, 'platform_mismatch', '此操作需要 Antigravity 槽位')
  const config = normalizeAntigravityRouting(routing?.antigravity)
  if (!config.enabled) return failure(503, 'antigravity_disabled', '请管理员在 Antigravity 设置中启用实验文本会话')
  if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(400, 'invalid_request', '请求必须是对象')
  if (Object.keys(body).some((key) => !['model', 'prompt', 'session_id'].includes(key))) {
    return failure(400, 'antigravity_text_only', '实验会话只接受 model、prompt 和 session_id')
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || Buffer.byteLength(body.prompt) > 64 * 1024) {
    return failure(400, 'invalid_prompt', 'prompt 必须是非空文本，且不超过 64 KiB')
  }
  const id = typeof body.model === 'string' ? antigravityModelId(body.model) : null
  const entry = id && config.models.find((model) => model.id === id && model.enabled)
  if (!entry) return failure(400, 'model_not_allowed', '请选择管理员配置并启用的 Antigravity 模型')
  if (!antigravitySlotAllowsModel({ allowed_models: vm.policy?.allowed_models }, id)) {
    return failure(403, 'model_not_allowed', '此槽位未允许该模型')
  }
  // The text session runs the official CLI, which takes the level-specific variant.
  const model = resolveAntigravityVariant(entry, null).upstream
  if (
    body.session_id != null &&
    (typeof body.session_id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(body.session_id))
  ) {
    return failure(400, 'invalid_session_id', 'session_id 格式无效')
  }
  const sessionId = body.session_id || crypto.randomUUID()
  return { ok: true, model, prompt: body.prompt, sessionId, bridgeSessionId: scopeAntigravitySession(sessionId, actor) }
}

export function antigravityStatusView({ routing, runtime = {} } = {}) {
  const config = normalizeAntigravityRouting(routing?.antigravity)
  return {
    enabled: config.enabled,
    ready: config.enabled && runtime.ready === true,
    authenticated: typeof runtime.authenticated === 'boolean' ? runtime.authenticated : null,
    models: config.models.filter((entry) => entry.enabled),
    capabilities: ANTIGRAVITY_CAPABILITIES,
    runtime: {
      ...runtime,
      supported: runtime.supported ?? !['antigravity_runtime_unsupported', 'platform_mismatch'].includes(runtime.code),
    },
    error: runtime.code || null,
    message: !config.enabled ? '实验文本会话尚未启用' : runtime.message || runtime.error || null,
  }
}
