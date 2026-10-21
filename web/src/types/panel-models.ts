export type ModelCatalogItem = {
  id: string
  platform?: string
  family?: string
  vendor?: string
  upstream_model?: string
  display_name?: string
}

export type ModelsPayload = {
  items?: ModelCatalogItem[]
}
