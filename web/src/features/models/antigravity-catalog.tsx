import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/empty-state'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { QueryGate } from '@/components/query-gate'
import { routingQueryOptions } from '@/features/settings/queries'
import {
  AntigravityModelSync,
  type AntigravityModelCatalog,
} from '@/features/vm/antigravity-model-sync'

type CatalogModel = AntigravityModelCatalog['models'][number]

function catalogModels(value: unknown): CatalogModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') return [{ id: item, enabled: true }]
    if (item && typeof item === 'object' && typeof item.id === 'string')
      return [item as CatalogModel]
    return []
  })
}

export function AntigravityCatalog({
  platformTabs,
}: {
  platformTabs: ReactNode
}) {
  const qc = useQueryClient()
  const routing = useQuery(routingQueryOptions())
  const [qtext, setQtext] = useState('')
  const config = (routing.data?.antigravity || {}) as Record<string, unknown>
  const platformOn = config.enabled === true
  const models = catalogModels(config.models)
  const enabledCount = models.filter((m) => m.enabled !== false).length
  const needle = qtext.trim().toLowerCase()
  const visible = needle
    ? models.filter((m) =>
        [m.id, m.display_name, m.vendor].some((v) =>
          v?.toLowerCase().includes(needle)
        )
      )
    : models
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({ antigravity: patch }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['panel', 'routing'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'models'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'vm'] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const setEnabled = (pick: (model: CatalogModel) => boolean) =>
    save.mutate({
      models: models.map((m) => ({ ...m, enabled: pick(m) })),
    })

  return (
    <div className='space-y-4'>
      <section className='rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
        <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end'>
          <div className='min-w-0 space-y-3'>
            {platformTabs}
            <div className='max-w-3xl space-y-1'>
              <h3 className='text-xl font-semibold tracking-tight'>
                Antigravity 官方模型矩阵
              </h3>
              <p className='text-sm leading-6 text-muted-foreground'>
                Antigravity 号池。直接使用官方模型 ID；同名 Claude / GPT
                模型需使用 antigravity 分组密钥调用，推理强度通过请求参数选择。
              </p>
            </div>
            <div className='flex items-center gap-2'>
              <Switch
                id='agy-catalog-enabled'
                checked={platformOn}
                disabled={!routing.data || save.isPending}
                onCheckedChange={(on) => save.mutate({ enabled: on })}
              />
              <Label htmlFor='agy-catalog-enabled'>
                启用 Antigravity API 接入
              </Label>
            </div>
          </div>
          <div className='grid grid-cols-3 gap-2 lg:w-[21rem]'>
            <Stat label='配置' value={models.length} />
            <Stat label='启用' value={enabledCount} />
            <Stat label='对外' value={platformOn ? enabledCount : 0} />
          </div>
        </div>
      </section>

      <section className='rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
        <AntigravityModelSync />
      </section>

      <QueryGate loading={routing.isLoading} error={routing.error}>
        <section className='rounded-2xl border border-border/70 bg-card p-3 shadow-sm'>
          <div className='grid gap-2 lg:grid-cols-[18rem_minmax(0,1fr)_auto] lg:items-center'>
            <Input
              className='w-full'
              type='search'
              placeholder='搜索模型…'
              aria-label='搜索 Antigravity 模型'
              value={qtext}
              onChange={(e) => setQtext(e.target.value)}
            />
            <span />
            <div className='flex flex-wrap gap-1.5 lg:justify-end'>
              <Button
                size='sm'
                variant='ghost'
                disabled={!models.length || save.isPending}
                onClick={() => setEnabled(() => true)}
              >
                全开
              </Button>
              <Button
                size='sm'
                variant='ghost'
                disabled={!models.length || save.isPending}
                onClick={() => setEnabled(() => false)}
              >
                全关
              </Button>
            </div>
          </div>
        </section>
        {visible.length ? (
          <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-3'>
            {visible.map((m) => {
              const on = m.enabled !== false
              const name = m.display_name || m.id
              return (
                <div
                  key={m.id}
                  className={cn(
                    'rounded-xl border border-border/70 bg-card p-3 text-sm shadow-sm',
                    !on && 'opacity-65'
                  )}
                >
                  <div className='flex items-start gap-3'>
                    <div className='mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-muted/70 ring-1 ring-border/60'>
                      <ModelVendorIcon modelId={m.id} className='size-5' />
                    </div>
                    <div className='min-w-0 flex-1'>
                      <div className='flex flex-wrap items-center gap-2'>
                        <h3 className='truncate text-base font-semibold tracking-tight'>
                          {name}
                        </h3>
                        <Badge
                          variant={on && platformOn ? 'default' : 'secondary'}
                        >
                          {on && platformOn ? '对外' : '隐藏'}
                        </Badge>
                      </div>
                      <p className='mt-1 truncate font-mono text-[11px] text-muted-foreground'>
                        {m.id}
                      </p>
                    </div>
                    <div className='flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-2 py-1.5'>
                      <Checkbox
                        checked={on}
                        disabled={save.isPending}
                        onCheckedChange={(value) =>
                          setEnabled((row) =>
                            row.id === m.id
                              ? value === true
                              : row.enabled !== false
                          )
                        }
                        aria-label={`启用 ${name}`}
                      />
                      <span className='text-xs text-muted-foreground'>
                        启用
                      </span>
                    </div>
                  </div>
                  <div className='mt-3 flex flex-wrap gap-1.5'>
                    {m.vendor ? (
                      <Badge variant='outline'>{m.vendor}</Badge>
                    ) : null}
                    {m.levels?.length ? (
                      m.levels.map((level) => (
                        <Badge key={level} variant='secondary'>
                          {level}
                        </Badge>
                      ))
                    ) : (
                      <span className='text-xs text-muted-foreground'>
                        无推理档位
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            reason={
              needle
                ? '无匹配模型。改搜索条件。'
                : '暂无模型。从已授权槽位同步账号模型，新模型会自动加入并启用。'
            }
          />
        )}
      </QueryGate>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className='rounded-xl border border-border/70 bg-background/60 px-3 py-2'>
      <div className='text-[11px] font-medium tracking-wide text-muted-foreground'>
        {label}
      </div>
      <div className='field-count mt-1 text-lg font-semibold'>{value}</div>
    </div>
  )
}
