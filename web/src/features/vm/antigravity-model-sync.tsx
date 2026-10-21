import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { isAntigravityVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { antigravityModelSyncRequest } from './antigravity-model-sync-api'
import { vmsListQueryOptions } from './queries'

export type AntigravityModelCatalog = {
  updated_at: string
  models: { id: string; display_name?: string; enabled?: boolean }[]
}

export function AntigravityModelSync({
  vmId,
  publishGlobal = false,
}: {
  vmId?: string
  publishGlobal?: boolean
}) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState('')
  const vms = useQuery({ ...vmsListQueryOptions(), enabled: !vmId })
  const slots = (vms.data?.items || []).filter(
    (vm) => isAntigravityVm(vm) && vm.antigravity?.authenticated === true
  )
  const target = vmId || selected || slots[0]?.id || ''
  const sync = useMutation({
    mutationFn: async (id: string) => {
      const request = antigravityModelSyncRequest(id, publishGlobal)
      return api<AntigravityModelCatalog>(request.url, {
        method: 'POST',
        body: JSON.stringify(request.body),
      })
    },
    onSuccess: (data, id) => {
      toast.success(`已同步 ${data.models.length} 个账号可用模型`)
      void qc.invalidateQueries({ queryKey: ['panel', 'vm', id] })
      void qc.invalidateQueries({ queryKey: ['panel', 'vms'] })
      if (publishGlobal) {
        void qc.invalidateQueries({ queryKey: ['panel', 'routing'] })
        void qc.invalidateQueries({ queryKey: ['panel', 'models'] })
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <div className='space-y-2'>
      {!vmId ? (
        <div className='space-y-1'>
          <Label htmlFor='agy-model-sync-slot'>已授权槽位</Label>
          <select
            id='agy-model-sync-slot'
            className='h-9 w-full rounded-md border bg-background px-3 text-sm'
            value={target}
            onChange={(event) => setSelected(event.target.value)}
            disabled={sync.isPending || !slots.length}
          >
            {!slots.length ? <option value=''>暂无已授权槽位</option> : null}
            {slots.map((slot) => (
              <option key={slot.id} value={slot.id}>
                {slot.name || slot.id}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <Button
        size='sm'
        variant='outline'
        loading={sync.isPending}
        disabled={!target || sync.isPending}
        onClick={() => sync.mutate(target)}
      >
        {publishGlobal ? '同步账号模型并加入全局目录' : '同步账号模型'}
      </Button>
      <p className='text-xs text-muted-foreground'>
        读取槽内官方客户端的模型目录，不发送推理请求。
        {publishGlobal
          ? '保留全局已有模型的启停与显示设置。'
          : '仅更新当前槽位的可用模型。'}
      </p>
    </div>
  )
}
