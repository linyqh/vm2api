/** Independent Antigravity account platform backed by the slot's authenticated runtime. */
export const ANTIGRAVITY_MODEL_PREFIX = 'antigravity/'
export const ANTIGRAVITY_CAPABILITIES = Object.freeze({
  experimental_text_session: true,
  streaming: true,
  system: true,
  images: true,
  client_tools: true,
  history_import: true,
  protocols: Object.freeze(['anthropic.messages', 'openai.chat', 'openai.responses', 'openai.completions']),
})

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function boundedInteger(value, fallback, min, max) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback
}

export function antigravityUpstreamModel(value) {
  const raw = String(value || '').trim()
  const id = /^antigravity\//i.test(raw) ? raw.slice(ANTIGRAVITY_MODEL_PREFIX.length) : raw
  return /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(id) ? id : null
}

export function normalizeAntigravityModels(value) {
  const models = []
  const seen = new Set()
  for (const item of Array.isArray(value) ? value : []) {
    const row = typeof item === 'string' ? { id: item } : objectOf(item)
    const id = antigravityUpstreamModel(row.id)
    if (!id || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    const vendor = String(row.vendor || '')
      .trim()
      .toLowerCase()
    models.push({
      id,
      display_name: String(row.display_name || id).trim() || id,
      vendor: /^[a-z][a-z0-9-]{0,39}$/.test(vendor) ? vendor : null,
      enabled: row.enabled !== false,
    })
  }
  return models
}

export function normalizeAntigravityRouting(raw = {}) {
  const src = objectOf(raw)
  const cli = typeof src.cli_bin === 'string' ? src.cli_bin.trim() : ''
  return {
    enabled: src.enabled === true,
    cli_bin: cli && !/[\0\r\n]/.test(cli) ? cli : 'agy',
    models: normalizeAntigravityModels(src.models),
    max_sessions: boundedInteger(src.max_sessions, 1, 1, 20),
    idle_ttl_seconds: boundedInteger(src.idle_ttl_seconds, 600, 1, 86400),
    timeout_ms: boundedInteger(src.timeout_ms, 180000, 1000, 3600000),
  }
}

/** Strict write validation; reads remain defensive for older config files. */
export function validateAntigravityRoutingPatch(body = {}) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, 'antigravity')) return
  const raw = body.antigravity
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new TypeError('antigravity 必须是对象'), { code: 'invalid_antigravity' })
  }
  if ('enabled' in raw && typeof raw.enabled !== 'boolean') {
    throw Object.assign(new TypeError('antigravity.enabled 必须是布尔'), { code: 'invalid_antigravity' })
  }
  if ('cli_bin' in raw && (typeof raw.cli_bin !== 'string' || !raw.cli_bin.trim() || /[\0\r\n]/.test(raw.cli_bin))) {
    throw Object.assign(new TypeError('antigravity.cli_bin 必须是可执行文件路径或名称'), {
      code: 'invalid_antigravity',
    })
  }
  for (const [field, min, max] of [
    ['max_sessions', 1, 20],
    ['idle_ttl_seconds', 1, 86400],
    ['timeout_ms', 1000, 3600000],
  ]) {
    if (field in raw && (!Number.isInteger(raw[field]) || raw[field] < min || raw[field] > max)) {
      throw Object.assign(new TypeError(`antigravity.${field} 必须是 ${min} 到 ${max} 的整数`), {
        code: 'invalid_antigravity',
      })
    }
  }
  if ('models' in raw) {
    if (
      !Array.isArray(raw.models) ||
      raw.models.some((item) => {
        const row = typeof item === 'string' ? { id: item } : objectOf(item)
        return !antigravityUpstreamModel(row.id) || ('enabled' in row && typeof row.enabled !== 'boolean')
      })
    ) {
      throw Object.assign(new TypeError('antigravity.models 必须是有效的模型 ID 或模型对象数组'), {
        code: 'invalid_antigravity',
      })
    }
  }
}

export function listAntigravityPublicModels(routing = {}) {
  const config = normalizeAntigravityRouting(routing)
  if (!config.enabled) return []
  return config.models
    .filter((model) => model.enabled)
    .map((model) => ({
      id: `${ANTIGRAVITY_MODEL_PREFIX}${model.id}`,
      object: 'model',
      type: 'model',
      display_name: model.display_name,
      owned_by: model.vendor || 'antigravity',
      platform: 'antigravity',
      family: 'antigravity',
      vendor: model.vendor,
      upstream_model: model.id,
      enabled: true,
      experimental: false,
      capabilities: ANTIGRAVITY_CAPABILITIES,
      source: 'antigravity-routing',
    }))
}
