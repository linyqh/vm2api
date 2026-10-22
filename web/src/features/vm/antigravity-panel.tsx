import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  ANTIGRAVITY_REASONING_LEVELS,
  antigravityModelsFromIds,
} from '@/features/settings/antigravity-models'
import { routingQueryOptions } from '@/features/settings/queries'
import { useVmPerms } from '@/features/vm/vm-perms'
import {
  AntigravityModelSync,
  type AntigravityModelCatalog,
  type AntigravityReasoningLevel,
} from './antigravity-model-sync'

export type AntigravityStatus = {
  enabled?: boolean
  ready?: boolean
  authenticated?: boolean | null
  models?: {
    id: string
    display_name?: string
    levels?: AntigravityReasoningLevel[]
  }[]
  model_catalog?: AntigravityModelCatalog | null
  runtime?: { supported?: boolean }
  error?: string | { code?: string; message?: string } | null
  message?: string
}

export type AntigravityChatResult = {
  ok: boolean
  text: string
  session_id: string
  usage?: Record<string, unknown> | null
}

function antigravityStatusQueryOptions(id: string) {
  return {
    queryKey: ['panel', 'vm', id, 'antigravity'] as const,
    queryFn: () =>
      api<AntigravityStatus>(
        `/api/panel/vms/${encodeURIComponent(id)}/antigravity/status`
      ),
    retry: false,
  }
}

export function AntigravityPanel({
  vm,
  showSettings = true,
}: {
  vm: Vm
  showSettings?: boolean
}) {
  return (
    <AntigravityPanelContent key={vm.id} vm={vm} showSettings={showSettings} />
  )
}

function AntigravityPanelContent({
  vm,
  showSettings,
}: {
  vm: Vm
  showSettings: boolean
}) {
  const perms = useVmPerms()
  const qc = useQueryClient()
  const status = useQuery({
    ...antigravityStatusQueryOptions(vm.id),
    enabled: perms.credential || perms.test,
  })
  const sessionKey = ['panel', 'vm', vm.id, 'antigravity-text-session'] as const
  const [model, setModel] = useState(
    () => qc.getQueryData<{ model: string }>(sessionKey)?.model || ''
  )
  const [prompt, setPrompt] = useState('')
  const [session, setSession] = useState(
    () => qc.getQueryData<{ session_id: string }>(sessionKey)?.session_id || ''
  )
  const [result, setResult] = useState<AntigravityChatResult | null>(null)
  const [failure, setFailure] = useState('')
  const enabledIds = new Set((status.data?.models || []).map((m) => m.id))
  const models = [
    ...(status.data?.models || []),
    ...(status.data?.model_catalog?.models || []),
  ].filter((m, i, all) => all.findIndex((o) => o.id === m.id) === i)
  const selected =
    model || models.find((m) => enabledIds.has(m.id))?.id || models[0]?.id || ''
  const chat = useMutation({
    mutationFn: (request: {
      model: string
      prompt: string
      session_id: string
    }) =>
      api<AntigravityChatResult>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/antigravity/chat`,
        {
          method: 'POST',
          body: JSON.stringify(request),
        }
      ),
    onSuccess: (data, request) => {
      const sessionId = data.session_id || request.session_id
      setResult(data)
      setSession(sessionId)
      setModel(request.model)
      qc.setQueryData(sessionKey, {
        model: request.model,
        session_id: sessionId,
      })
      setFailure('')
      void qc.invalidateQueries({
        queryKey: antigravityStatusQueryOptions(vm.id).queryKey,
      })
    },
    onError: (error: Error) => {
      setFailure(`${error.message}。可重试当前会话，或关闭后新建会话。`)
      setResult(null)
    },
  })
  const close = useMutation({
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/antigravity/close`, {
        method: 'POST',
        body: JSON.stringify({ session_id: session }),
      }),
    onSuccess: () => {
      setSession('')
      setResult(null)
      setFailure('')
      qc.removeQueries({ queryKey: sessionKey, exact: true })
    },
    onError: (error: Error) => setFailure(error.message),
  })
  const busy = chat.isPending || close.isPending
  const runtimeError = status.data?.error
  const message =
    status.error?.message ||
    status.data?.message ||
    (typeof runtimeError === 'string' ? runtimeError : runtimeError?.message)
  return (
    <div className='space-y-3'>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>
            Antigravity · 账号与 API 状态
          </CardTitle>
        </CardHeader>
        <CardContent className='space-y-3 pt-0'>
          <p className='text-sm text-muted-foreground'>
            使用槽内官方 Antigravity 客户端完成账号登录。
            授权后同步账号模型，启用平台并开启槽位调度即可使用 API。
          </p>
          <p className='text-xs text-muted-foreground'>
            支持 Messages、Chat Completions 与 Responses API，直接使用官方模型
            ID；推理强度通过请求参数选择。
          </p>
          <dl className='grid grid-cols-2 gap-2 text-sm'>
            <dt className='text-muted-foreground'>平台</dt>
            <dd>
              {status.isPending
                ? '检查中'
                : status.data
                  ? status.data.enabled
                    ? '已启用'
                    : '未启用'
                  : '尚未确认'}
            </dd>
            <dt className='text-muted-foreground'>运行时</dt>
            <dd>
              {status.data?.runtime?.supported === false
                ? '当前槽位不支持'
                : status.data?.ready
                  ? '就绪'
                  : '未就绪'}
            </dd>
            <dt className='text-muted-foreground'>账号登录</dt>
            <dd>
              {status.data?.authenticated === true
                ? '已登录'
                : status.data?.authenticated === false
                  ? '未登录'
                  : '尚未确认'}
            </dd>
          </dl>
          <p className='text-xs text-muted-foreground'>
            账号模型：{status.data?.model_catalog?.models.length ?? 0} 个
            {status.data?.model_catalog?.updated_at
              ? ` · 同步于 ${new Date(status.data.model_catalog.updated_at).toLocaleString()}`
              : ' · 尚未同步'}
          </p>
          {perms.credential ? <AntigravityModelSync vmId={vm.id} /> : null}
          {message ? (
            <p role='status' className='text-sm text-muted-foreground'>
              {message}
            </p>
          ) : null}
          <p className='text-xs text-muted-foreground'>
            仅支持本机 Docker。账号凭证由槽内官方客户端保存，使用账号页的 OAuth
            完成绑定。
          </p>
          <Button
            size='sm'
            variant='outline'
            loading={status.isFetching}
            onClick={() => void status.refetch()}
          >
            检查状态
          </Button>
        </CardContent>
      </Card>
      {perms.test ? (
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm'>纯文本测试</CardTitle>
          </CardHeader>
          <CardContent className='space-y-3 pt-0'>
            <div className='space-y-1'>
              <Label htmlFor={`agy-model-${vm.id}`}>模型 ID</Label>
              <select
                id={`agy-model-${vm.id}`}
                className='h-9 w-full rounded-md border bg-background px-3 text-sm'
                value={selected}
                disabled={busy || !!session || !models.length}
                onChange={(e) => {
                  setModel(e.target.value)
                  setResult(null)
                }}
              >
                {!models.length ? (
                  <option value=''>暂无模型，请先同步账号模型</option>
                ) : null}
                {selected && !models.some((m) => m.id === selected) ? (
                  <option value={selected}>{selected}</option>
                ) : null}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name && m.display_name !== m.id
                      ? `${m.display_name} (${m.id})`
                      : m.id}
                    {enabledIds.has(m.id) ? '' : ' · 未在全局目录启用'}
                  </option>
                ))}
              </select>
              {selected && !enabledIds.has(selected) ? (
                <p className='text-xs text-muted-foreground'>
                  该模型尚未在全局目录启用，发送会被拒绝。请管理员在模型页
                  Antigravity 分区启用。
                </p>
              ) : null}
            </div>
            <div className='space-y-1'>
              <Label htmlFor={`agy-prompt-${vm.id}`}>消息</Label>
              <Textarea
                id={`agy-prompt-${vm.id}`}
                value={prompt}
                disabled={busy}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            {session ? (
              <p className='text-xs break-all text-muted-foreground'>
                当前会话：{session}
              </p>
            ) : null}
            <div className='flex gap-2'>
              <Button
                disabled={
                  busy ||
                  !status.data?.enabled ||
                  status.data?.runtime?.supported === false ||
                  !selected.trim() ||
                  !prompt.trim()
                }
                loading={chat.isPending}
                onClick={() => {
                  const sessionId = session || crypto.randomUUID()
                  const selectedModel = selected.trim()
                  setSession(sessionId)
                  setModel(selectedModel)
                  qc.setQueryData(sessionKey, {
                    model: selectedModel,
                    session_id: sessionId,
                  })
                  setFailure('')
                  chat.mutate({
                    model: selectedModel,
                    prompt,
                    session_id: sessionId,
                  })
                }}
              >
                {session ? '继续会话' : '发送'}
              </Button>
              <Button
                variant='outline'
                disabled={busy || !session}
                loading={close.isPending}
                onClick={() => close.mutate()}
              >
                关闭并新建会话
              </Button>
            </div>
            {failure ? (
              <p role='alert' className='text-sm text-destructive'>
                {failure}
              </p>
            ) : null}
            {result ? (
              <div className='space-y-2 rounded-md border p-3'>
                <p className='text-sm break-words whitespace-pre-wrap'>
                  {result.text}
                </p>
                {result.usage ? (
                  <pre className='overflow-x-auto text-xs text-muted-foreground'>
                    {JSON.stringify(result.usage, null, 2)}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {showSettings && perms.admin ? <AntigravitySettings /> : null}
    </div>
  )
}

export function AntigravitySettings() {
  const qc = useQueryClient()
  const routing = useQuery(routingQueryOptions())
  const [enabled, setEnabled] = useState(false)
  const [cli, setCli] = useState('agy')
  const [models, setModels] = useState('')
  const [levels, setLevels] = useState<
    Record<string, AntigravityReasoningLevel[]>
  >({})
  useEffect(() => {
    if (!routing.data) return
    const value = (routing.data.antigravity || {}) as Record<string, unknown>
    setEnabled(value.enabled === true)
    setCli(typeof value.cli_bin === 'string' ? value.cli_bin : 'agy')
    setModels(
      Array.isArray(value.models)
        ? value.models
            .map((m: string | { id?: string }) =>
              typeof m === 'string' ? m : m.id || ''
            )
            .filter(Boolean)
            .join('\n')
        : ''
    )
    const nextLevels: Record<string, AntigravityReasoningLevel[]> = {}
    if (Array.isArray(value.models)) {
      for (const m of value.models) {
        if (
          m &&
          typeof m === 'object' &&
          typeof (m as { id?: unknown }).id === 'string' &&
          Array.isArray((m as { levels?: unknown }).levels)
        ) {
          const item = m as { id: string; levels: unknown[] }
          nextLevels[item.id] = item.levels.filter(
            (level): level is AntigravityReasoningLevel =>
              ANTIGRAVITY_REASONING_LEVELS.includes(
                level as AntigravityReasoningLevel
              )
          )
        }
      }
    }
    setLevels(nextLevels)
  }, [routing.data])
  const modelIds = [
    ...new Set(
      models
        .split('\n')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ]
  const toggleLevel = (
    id: string,
    level: AntigravityReasoningLevel,
    checked: boolean
  ) => {
    setLevels((prev) => {
      const current = prev[id] || []
      const next = checked
        ? ANTIGRAVITY_REASONING_LEVELS.filter(
            (item) => current.includes(item) || item === level
          )
        : current.filter((item) => item !== level)
      return { ...prev, [id]: next }
    })
  }
  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({
          antigravity: {
            ...((routing.data?.antigravity || {}) as Record<string, unknown>),
            enabled,
            cli_bin: cli.trim() || 'agy',
            models: antigravityModelsFromIds(
              (routing.data?.antigravity as Record<string, unknown> | undefined)
                ?.models,
              models,
              levels
            ),
          },
        }),
      }),
    onSuccess: () => {
      toast.success('Antigravity 配置已保存')
      void qc.invalidateQueries({ queryKey: ['panel', 'routing'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'vm'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'models'] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>Antigravity 平台设置</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3 pt-0'>
        <p className='text-xs text-muted-foreground'>
          此配置作用于全部 Antigravity
          槽位，默认关闭。先从已授权槽位同步模型，再启用 API 接入。
        </p>
        {routing.error ? (
          <p role='alert' className='text-sm text-destructive'>
            {routing.error.message}
          </p>
        ) : null}
        <div className='flex items-center justify-between'>
          <Label htmlFor='agy-enabled'>启用 Antigravity API 接入</Label>
          <Switch
            id='agy-enabled'
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
        <AntigravityModelSync />
        <div className='space-y-1'>
          <Label htmlFor='agy-cli'>槽内客户端路径</Label>
          <Input
            id='agy-cli'
            value={cli}
            onChange={(e) => setCli(e.target.value)}
          />
        </div>
        <div className='space-y-1'>
          <Label htmlFor='agy-models'>模型 ID，每行一个</Label>
          <Textarea
            id='agy-models'
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
        </div>
        {modelIds.length ? (
          <div className='space-y-2'>
            <Label>推理强度（levels）</Label>
            <div className='space-y-1.5 rounded-md border p-2'>
              {modelIds.map((id) => {
                const active = levels[id] || []
                return (
                  <div
                    key={id}
                    className='flex flex-wrap items-center justify-between gap-2 text-xs'
                  >
                    <span className='font-mono break-all'>{id}</span>
                    <div className='flex flex-wrap gap-3'>
                      {ANTIGRAVITY_REASONING_LEVELS.map((level) => (
                        <div key={level} className='flex items-center gap-1'>
                          <Checkbox
                            id={`agy-level-${id}-${level}`}
                            checked={active.includes(level)}
                            onCheckedChange={(checked) =>
                              toggleLevel(id, level, checked === true)
                            }
                          />
                          <Label
                            htmlFor={`agy-level-${id}-${level}`}
                            className='text-xs font-normal'
                          >
                            {level}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
        <Button
          size='sm'
          disabled={!routing.data || save.isPending}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          保存平台配置
        </Button>
      </CardContent>
    </Card>
  )
}
