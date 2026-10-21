# Antigravity 验证记录

日期：2026-10-21。基线：`eee8f6ec`。环境：macOS，Node.js 22.23.3。

## 本次变更

- 5 个新增 Antigravity 测试文件，38 项通过，覆盖平台/模型/密钥隔离、面板权限、输入能力限制、持久会话、usage 差值、取消、回收、工具拒绝、真实 Unix socket 与 Docker 调用边界。
- 后端相关 20 个文件共 341 项通过，包括上述新增测试，以及创建槽位、租户 ACL、数据库镜像、凭证、模型、原生账号池、count_tokens、健康探测、计划测试及运行时回归。
- 前端 60 个文件、479 项测试通过；TypeScript 检查、Vite 生产构建通过。最后的会话恢复与隐藏活跃账号入口修改另已通过 TypeScript 检查。
- 所有修改的 49 个 JavaScript 模块通过语法检查和 Biome 格式检查，`git diff --check` 通过。

可运行：

```sh
node --test test/unit/antigravity-platform.test.mjs test/unit/antigravity-isolation.test.mjs test/unit/antigravity-panel.test.mjs test/unit/antigravity-bridge.test.mjs test/unit/antigravity-runtime.test.mjs
```

测试使用假的官方 CLI 子进程和本地 Unix socket；未使用真实 Google 账号或发送上游推理请求。

## 全量检查的既有失败

完整后端检查执行了 276 个测试文件。以下 9 个文件的失败，在单独解压、未修改的 HEAD 上均同名复现，未发现这些失败与本次变更有关；共 17 个顶层失败，另有 3 个嵌套失败条目：

| 文件 | 主要限制或既有差异 |
| --- | --- |
| `cli-hop-body.test.mjs` | 已有缓存 TTL 断言差异 |
| `convert-cache-shape.test.mjs` | 已有缓存形状/TTL 断言差异 |
| `egress.test.mjs` | 当前环境缺少 `bin/kin-egress` |
| `guest-identity-reader.test.mjs` | Linux guest 命令与宿主机差异 |
| `host-path.test.mjs` | 既有容器路径探测断言 |
| `oauth-binary.test.mjs` | 当前环境的 OAuth binary 条件未满足 |
| `session-oauth-seam.test.mjs` | 当前环境的 OAuth binary 条件未满足 |
| `slot-recovery.test.mjs` | macOS 残留 socket 路径返回 `ENOTSOCK`，旧实现预期 Linux 错误码 |
| `slot-shell-rc.test.mjs` | Linux `/proc` 核数探测在 macOS 返回 unknown |

基线对照与本次相关回归分别记录于运行环境的 `/tmp/vm2api-ag-baseline-comparison.log`、`/tmp/vm2api-antigravity-final-tests.log`。没有为消除既有失败修改无关的产品行为。Go 工具链未安装，未运行 Go 测试；本次没有修改 Go 代码。

## 仍需真实环境验收

官方 `agy` 未安装，因此尚未验证官方登录、keyring/DBus 持久化、实际 headless 事件、专用 agent 加载、槽位出口和真实多轮推理。功能保持默认关闭，安装与启用步骤见 [ANTIGRAVITY.md](ANTIGRAVITY.md)。通用 API、工具回传、多模态和生产计费尚未开放。
