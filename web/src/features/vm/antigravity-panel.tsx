import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { routingQueryOptions } from '@/features/settings/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export type AntigravityStatus = {
  enabled?: boolean
  ready?: boolean
  authenticated?: boolean | null
  models?: { id: string; display_name?: string }[]
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
  const models = status.data?.models || []
  const selected = model || models[0]?.id || ''
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
          <CardTitle className='text-sm'>Antigravity · 实验文本会话</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3 pt-0'>
          <p className='text-sm text-muted-foreground'>
            使用槽内官方 Antigravity
            客户端登录。当前支持显式会话的纯文本测试；完整历史、system、图片和外部工具调用尚未开放。
          </p>
          <p className='text-xs text-muted-foreground'>
            通用 /v1 Messages、Chat Completions 与 Responses API
            暂不支持此平台。
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
          {message ? (
            <p role='status' className='text-sm text-muted-foreground'>
              {message}
            </p>
          ) : null}
          <p className='text-xs text-muted-foreground'>
            仅支持本机
            Docker。请先配置官方客户端与独立凭证存储，再在运维终端运行官方登录流程；凭证由客户端管理。
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
              <Input
                id={`agy-model-${vm.id}`}
                value={selected}
                disabled={busy || !!session}
                onChange={(e) => {
                  setModel(e.target.value)
                  setResult(null)
                }}
                list={`agy-models-${vm.id}`}
              />
              <datalist id={`agy-models-${vm.id}`}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name || m.id}
                  </option>
                ))}
              </datalist>
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

function AntigravitySettings() {
  const qc = useQueryClient()
  const routing = useQuery(routingQueryOptions())
  const [enabled, setEnabled] = useState(false)
  const [cli, setCli] = useState('agy')
  const [models, setModels] = useState('')
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
  }, [routing.data])
  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({
          antigravity: {
            ...((routing.data?.antigravity || {}) as Record<string, unknown>),
            enabled,
            cli_bin: cli.trim() || 'agy',
            models: [
              ...new Set(
                models
                  .split('\n')
                  .map((id) => id.trim())
                  .filter(Boolean)
              ),
            ],
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
          此配置作用于全部 Antigravity 槽位，默认关闭。模型 ID
          以该账号实际可用目录为准。
        </p>
        {routing.error ? (
          <p role='alert' className='text-sm text-destructive'>
            {routing.error.message}
          </p>
        ) : null}
        <div className='flex items-center justify-between'>
          <Label htmlFor='agy-enabled'>启用实验文本接入</Label>
          <Switch
            id='agy-enabled'
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
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
