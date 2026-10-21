/**
 * Inbound platform from model id. Unknown models fail closed.
 * GPT = /^gpt/i minus SKIP_GPT. Claude = claude-* family. Not URL, not pin.
 */
import { SKIP_GPT, isGptSeriesId } from './gpt-ids.mjs'
import { antigravityUpstreamModel } from './antigravity-route.mjs'
export function detectInboundPlatform(model) {
  const raw = String(model || '').trim()
  if (!raw) {
    return {
      ok: false,
      code: 'model_required',
      message: 'model is required',
    }
  }
  if (/(?:^|\/)antigravity(?:\/|$)/i.test(raw)) {
    const id = /^antigravity\//i.test(raw) ? antigravityUpstreamModel(raw) : null
    if (!id)
      return { ok: false, code: 'model_not_supported', message: `model '${raw}' has an invalid Antigravity model ID` }
    return { ok: true, platform: 'antigravity', model: id }
  }
  const id = raw.split('/').filter(Boolean).pop() || raw
  const lower = id.toLowerCase()
  if (SKIP_GPT.test(lower)) {
    return {
      ok: false,
      code: 'model_not_supported',
      message: `model '${raw}' is not a GPT chat model`,
    }
  }
  if (isGptSeriesId(id)) return { ok: true, platform: 'openai', model: id }
  if (
    lower.startsWith('claude-') ||
    lower.startsWith('anthropic.claude-') ||
    /^(sonnet|opus|haiku|fable)(-|$)/i.test(lower)
  ) {
    return { ok: true, platform: 'anthropic', model: id }
  }
  return {
    ok: false,
    code: 'model_not_supported',
    message: `model '${raw}' is not recognized. No hop.`,
  }
}
