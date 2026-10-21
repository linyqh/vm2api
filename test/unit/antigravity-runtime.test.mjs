import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  antigravityRuntimeSupport,
  antigravityBridgeStatus,
  ensureAntigravityBridge,
  runAntigravityText,
  stopAntigravityBridge,
  writeAntigravityBridgeConfig,
} from '../../src/lib/transport/antigravity-bridge-supervisor.mjs'
import { antigravityBridgePaths } from '../../src/lib/transport/antigravity-bridge-client.mjs'
import { startAntigravityBridge } from '../../scripts/antigravity-bridge.mjs'
import {
  resolveInferenceEngine,
  resolveKernelDataplane,
  resolveOfficialCcInference,
} from '../../src/lib/vm/slot-engine.mjs'
import {
  ensureSlotInferenceRuntime,
  startSlotReady,
  switchSlotInferenceEngine,
} from '../../src/lib/vm/slot-runtime.mjs'
import {
  ANTIGRAVITY_SLOT_ROLE,
  slotContainerCommand,
  slotKernelAlive,
  slotWorkerNeedsRecreate,
  startVmRuntime,
  writeWorkerFiles,
} from '../../src/lib/vm/vm-runtime.mjs'
import { diagnoseSlotServices, powerOnSlot } from '../../src/lib/vm/slot-recovery.mjs'
import {
  panelAntigravityShellLaunch,
  createSlotShell,
  preparePanelShellLogin,
  adoptShellLogin,
  adoptLiveShellLogin,
} from '../../src/lib/vm/slot-shell.mjs'

const vm = {
  id: 'vm-ag',
  platform: 'antigravity',
  proxy: { id: 'px-test', host: '127.0.0.1', port: 1080 },
  runtime: { type: 'docker' },
}
const routing = { antigravity: { enabled: true, models: ['model-a'] } }
function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('Antigravity never resolves Claude engine or starts its kernel PID1', async () => {
  assert.equal(resolveInferenceEngine(vm, { inference: { engine: 'rust' } }), null)
  assert.equal(resolveKernelDataplane(vm), null)
  assert.equal(resolveOfficialCcInference(vm), null)
  assert.deepEqual(slotContainerCommand(vm, { wrapKernel: true }), ['sleep', 'infinity'])
  const paths = { kernelSocket: '/nonexistent/kernel.sock' }
  const healthy = { running: true, role: ANTIGRAVITY_SLOT_ROLE, networkMode: 'kin-eg-px-test' }
  assert.equal(slotKernelAlive(healthy, paths, vm), true)
  assert.equal(slotWorkerNeedsRecreate(healthy, vm, paths), false)
  assert.equal(slotWorkerNeedsRecreate({ ...healthy, role: '' }, vm, paths), true)
  const result = await switchSlotInferenceEngine(vm, '/unused', 'rust')
  assert.equal(result.code, 'antigravity_engine_forbidden')
})

test('Antigravity rejects KVM, remote slots and missing egress before any runtime launch', async (t) => {
  const root = rootFor(t)
  for (const bad of [
    { ...vm, node_id: 'remote' },
    { ...vm, runtime: { type: 'kvm' } },
    { ...vm, proxy: null },
  ]) {
    assert.equal(antigravityRuntimeSupport(bad).ok, false)
    const result = await startVmRuntime(bad, root, { routing })
    assert.equal(result.ok, false)
    assert.equal(fs.existsSync(path.join(root, 'vms')), false)
  }
  assert.equal((await startVmRuntime(vm, root)).code, 'antigravity_disabled')
})

test('worker preparation writes only separate bridge config and a tool-free custom agent', (t) => {
  const root = rootFor(t)
  const paths = writeWorkerFiles(vm, root, { routing })
  assert.equal(paths.worker, 'antigravity')
  assert.match(paths.socket, /antigravity.sock$/)
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'))
  assert.equal(config.socket_path, '/run/kin/antigravity.sock')
  assert.equal(config.cli_bin, 'agy')
  assert.equal(config.max_sessions, 1)
  assert.equal(fs.statSync(paths.token).mode & 0o777, 0o600)
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  assert.equal(fs.existsSync(path.join(home, '.claude')), false)
  assert.equal(fs.existsSync(path.join(paths.runDir, 'kernel.json')), false)
  assert.equal(fs.existsSync(path.join(paths.runDir, 'worker.json')), false)
  const agent = fs.readFileSync(
    path.join(home, '.kin', 'antigravity-workspace', '.agents', 'agents', 'vm2api-text.md'),
    'utf8',
  )
  assert.match(agent, /tools: \[\]/)
  assert.match(agent, /commandExecutionPolicy: "off"/)
  assert.match(agent, /subagent: false/)
})

test('AG starts its own bridge while a missing bridge dependency keeps the shell container available', async () => {
  const result = await startSlotReady(vm, '/unused', {
    routing,
    ops: {
      startSlot: async () => ({ ok: true, action: 'started', runtime: { worker: 'antigravity' } }),
      ensureAntigravityBridge: async () => ({ ok: false, code: 'antigravity_node_unavailable' }),
      ensureRustKernel: () => {
        throw new Error('Claude kernel must not start')
      },
      materializeWrapCli: () => {
        throw new Error('Claude sample must not materialize')
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.antigravity_ready, false)
  assert.equal(result.antigravity.code, 'antigravity_node_unavailable')
  assert.equal(
    (
      await ensureSlotInferenceRuntime(vm, '/unused', {
        routing,
        ops: { ensureAntigravityBridge: async () => ({ ok: true }) },
      })
    ).engine,
    'antigravity',
  )
})

test('status is a nonstarting probe and text forwarding preserves session cancellation', async (t) => {
  const root = rootFor(t)
  const status = await antigravityBridgeStatus({ projectRoot: root, vm, routing })
  assert.equal(status.ready, false)
  assert.equal(status.authenticated, null)
  assert.equal(fs.existsSync(path.join(root, 'vms')), false)
  let call
  const controller = new AbortController()
  const onText = () => {}
  const forwarded = await runAntigravityText({
    projectRoot: root,
    vm,
    routing,
    model: 'model-a',
    prompt: 'hello',
    sessionId: 'scoped-session',
    signal: controller.signal,
    onText,
    ops: {
      ensureBridge: async () => ({ ok: true }),
      callBridge: async (options) => {
        call = options
        return { ok: true, response: 'done' }
      },
    },
  })
  assert.equal(forwarded.response, 'done')
  assert.deepEqual(call.body, { model: 'model-a', prompt: 'hello', session_id: 'scoped-session' })
  assert.equal(call.signal, controller.signal)
  assert.equal(call.onText, onText)
})

test('supervisor verifies container network and executes only a Docker-local bridge', async (t) => {
  const root = rootFor(t)
  const source = path.join(root, 'linux-node')
  fs.writeFileSync(source, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  let bridge
  let launch
  t.after(async () => {
    await stopAntigravityBridge(root, vm)
    await bridge?.close()
  })
  const result = await ensureAntigravityBridge({
    projectRoot: root,
    vm,
    routing,
    ops: {
      nodeSource: source,
      execFile: async (command, args) => {
        assert.equal(command, 'docker')
        assert.equal(args[0], 'inspect')
        return { stdout: 'true|kin-eg-px-test' }
      },
      spawn: (command, args, options) => {
        launch = { command, args, options }
        const paths = antigravityBridgePaths(root, vm)
        const config = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'))
        void startAntigravityBridge(
          { ...config, socket_path: paths.socketPath },
          { pool: { size: 0, close() {} } },
        ).then((started) => {
          bridge = started
        })
        return new EventEmitter()
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(launch.command, 'docker')
  assert.deepEqual(launch.args, [
    'exec',
    'kin-ag',
    '/home/kincli/.kin/antigravity-node',
    '/home/kincli/.kin/antigravity-bridge.mjs',
    '--config',
    '/run/kin/antigravity.json',
  ])
  assert.equal(launch.options.shell, false)
  const again = await ensureAntigravityBridge({
    projectRoot: root,
    vm,
    routing: { antigravity: { ...routing.antigravity, max_sessions: 2 } },
    ops: { execFile: async () => ({ stdout: 'true|kin-eg-px-test' }) },
  })
  assert.equal(again.code, 'antigravity_runtime_reload_required')
})

test('diagnostics use AG bridge status and power-on never enables API scheduling', async (t) => {
  const root = rootFor(t)
  const record = { ...vm, status: 'running' }
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(record))
  const diagnostics = await diagnoseSlotServices(record, {
    projectRoot: root,
    routing,
    probes: {
      container: async () => ({ running: true }),
      socksEgress: () => ({ ok: true }),
      antigravityHealth: async () => ({ ok: true }),
      rustHealth: () => {
        throw new Error('Claude readiness must not run')
      },
    },
  })
  assert.equal(diagnostics.engine, 'antigravity')
  assert.equal(diagnostics.checks.find((row) => row.id === 'credential').code, 'antigravity_auth_unknown')
  assert.equal(diagnostics.checks.find((row) => row.id === 'kernel').status, 'ok')
  const started = await powerOnSlot({
    projectRoot: root,
    id: vm.id,
    routing,
    proxyPool: { ensureBoundToVm: () => vm.proxy },
    fillTimezone: async () => {},
    ops: { startSlotReady: async () => ({ ok: true, runtime: vm.runtime }) },
  })
  assert.equal(started.ok, true)
  assert.equal(started.vm.schedulable, false)
  assert.equal(started.vm.schedule_disabled_reason, 'experimental_text_only')
})

test('AG shell is plain and rejects Claude credential/login workflows before writes', async (t) => {
  const root = rootFor(t)
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  const launch = panelAntigravityShellLaunch()
  assert.match(launch.rc, /系统特征/)
  assert.doesNotMatch(launch.rc, /CLAUDE|\.claude|cli-node|claude\(\)/)
  let authCalls = 0
  const shell = createSlotShell({
    projectRoot: root,
    authLoginReady: async () => {
      authCalls++
    },
  })
  assert.equal((await shell.issueTicket(vm.id)).ok, true)
  assert.equal((await shell.issueTicket(vm.id, { login: true })).error.code, 'platform_login_not_supported')
  assert.equal(authCalls, 0)
  await assert.rejects(preparePanelShellLogin(root, vm), { code: 'platform_login_not_supported' })
  await assert.rejects(adoptShellLogin(root, vm), { code: 'platform_login_not_supported' })
  assert.equal((await adoptLiveShellLogin(root, vm)).imported, false)
  assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'cli-home', '.claude')), false)
})
