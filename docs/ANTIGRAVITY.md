# Antigravity 实验接入

目前实现独立平台基础和官方 CLI 纯文本会话。功能默认关闭，仅支持本机 Docker 槽位；真实 `agy` 登录、Linux keyring 持久化与上游调用仍需在部署环境联调。

## 支持范围

| 能力 | 当前状态 |
| --- | --- |
| 独立槽位、平台筛选、密钥分组、模型目录 | 已实现 |
| 面板纯文本会话、同进程续聊、显式关闭 | 已实现，实验功能 |
| 超时、断连取消、会话容量及空闲回收 | 已实现 |
| 逐轮 usage | 从官方累计计数计算差值；计数缺失时返回 null |
| 通用 `/v1/messages`、Chat Completions、Responses | 明确拒绝，不进入 Claude/GPT 账号池 |
| system、任意历史导入、图片、调用方工具 | 暂不支持；不会压成 prompt 静默转发 |
| 自动登录、导入 token、配额及生产计费 | 暂未接入 |
| 远程节点、KVM | 暂不支持 |

模型使用 `antigravity/<官方模型 ID>` 命名空间。账号平台与模型厂商独立：即使模型由 Anthropic 提供，Antigravity 账号也不会进入 Claude 池。

## 部署步骤

1. 在控制台创建 Antigravity 槽位，绑定独立出口。默认保持停止。
2. 在 Antigravity 账号面板中配置并启用实验功能，录入账号实际可用的官方模型 ID。模型清单来自本地配置，不会借用 Claude/GPT 目录。
3. 启动槽位。容器可先启动供安装客户端；bridge 缺依赖时，其状态会单独显示。
4. 在普通运维终端内，按[官方安装与认证文档](https://antigravity.google/docs/install)安装 `agy` 并登录。将客户端及其数据放在持久挂载的 `/home/kincli` 内。容器根文件系统只读，安装位置应选择用户目录。
5. 将 `cli_bin` 配置为实际安装路径，例如 `/home/kincli/.local/bin/agy`。交互 shell 的 PATH 与 bridge 的非交互环境可能不同，建议使用绝对路径。
6. 确保 bridge 可用的 Linux Node 运行时与槽位架构、系统库兼容。Linux 控制面默认使用 `process.execPath`；macOS 控制面或控制面与槽位架构不同的部署，必须设置 `KIN_ANTIGRAVITY_NODE_BIN`，指向匹配槽位架构的 Linux Node 可执行文件。该文件会复制进槽位，macOS 的 Node 不能直接使用。
7. 检查状态并发送首条文本。`authenticated: null` 表示尚未确认登录状态；bridge 健康不等于已通过官方认证。成功收到终态文本后再验证续聊、关闭与重启后的登录持久化。

bridge 在槽位内执行 `agy`，不会在控制面运行官方客户端。认证由官方 CLI 与槽位内 keyring 管理；项目不读取或镜像 keyring 内容。无桌面环境的 keyring/DBus 准备方式须按实际官方客户端验证，不能以写入 `vm.json` token 代替。

配置保存于现有 routing 配置的独立字段：

```json
{
  "antigravity": {
    "enabled": false,
    "cli_bin": "/home/kincli/.local/bin/agy",
    "models": [
      {
        "id": "replace-with-official-model-id",
        "display_name": "账号实际可用的模型",
        "enabled": true
      }
    ],
    "max_sessions": 1,
    "idle_ttl_seconds": 600,
    "timeout_ms": 180000
  }
}
```

修改配置后重启相应槽位以应用 bridge 配置。关闭 `enabled` 会拒绝后续聊天请求，仍允许显式关闭旧会话；需要立即停止正在执行的请求时，应关闭会话或停止槽位。

## 面板接口

均沿用现有面板鉴权；普通用户只可操作自己的槽位，super 角色只读。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/panel/vms/:id/antigravity/status` | 只读检查，不启动 CLI |
| `POST /api/panel/vms/:id/antigravity/chat` | 发送 `{model,prompt,session_id}` |
| `POST /api/panel/vms/:id/antigravity/close` | 关闭 `{session_id}`，即使平台已禁用也可清理 |

成功响应沿用 `{ok:true,data:{...}}`，聊天数据包含 `text`、`session_id`、`usage`、`usage_cumulative` 和 `terminalState`。错误返回 HTTP 4xx/5xx 与 `{ok:false,error:{code,message}}`。

首次发送前生成并保留 `session_id`，续聊时原样发送；模型在会话内固定。会话按面板用户和槽位隔离，同一会话只允许一轮执行。请求失败后可以重试，或显式关闭后创建新会话；不能假定失败意味着旧进程已关闭。已回收的会话会返回 `antigravity_session_closed`，需关闭后换用新 ID。进程上下文不跨槽位/bridge 重启持久化，重启后应新建会话。

## 执行结构

```mermaid
flowchart LR
    Panel[面板鉴权与所属校验] --> Check[文本与模型白名单校验]
    Check --> Supervisor[独立 bridge supervisor]
    Supervisor --> UDS[槽位 Unix socket 与内部 token]
    UDS --> CLI[槽位内官方 agy 进程]
    CLI --> Result[校验终态与累计 usage]
    Result --> Panel
```

每个会话持有一个 CLI 进程，使用官方 [stream-json headless 协议](https://antigravity.google/docs/cli/headless/)。bridge 创建专用无工具 agent，并在收到匹配 agent/model 且 `tools: []` 的 init 后才发送用户消息。遇到工具步骤、协议异常或缺失终态会失败，不将部分输出作为成功回复。上游 stdout/stderr 不作为登录凭证日志保存。

Claude 的凭证刷新、配额探测、计划测试、目录同步、遥测和 kernel 配置均跳过 Antigravity。数据库只镜像 Antigravity email 等展示元数据，秘密仍由官方客户端管理。

## 验证与后续

自动测试使用假的 CLI 子进程与真实本地 Unix socket，覆盖事件解析、续聊、累计计数差值、并发互斥、空闲回收、取消、终态缺失、工具拒绝、面板租户权限及原生池隔离。它们不替代真实客户端验收。

下一阶段先完成部署环境的官方登录、出口及 keyring 验证，再评估完整历史、system、多模态和工具回传所需的数据面；通过能力验证后才开放通用 API、自动调度与计费。
