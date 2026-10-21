export function antigravityModelSyncRequest(
  vmId: string,
  publishGlobal = false
) {
  return {
    url: `/api/panel/vms/${encodeURIComponent(vmId)}/antigravity/models/sync`,
    body: { publish_global: publishGlobal },
  }
}
