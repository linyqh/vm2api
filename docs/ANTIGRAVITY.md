# Antigravity 接入

Antigravity 使用独立槽位、Google OAuth 和账号模型目录。控制面将 Messages、Chat Completions 与 Responses 请求转换为统一结构，由槽位中的独立运行时访问官方服务；Claude/GPT 的账号凭证、内核和调度执行器不参与此流程。

本节描述已实现的接口和隔离规则。槽位原生适配器已使用真实账号验证文本生成、工具调用与结果往返、inline 图片识别。发布部署仍需验收公共协议入口与完整流式链路；解析器与模拟上游测试不等同于部署验收。

## 部署与启用

1. 创建本机 Docker Antigravity 槽位并绑定独立出口。暂不支持远程节点与 KVM。
2. 点击“绑定凭证 → 生成授权链接”，在本机浏览器完成 Google 授权，再将页面给出的单行授权码粘贴回面板。认证可以在平台接入关闭时执行；不会自动打开 API 调度。
3. 镜像包含经 SHA-512 校验并固定为 1.4.4 的官方 Linux amd64 CLI；首次授权将其放入槽位 `/home/kincli/.local/bin/agy`。默认 `cli_bin: "agy"` 即可。
4. 在槽位测试页点击“同步账号模型”，读取同一槽位中的官方 `agy models`。管理员也可在“设置 → Antigravity”选择已授权槽位，“同步账号模型并加入全局目录”。同步不发送推理请求。
5. 在平台设置中启用 Antigravity API 接入，再开启所需槽位的调度开关。创建空槽时默认调度关闭。全局模型目录保留已有模型的禁用、显示名称及供应商设置；新增模型不会覆盖这些选择。
6. 使用 `antigravity/<官方模型 ID>` 调用 API。模型供应商不改变账号平台，例如 Antigravity 中的 Claude 模型仍由 Antigravity 槽位承载。
7. 先验收首条生成，再验收历史、工具往返、流式取消、续聊，以及槽位重启后的授权持久化。

官方 CLI 在容器中管理自身的文件凭证存储，凭证保存在持久挂载的 `/home/kincli`。OAuth 管理器只保存公开的认证状态元数据；授权码仅传给该次官方客户端的输入，不写入数据库或日志。

OAuth 会话按操作者、槽位和所属用户隔离，有效期 30 分钟。关闭弹窗、取消、槽位停止/删除、变更所属用户或主控正常退出会清理登录进程；取消不注销既有账号。

## 模型目录与权限

账号目录来自该槽位的 `agy models`，保存在控制面私有目录 `data/antigravity-models/<slot-id>.json`（目录 700、文件 600）。该文件只含模型 ID、显示名称、供应商、更新时间、所属用户和认证版本标记，不含 token。目录不位于 guest 可写的 `run/`，读取拒绝符号链接；账号或所属用户变更后需要重新同步。

普通用户只能同步自己的槽位目录。`publish_global: true` 仅管理员可用，普通用户不能借此修改全局配置。同步失败保留上次有效目录，但不会发布无效输出。尚未同步的槽位不会被假定支持任意模型。

## API 与调度

| 接口 | 模型命名 |
| --- | --- |
| `POST /v1/messages` | `antigravity/<模型 ID>` |
| `POST /v1/chat/completions` | `antigravity/<模型 ID>` |
| `POST /v1/responses` | `antigravity/<模型 ID>` |

适配层保留结构化的历史、system 指令、图片、工具定义、工具调用及工具结果；不将这些内容拼接为单个 prompt。无法表示的参数或内容会明确拒绝。模型返回工具调用后，由调用方执行工具，再将结果提交给后续请求；槽位不执行调用方的本地命令或函数。

图片支持 inline base64 与 data URL，远程 URL 图片会明确拒绝。工具与结构化输出的 `strict: true`、`parallel_tool_calls: false` / `disable_parallel_tool_use: true` 暂不支持，会在访问上游前拒绝；不会静默忽略这些约束。

调度在独立的 Antigravity 账号池中完成，检查：

- 密钥的平台分组、指定槽位或账号池当前成员，以及槽位所属用户。
- 槽位已授权、运行中、支持本机 Docker 并绑定可用出口。
- 管理员全局启用模型、槽位模型策略允许模型，以及该账号已同步的实际可用目录。
- 调度开关、活动时段、独立并发/RPM 限制、等待队列和上游失败冷却。

错误切换只在尚未向调用方提交输出时进行，避免重复输出。请求取消会中止槽位执行并释放席位。调用日志与 usage 沿用现有日志链路；没有可靠单价的模型保持未计价状态，不伪造费用或 Claude/GPT 配额窗口。

### Responses 续接

`previous_response_id` 使用控制面进程内缓存，默认 TTL 为 30 分钟。缓存按 API 密钥、所属用户和模型隔离，限制条目数量及占用字节；客户端无法通过另一个密钥读取历史。当前密钥和槽位权限仍在后续请求调度时检查。

设置 `store: false` 不保存该次响应供以后续接。缓存过期、超出容量被回收或控制面重启后，旧 ID 将返回 `previous_response_not_found`；它不是持久化会话数据库。调用方应保留自己的完整历史，并在需要时重新提交。

## 面板接口

沿用面板鉴权与所属用户校验；super 角色仅可查看状态和执行已有调度操作，不能 OAuth 或同步模型。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/panel/vms/:id/antigravity/status` | 只读状态；返回认证状态、平台开关和账号模型目录 |
| `POST /api/panel/vms/:id/antigravity/oauth/start` | 创建 OAuth 会话，通过轮询取得授权链接 |
| `GET /api/panel/vms/:id/antigravity/oauth/session?session_id=...` | 读取本人的 OAuth 会话状态 |
| `POST /api/panel/vms/:id/antigravity/oauth/complete` | 提交 `{session_id,code}` 给官方客户端 |
| `POST /api/panel/vms/:id/antigravity/oauth/cancel` | 清理登录进程，保留已有凭证 |
| `POST /api/panel/vms/:id/antigravity/models/sync` | `{publish_global?:boolean}`，同步当前账号模型 |
| `POST /api/panel/vms/:id/schedulable` | `{schedulable:boolean}`，开启前需已确认登录 |
| `POST /api/panel/vms/:id/antigravity/chat` | 面板文本诊断：`{model,prompt,session_id}` |
| `POST /api/panel/vms/:id/antigravity/close` | 显式关闭面板文本会话 |

响应使用 `{ok:true,data:{...}}` 或 `{ok:false,error:{code,message}}`。`authenticated: null` 表示尚未确认登录；`ready` 只表示运行时健康，不能证明真实推理已经成功。

面板文本会话模型在会话内固定，进程上下文不跨运行时重启持久化。修改运行时配置后按提示重启对应槽位以应用；平台关闭仍允许清理旧会话。

## 运行时与验证

独立运行时通过槽位 Unix socket 与内部 token 接收请求。Linux 控制面默认提供自身 Node 可执行文件；控制面与槽位架构不同或 macOS 开发环境需设置 `KIN_ANTIGRAVITY_NODE_BIN` 为匹配槽位架构和系统库的 Linux Node。

数据面依据官方 CLI 1.4.4 所带 `google.gca.aicode` 协议访问固定的官方 `aicode.googleapis.com` 服务。OAuth 凭证的读取与请求均在槽位内，官方 `agy models` 负责刷新凭证；控制面只接收结构化内容与用量。上游协议变更需要同步更新适配器。

测试覆盖请求与流式事件转换、模型目录安全存储、管理员/owner 权限、密钥与账号池隔离、并发及队列、失败切换、取消、usage 和 Responses 续接缓存。生产启用前还需用真实账号验证目标模型的官方上游行为。Claude 的自动凭证刷新、配额探测、定时测试及遥测策略不套用到 Antigravity。
