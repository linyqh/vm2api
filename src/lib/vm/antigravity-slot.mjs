/** Antigravity credentials are owned by the CLI keyring, never vm.json. */
export function summarizeAntigravitySlot(_projectRoot, vm = {}) {
  const metadata = vm.antigravity || {}
  return {
    email: typeof metadata.email === 'string' ? metadata.email : null,
    authenticated: null,
    has_token: false,
    has_refresh: false,
    credential_storage: 'slot-keyring',
    credential_state: 'unknown',
    experimental: true,
  }
}
