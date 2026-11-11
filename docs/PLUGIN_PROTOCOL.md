# 插件协议（PLUGIN_PROTOCOL）

> 定义 ww3 插件的**进程生命周期 + JSONL RPC 框架 + 能力声明 + 控制面通用能力**。
> 对话数据面（`chat.generate` 事件/错误/用量归一）见 `IPC_CHAT.md`；二者共享同一底层 RPC。
> 协议版本、生命周期、插件元数据等结构参考 OpenAI Chat/工具生态与旧版 dev，属权威来源 = 本文档（+ JSON Schema/契约测试）。
> W3-12：协议一旦被多仓依赖，改动即版本兼容 + 多插件同步升级。

---

## 1. 角色与能力两分

| 角色 | 进程 | 承载能力 |
|---|---|---|
| 控制面 | **一次性调用**（`call` 子命令，一调用一进程） | 不绑定对话的通用能力：`models.list`、`auth.*`、`accounts.*`、`credits.*`、`rewards.*`、`config.*`、`health.check`、`ping` |
| 会话面 | **一次性调用**（一请求一进程） | 流式对话：`chat.generate`（契约见 IPC_CHAT.md） |

> **W3-20**：渠道插件不常驻。控制面与会话面都是「一次调用一个进程」，用完即回收；
> 同一插件也支持 `stdio` 常连形态（共用同一份方法表），但那是给自测/调试与拦截器用的。

- **多轮不绑进程（W3-03）**：同一对话的多轮各自启动独立 Worker，**不维护 conversation_id ↔ worker/PID 映射**；需要跨请求状态（如 billion-context）用显式 `conversation_id` + 独立持久化，插件自行维护与上游 session 映射。
- **控制面与会话面用同一 JSONL RPC 基础协议**，仅能力集不同（W3-12 §5）；两者在同一份 `registry()` 里注册，运行形态（call/stdio）只决定进程活多久（见 §3.1.1）。
- stdout 只输出协议消息，**stderr 专用于日志**。
- 进程启动/监督/回收由 **core 的统一运行时管理器**负责（W3-13 边界 A）；ww3-gateway 只经归一化 IPC 与 core/拦截器通信，不直接调渠道。

---

## 2. JSONL RPC 基础框架

每行一个 JSON 对象 + `\n`。两条消息类型：

### 2.1 invoke（调用方 → 被调方）
```
{ "v":1, "id":"<req-id>", "op":"invoke", "method":"<method>", "params":{...} }
```

### 2.2 event / 响应（被调方 → 调用方）
- 增量事件：
```
{ "v":1, "id":"<req-id>", "op":"event", "event":"<name>", ...事件字段 }
```
- 正常/异常终结（一条唯一）：
```
{ "v":1, "id":"<req-id>", "op":"result", "ok":true, "result":{...} }
{ "v":1, "id":"<req-id>", "op":"result", "ok":false, "error":{"kind","scope","message","retryable","cause"} }
```
> 二进制/大载荷走 base64 放进字段，或回调地址另传；第一条原则是**一行一 JSON、保持流的可调试性**。

通用机制：

| 机制 | 说明 |
|---|---|
| 请求关联 | 唯一 `id`（调用方生成）贯穿 invoke 与所有 event/result |
| 并发在途 | 被调方按 `id` 关联多个并发请求 |
| 取消 | `op:"invoke", method:"request.cancel", params:{id}` → 中断目标流，随后发唯一终结事件 |
| 超时 | 连接/认证/首 token/整体/空闲 五类区分（见 IPC_CHAT §6） |
| 背压 | stdout 写阻塞天然背压；不缓冲整段 |
| 子进程异常退出 | core 监督并回收，按能力恢复策略处理 |
| 健康检查 | `health.check`（见 §5） |

---

## 3. 能力声明（manifest / capabilities）

### 3.1 元数据 manifest
插件元数据声明执行模式与能力集：

```
{
  "id": "custom-api", "name": "自定义模型", "version": "1.0.0",
  "kind": "channel",                 // channel | hook
  "default_channels": [             // 预置渠道实例的插件声明；hook 不声明
    {"id":"workbuddy","name":"WorkBuddy 国内版"}
  ],
  "multi_channels": false,           // true = 实例由用户自建、可任意多个（W3-44）
  "protocol": { "min": 1, "max": 1 },
  "execution": {
    "control": "call",               // call | stdio（W3-20；留空视同 call）
    "conversation": "call",          // call | stdio
    "max_workers": 4,                // 调用方并发上限提示（0=不限）
    "idle_timeout_seconds": 0        // 仅 stdio 常连形态有意义
  },
  "capabilities": {
    "control": ["models.list","auth.begin","accounts.list","credits.get","config.get","config.set","rewards.claim"],
    "conversation": ["chat.generate"]
  }
}
```

### 3.1.1 渠道实例的两种来源（`default_channels` / `multi_channels`）

渠道插件的实例来源只有两种，**必须至少声明其一**（准入测试 `manifest.default_channels` 断言）：

| 声明 | 含义 | 例子 |
|---|---|---|
| `default_channels: [{id,name,config}]` | 插件**预置**固定实例，core 安装时幂等补建 | workbuddy 双区、qoder 三区、traework 双变体 |
| `multi_channels: true` | 实例**由用户在面板自建**、可任意多个；插件不预置（空配置占位渠道只会显示成「不可用」） | custom-api（旧版「自定义模型」） |

`meta.Manifest.MultiChannels`（JSON 键 `multi_channels`，`omitempty`）。两者可同时声明：预置项照常补建，面板另给「实例列表」入口供用户追加。

Go 对应 `meta.Manifest.DefaultChannels []meta.DefaultChannel`，每项为 `ID`、`Name`、`Config`；JSON 键分别为 `id`、`name`、`config`（空配置的 Go `omitempty` 序列化会省略 `config`，等同 `{}`）。`id` 是渠道实例 ID，同时**就是模型命名空间前缀**（路由第①级按 `<id>/` 命中，W3-24/W3-44）；同一插件可声明多条默认渠道（如不同地区），每条归属于同一个插件 ID，可分别配置、启停、绑定多个账号。账号身份与渠道实例分别管理，不能因多渠道而合并账号或覆盖其凭据。

安装时仅对**尚不存在的**渠道实例按声明创建默认记录；已有同 ID 渠道（包括用户改过的配置、名称、启停状态及账号）不可被 manifest 覆盖。更新、回滚不重置用户配置。`default_channels` 省略且 `multi_channels` 为假表示不自动创建渠道，仍可由用户手工添加实例；hook 不使用这两个字段。`config` 是初始配置，不是密钥发放机制：缺少必填项的默认渠道只是待配置占位，须按 `config.schema` 填写并验证后才可使用，不可因安装成功就视为可用。

用户自建实例的 ID 约束（core `checkChannelID`）：字母开头、字母/数字/`_`/`-`、首尾不为 `-`、长度 1~32；不得等于 `test`/`detail`/`models_refresh_all`（路由保留字）、不得与已有渠道或任何已安装渠道插件声明的 `default_channels[].id` 同名（否则会把内建渠道的模型前缀抢走）。

卸载只移除插件安装树中的二进制/manifest；core 保存的渠道实例配置、启停状态和账号记录、插件数据目录中的凭据均保留。插件缺席期间这些渠道不可调用；重装同一插件 ID 后恢复原有渠道及凭据，且只补建不存在的默认渠道。明确删除渠道/账号及凭据应走独立的用户操作，不是卸载的副作用。官方 `custom-api` 声明 `multi_channels: true` 且不带 `default_channels`：Provider（渠道标识 + `base_url` + `api_key`）全部由用户在面板「自定义模型」列表增删改，与旧版行为一致；`base_url`/`api_key` 缺失时该实例不可调用。

### 3.1.2 运行形态（W3-20）

| `execution` 取值 | 语义 | 谁用 |
|---|---|---|
| `call` | **一次性**：stdin 读一条 `invoke` → 写事件 + 一条 `result` → **进程退出** | 渠道插件（core 一律用这个，控制面与会话面都是） |
| `stdio` | **常连**：stdin/stdout 上跑 JSONL RPC 循环，直到 EOF | 自测/调试；拦截器插件（按需拉起后常驻） |

- 同一插件**同时实现两种形态**，二者共用同一份方法表（`plugin.Registry`）——不存在「stdio 能跑、call 跑不通」的捷径。
- `call` 形态**也必须发事件**（不能只发 result），否则会造出「stdio 正常、call 静默丢内容」的疑难 bug。
- 渠道插件**禁止常驻**：`call` 进程由调用方（core）拉起，结束即回收；写成 result 后不退出会被 `KillGrace`（默认 5s）强杀。
- 拦截器插件**按需拉起后常驻**（每次对话都用，反复 spawn 不划算），协议仍是 stdio。
- 调用方必须做两件事补偿 spawn 成本：**每插件并发信号量**（`max_workers`，未声明默认 4）与**批量串行化 + 间隔**（`BatchGap=200ms`）；不得假定目标机器能毫秒级起进程。

### 3.2 能力分层（W3-12 / §3）
- **核心必选**：`chat.generate`（含 `models.list`）。
- **可选**：`auth.*` / `accounts.*` / `credits.*` / `rewards.*` / `config.*`。
- **可选业务能力（W3-30）**：`systemone.decide`（结构化决策）/ `images.generate`（生图，含 0~N 参考图）——非流式一次性调用，归控制面，见 §5.8。
- 能力为稳定机器可读标识；未声明不调用。

### 3.3 协议版本协商
- `initialize` 时交换 `protocol.min/max`；双方选交集。协议演进走 W3-12 版本兼容协商，改动须多仓同步，不得破坏已发布插件。

---

## 4. 生命周期

```
initialize → capabilities.list → health.check → (业务)… → shutdown
```

1. **`initialize`**（invoke）：交换版本/能力/插件 ID；确认兼容区间。
2. **`capabilities.list`**：返回按角色（control/conversation）分组的支持方法清单。
3. **`health.check`**：报存活与就绪（见 §5）。
4. **业务调用**：渠道插件每次调用起一个 `call` 进程（控制面与会话面同形态），结束即回收；拦截器插件拉起一次后常驻（见 §3.1.1）。
5. **`shutdown`**：优雅退出（关闭端口/持久化）。

不把插件 ID/版本/协议版本写死，由元数据提供并校验。

---

## 5. 通用能力（控制面）

### 5.1 `ping` / `health.check`
```
ping => "pong"
health.check => { "state":"ok|degraded|down", "details":{...} }
```

### 5.2 `models.list`
模型发现；可选能力探测：`context` / `price` / `capability` 均允许 `null`（勿臆造）。

```
=> { "models":[
  {"id":"<channel>/<upstream>","name":"...","context":null,"input_price":null,"output_price":null,
   "capabilities":{"tools":true},
   "efforts":["low","medium","high"],"default_effort":"medium","can_disable_thinking":false}
] }
```
模型命名空间沿用旧版（`PublicModelID`/`UpstreamModelOf`，见 IPC_CHAT §2.1、AGENTS §7.3）。尺寸单位 token（1000=1k）。

#### 5.2.0 思考档位三字段（W3-32，迁移旧版 `provider.ModelInfo`）

| 字段 | 类型 | 语义 |
|---|---|---|
| `efforts` | `[]string` | 上游目录**显式声明**的可选档位枚举（wire 值原样）。`nil` = 上游未声明，消费方**不得编造**；空切片 = 上游明确声明不支持任何档位 |
| `default_effort` | `string` | 上游声明的默认档位。**必须落在 `efforts` 内**，否则视为未声明（留空） |
| `can_disable_thinking` | `*bool` | 思考能否真正关闭。三态：`nil` = 未声明；`false` = **假关**（关掉照样思考照样计费）或强制思考 |

**跨渠道唯一通用值只有 `off`**（关思考）；其余枚举（`auto`/`on`/`low`/`medium`/`high`/`xhigh`/`tiered`…）
由各渠道自定，以本字段为权威。会话面的入参字段是 `chat.generate` 的 `reasoning_effort`
（`thinking: bool` 仅为兼容保留）。

**语义是 hint 级**：`off` 不保证上游不思考，`on|high` 不保证上游一定返回 CoT。
插件**不得因为收到 `off` 就不发 `reasoning` 事件**，也**不得因为收到 `on` 就伪造 `reasoning` 事件**——
一切以上游实际返回为准（R36/W3-10 不得伪造内容）。

清洗口径：去空白、去重保序、丢空串；全部无效时返回 `nil`（`meta.CleanEfforts`，与旧版
`provider.CleanEfforts` 同口径，对齐 Buddy2api v2.1.11 的「never invent effort lists」原则）。

**下游透传**：core `GET /api/channels/{id}/models/detail`（对象数组，含档位）与
`GET /api/fees`（`models[].efforts`/`default_effort`/`can_disable_thinking`）、
gateway `GET /v1/models`（`reasoning{supported_efforts,default_effort,can_disable_thinking,mandatory}`
+ `supports_reasoning` + `supported_parameters:["reasoning","reasoning_effort"]`，
与旧版 `buildModelEntry` 同形）。上游未声明档位时**整个 reasoning 对象与 supports_reasoning 都不出现**。

> 已知无档位数据的渠道（`qoder`/`workbuddy`/`cline`/`codearts`/`oczen`/`kilo`/`monkeycode`/
> `officeace`/`traework`/`qwenwork`/`raccoon`/`glm`）：上游目录不返回档位枚举，旧版也没有，故无迁移项。

#### 5.2.1 `chat.generate` 的账号下发（多账号渠道必须）

`GenerateRequest` 新增两个字段（向后兼容，旧插件忽略即可）：

| 字段 | 方向 | 说明 |
|---|---|---|
| `account_uid` | core → 插件 | core 已按账号池选定的**逻辑账号**（插件侧原始 uid）。多账号渠道（如 workbuddy 双区）必须用它的凭据发请求，**不得自行换号**（§9 红线） |
| `channel_config` | core → 插件 | 该渠道实例的配置（endpoint/region/代理等）。**不含任何凭据** |

约定：
- 单账号的 API Key 渠道可忽略 `account_uid`（凭据就在 `channel_config` 里）。
- 凭据本体永远由插件的私有凭据目录持有（`<data>/auths/`，格式与命名见 `PLUGIN_CLI.md §5.1`，W3-21 起与旧版 `wild-work.exe` 的 `auths/` 可互换），不经 IPC（W3-07）。
- 插件上报账号时用 `meta.AccountInfo.{uid,region,prefixes}`：
  `prefixes` 是该账号可服务的模型命名空间前缀（双区渠道：国内版 `["workbuddy"]`、国际版 `["workbuddyai"]`），
  core 据此把 `workbuddyai/<model>` 路由到正确渠道实例，**不需要在 core 里写渠道特判**。

#### 5.2.2 `stream_options.include_usage` 的注入口径（W3-33）

旧版在 `dev/internal/upstream/payload.go:41-44` 的 `PrepareBody` 里**集中注入**
`stream_options={include_usage:true}`（仅当客户端未显式带，决议 D7）。ww3 分层后，
这是**上游协议细节**，归 **CH（渠道插件）** 在拼上游 body 时注入，不是 core 归一化层的职责：

- **插件的义务**：拼上游 body 时，若 `stream_options` 键**不存在**则补 `{include_usage:true}`；
  客户端**显式给了**（哪怕 `include_usage:false`）就一律不覆盖（D7）。
- **适用范围**：只对 OpenAI Chat Completions 形状的上游有意义。Anthropic Messages（minimax/zcode）、
  OpenAI Responses（codearts 部分面）、原生信封（gemini v1internal、qoder 嵌套 SSE）、
  **网页私有接口（glm/goose/workbuddy/qwenwork/traework/raccoon/loomy 等）不需要也不应注入**——
  上游不认这个字段，注了反而改请求体形状（部分上游对 body 做签名/指纹校验）。
- **core 不做这件事**：`GenerateRequest` 里没有 wire 层的 `stream_options`，只有归一化字段。
- **gateway 最后一道闸**：若客户端显式 `stream_options.include_usage=false`，而插件又上报了
  `usage` 事件，gateway 会在写 SSE 时丢掉该帧（`main/gateway/internal/v1/chat.go` 的
  `includeUsageOf`）——保证下游语义正确。上游用量仍照常入账。
- **统一统计来源（W3-34）**：插件只能上报上游事实，不得自己估算。token 字段若上游提供则标记对应
  `*_reported=true`（明确 0 也算实报）；未提供则省略/保持 unknown。core 会在成功请求收口时对缺失维度
  粗估并标记 `*_estimated=true`，且只向下游发送一帧 finalized usage。缓存命中/写入永不估算。

## 5.3 `auth.*`（登录，声明式）

> **本节由 W3-19 重构**：登录差异压成 **6 种范式**（Type），core 只认范式、不认渠道。
> Go 类型见本仓 `authflow/authflow.go`；13 个旧渠道的映射表见 `docs/AUTH_FLOW.md`。
> 旧版五类名（`form` / `browser_callback` / `cdp_browser` / `credential_import` / `device_code`）
> 经 `authflow.Normalize()` 仍可用（不破坏已发布插件）。

| Type（范式） | 含义 | 浏览器回调 | 本地端口 | 跨机 | 旧版渠道 |
|---|---|---|---|---|---|
| `device_poll` | 插件向自己上游申请 state/device_code 并**自行轮询** | 无 | 无 | 天然通 | workbuddy、qoder 系、zcode、minimax |
| `loopback_callback` | 插件监听 `127.0.0.1:<port>` 收 code 换 token | 有 | 有（动态端口） | 需粘贴兜底 | traework、codearts、lobsterai、qwenwork、gemini |
| `cdp_capture` | 插件拉起独立 profile 浏览器读 Cookie | 无 | CDP 调试口 | 同机 | raccoon（glm 早期路径已废弃，现走 `form` 粘贴） |
| `form` | 用户表单输入（API Key / Cookie） | 无 | 无 | 天然通 | custom、cline、glm 手工路径 |
| `credential_import` | 从本机官方客户端导入凭据 | 无 | 无 | 同机 | monkeycode |
| `none` | 无需登录（匿名/免费池） | 无 | 无 | — | oczen、kilo |

**core 侧的三个判据全部来自 Type，不得在 gateway/前端再判一次**：
- `Type.NeedsPoll()` → 是否起 `auth.status` 循环；
- `Type.NeedsBrowser()` → 是否把 `auth_url` 交给用户浏览器；
- `Type.CanPasteCallback()` → 是否暴露「粘贴回调 URL」输入框（仅 `loopback_callback`）。

| 方法 | 说明 |
|---|---|
| `auth.methods` | 返回 `MethodsResult{region, methods[], note}`；一个插件可声明多种方式（同一渠道可同时给 device_poll + credential_import），`Method{ID,Type,Label,Description,Fields,Region,Default}`。`Fields` 是 JSON Schema 子集，前端复用 `schemaForm()` 渲染 |
| （能力声明） | 需在 manifest `capabilities.control` 里声明 `auth.methods/auth.begin/auth.status/auth.finish/auth.cancel`；core 按能力决定是否给前端显示「登录」按钮（未声明则前端不显示、core 返回可读提示） |
| `auth.begin` | `BeginRequest{method,region,values,account_uid}` → `BeginResult{flow_id,type,auth_url,user_code,verification_uri,callback_url,debug_port,prompt,expires_at,can_paste_callback,next_poll_ms}`；空字段省略，**不臆造** |
| `auth.status` | `StatusRequest{flow_id}` → `StatusResult{state,hint,next_poll_ms,account,error,events[]}`；`state` 取 `pending/waiting_user/waiting_callback/waiting_input/success/failed/expired/cancelled`，`State.Terminal()` 判定终态 |
| `auth.finish` | `FinishRequest{flow_id,callback_url,values}`：手工粘贴回调 URL 或补充表单输入，与自动回调走**同一条**兑换路径（R101 的唯一通用兜底） |
| `auth.cancel` | `CancelRequest{flow_id}`：关监听器、清理临时 profile、作废 state |

硬约束：
- **凭据绝不过 IPC**：插件在 `auth.status` 只上报 `Account{uid,nickname,region,expires_at,credits}` 事实，
  token 由插件写入**自己**的私有凭据目录（`<data>/auths/`，见 `PLUGIN_CLI.md §5.1`），core 不持有、不落盘、不打印（W3-07 零 token 落盘）。
- **流程归插件，编排归 core**：插件只管一次 flow（起监听/轮询/换 token/落盘），core 只管「起不起轮询、终态回收、账号入库」。
- **一插件可多账号**：`flow_id` 与账号无绑定关系；成功后的 `account.uid` 才是账号身份。

参考实现（旧版 dev）：loopback PKCE `internal/login_trae`；CDP `internal/login_glm`（共享 `internal/cdp`）。凭据不得写工作目录/日志/临时文件（零 token 落盘，W3-07）。

### 5.4 `accounts.*`
一个插件可管多个账号（进程≠账号≠session）。

| 方法 | 说明 |
|---|---|
| `accounts.list` | 返回账号列表：`uid`/`nickname`/`status`/`login_kind`/`expires_at`/代理等 |
| `accounts.refresh` | 对指定账号刷新凭据 |
| `accounts.remove` | 移除指定账号 |

### 5.5 `credits.*`
余额/额度查询（旧版 `ResourceItem` 语义，见 IPC_CHAT §5 / AGENTS §7.3）。

```
credits.get => { "balance":<num|null>, "unit":"credits|token", "items":[ {"name","total","used","remain","unit","usable","info_only","key","expire_at"} ] }
```
- `null` = 上游未提供，≠ 0。
- `expire_at`：`YYYY-MM-DD` 墙钟日全天有效 or RFC3339；空串=未下发。
- `key`：稳定 ID 供 core `stat` 记账差分对账（W3-40 术语统一，旧版叫 ledger）；无 ID 留空退 `name` 伪键。
- `usable`：区分专用池（如 traework ep=1 官方专用 vs ep=0 本工具）；`info_only`：只展示不参与算术（同时置 usable=true）。

```
credits.history => 积分明细（可选）
```

### 5.6 `rewards.*`（可选，需幂等键/资格校验）
```
rewards.list  => 可领奖励清单
rewards.claim => 领取（需幂等键）
```

### 5.7 `config.*`（渠道专属配置 JSON Schema）
```
config.schema => 配置项的 JSON Schema（Dashboard 自动生成表单）
config.get     => 当前配置
config.set     => 保存配置
```
通用字段（endpoint/代理/超时）统一，专属字段由插件定义（W3-06）。

### 5.8 可选业务能力（W3-30）：`systemone.decide` / `images.generate`

> W3-30 把「非对话、非流式、一次性」的渠道业务能力收进同一套约定，先落两个：
> `systemone.decide`（结构化决策，OpenCode Zen Jev）与 `images.generate`（生图，含 0~N 参考图，
> 统一旧版 generations/edits 两个端点）。旧版蓝本：`dev/internal/gateway/gateway.go:246`（/v1/systemone）、
> `dev/internal/server/handler_images.go`、`dev/internal/glm/image.go`（决议 R106）。
> CLI 命令形状见 `PLUGIN_CLI.md §2.1`；不支持的渠道插件回 `not_supported` 即可（下表）。
> 语言无关定义：`protocol/schema/params.{systemone.decide,images.generate}.json` 与
> `result.{systemone.decide,images.generate}.json`，样例 `protocol/test/samples/abilities/`。

**归面**：两者归**控制面**（manifest `capabilities.control` + `execution.control="call"`）——语义就是
「一调用一进程、只写一帧 result、无事件流」。术语澄清：ww3 的「控制面」= **所有非流式一次性调用的集合**
（models/auth/accounts/credits/rewards/config + 本节的生图/决策），不是「只管元数据」；
会话面仍是唯一的流式对话契约（`chat.generate` / `hook.stream`）。

共同约定（两个能力都适用）：

| 约定 | 说明 |
|---|---|
| 不发事件帧 | §3.1.1「`call` 也必须发事件」只约束**流式**方法；本节方法只写一帧 result |
| 能力声明为准 | manifest `capabilities.control` 未声明 → core 不调用、前端不显示入口并回可读提示 |
| 不支持的姿势 | 方法**仍注册**；被调到时回 `kind="not_supported"`、`scope="channel"`（建议 `plugin.HandleUnsupported(method, 中文名)` 一行，落地清单见 AGENTS §2-AB）。存量插件未补的由框架自动回 `not_found`，对 core 二者等价（不冷却、不换号） |
| 账号与配置 | params 用控制面惯例 `config`（渠道配置，**不含凭据**，W3-07）+ 可选 `uid`（凭据标识=RemoteUID）；**不是**会话面的 `channel_config`（AGENTS 陷阱 20） |
| 不参与轮转 | 不进 `models.list`、不进 ModelFallback/降级链、不做请求内换号（同步长操作轮转代价高，旧版 `runGLM` 同结论）；但 `session_dead`/`soft_rate` 照常写冷却 |
| 长超时 | 生图是 10~30s 级同步长调用，core 侧必须用对话级超时（`ChatTimeout=300s` 量级）而非控制面 `DefaultTimeout=30s`（AGENTS 陷阱 23 同类） |
| 虚拟模型键 | 账号池冷却与流水归因用固定虚拟模型名 `image` / `systemone`（组合渠道前缀如 `glm/image`）；**不得出现在 `models.list`**——它们不是对话模型，客户端拿去聊天必 500（旧版实证） |

#### 5.8.1 `systemone.decide`（结构化决策，Jev）

params：

```json
{
  "state": "客户工单原文…",
  "questions": {
    "refund":  { "type": "noul",   "criteria": { "true": "应退款", "false": "不应退款" } },
    "team":    { "type": "choice", "criteria": { "billing": "账务问题", "tech": "技术问题", "sales": "售前咨询" } },
    "urgency": { "type": "score",  "criteria": ["极低", "低", "中", "高", "极高"] }
  },
  "model": "jev-1.13-free",
  "uid": "oczen-anonymous",
  "config": { }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `state` | ✅ | 键必须存在（值可为空串）；上游缺失该键直接 400 |
| `questions` | ✅ | 非空 map；每项 `type` ∈ `noul/choice/score` 且**必须带 criteria**（缺省不猜） |
| `model` | — | 决策模型；缺省由插件固定（`jev-1.13-free`）。未知模型本地拒绝 `model_blocked`（上游会静默回落） |
| `uid` / `config` | — | 见 §5.8 共同约定 |

criteria 与 `answers[name]` 形状（上游语义，core/gateway **原样透传 `answers`，不改写不猜语义**）：

| type | criteria | `answers[name]` |
|---|---|---|
| `noul` | 恰好 `{"true":"…","false":"…"}` 两键 | `{"type":"noul","noul":0.92}`（0~1 概率） |
| `choice` | dict 选项→判据，≤255 项 | `{"type":"choice","choice":"billing","confidence":1,"probabilities":{…}}` |
| `score` | list，2~10 级 | `{"type":"score","score":1.83,"confidence":0.74,"legend":{…},"probabilities":{…}}` |

result：

```json
{
  "model": "jev-1.13-free",
  "answers": { "…原样透传…": null },
  "usage": { "prompt_tokens": 444, "completion_tokens": 69, "total_tokens": 513 },
  "cost": "0"
}
```

- `usage` 归一到 IPC_CHAT §5 的 token 口径（上游 `input_tokens/output_tokens` → `prompt/completion`）；未上报的字段省略，**不写 0 冒充**。
- `cost` 原样字符串（免费车道 `"0"`）；数值化记账走 core 的积分差分，不复用 `credits` 口径。
- 校验分界：core/gateway 只做「`state` 键存在 / `questions` 非空」快速失败（`bad_params`/request）；**类型、选项数、预算等渠道事实归插件**，插件不得把上游 500 原样抛回（`passthrough` 例外）。预算：`state`+`questions` 共享上游 ~32k token，超限 `prompt_too_long`；读上游响应上限 1MB（旧版 `io.LimitReader 1<<20` 同值），超限报 `truncated` 不得静默截断。
- 上游事实（oczen）：`POST {base}/systemone`，`base` 车道选择与 chat 相同（显式 `base_url` > 键控 `/zen/v1` > 匿名 `/inference/v1`），伪装头与 `Bearer public`/key 复用 chat 路径；**凭据留在插件**（LEGACY §4 待决 6）。实测单请求 0.5~1.3s，免费。

#### 5.8.2 `images.generate`（生图，0~N 参考图统一契约）

一个方法同时承载文生图与参考图生图（旧版 `/v1/images/generations` + `/v1/images/edits` 统一，W3-30）：

params：

```json
{
  "prompt": "把参考图中的柴犬戴上红色圣诞帽",
  "n": 1,
  "size": "1024x1024",
  "aspect_ratio": "1:1",
  "response_format": "b64_json",
  "output_format": "png",
  "images": [
    "https://cdn.example/a.png",
    "data:image/png;base64,iVBORw0…",
    { "b64_json": "iVBORw0…", "mime_type": "image/png", "name": "ref2" }
  ],
  "uid": "glm-xxxx",
  "config": { }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 非空 |
| `n` | — | 期望张数，缺省 1。上游单批固定多张（glm 一次 4 图）时插件按 `n` 截断；实际张数以 `data` 长度为准 |
| `size` / `aspect_ratio` | — | 二选一（OpenAI 形状 `1024x1024`/`auto` vs 比例 `1:1/3:4/4:3/9:16/16:9`）；同时给以 `aspect_ratio` 为准，都不给交给插件默认。插件**必须本地严格校验**，非法回 `bad_params`——旧版实证上游对非法比例**静默降级 1:1**（出错误图还回成功），绝不能在 core/gateway 兜 |
| `response_format` | — | `b64_json`（缺省）\| `url`。缺省选 b64：旧版实证产物 CDN 直链会过期。**直链下载与上游私有转码归插件**（如 `sfile.chatglm.cn` 追加 `?image_process=format,png` 真转 PNG） |
| `output_format` | — | `png/jpeg/webp`，可选；插件尽力，做不到不报错，在 `data[].mime_type` 回**真实** MIME |
| `images` | — | 0~N 张参考图，`[]`=文生图。元素：`"<url\|data:URI>"` 字符串简写，或 `{"url":…}` / `{"b64_json":…, "mime_type":…, "name":…}` 对象（b64 必带 `mime_type`） |
| `uid` / `config` | — | 见 §5.8 共同约定 |

**参考图处理（本契约的核心分界）**：
- 契约**不设张数上限**，怎么用多张参考图完全由插件决定：原生多图直传 / 拼版成一张并标注 `reference1..N`（旧版 glm 的 `imgutil.BuildRefSheet`）/ 逐图多轮 / 先托管图床换公网直链。**core 与 gateway 不拼版、不下载、不托管参考图**（渠道事实归插件，W3-09）。
- **不得静默丢弃参考图**：上游有硬上限且无法合并时回 `bad_params`（scope=model）+ 可读原因（含支持张数）；做了合并/降级必须在 `note` 说明。单图硬约束的渠道（glm）多图必须拼版，不能只取第一张装作成功。
- 体积：JSONL 单帧上限 64MB（`jsonl.Decoder`）、base64 膨胀 4/3 → **单次请求参考图原始字节合计 ≤ 24MB**，超限 `bad_params`；gateway 对 `/v1/images/*` 用 32MiB 独立请求体上限（小于 chat 的 128MiB）。
- 隐私（W3-07）：需要把用户参考图上传第三方图床的插件，必须在 `config.schema` 暴露开关（默认关）并在 label 写明去向；**不得静默上传**。

result：

```json
{
  "created": 1780000000,
  "data": [
    { "url": "https://…png", "b64_json": null, "revised_prompt": "…",
      "mime_type": "image/png", "width": 1024, "height": 1024 }
  ],
  "aspect_ratio": "1:1",
  "note": "3 张参考图已拼版为 1 张（reference1..3）",
  "usage": null
}
```

- `data[].url` / `b64_json` 至少一个非空；`width/height` 是**实际**尺寸（改图时输出比例跟随输入图，不得回显请求值）；`revised_prompt` 是上游改写后的提示词（glm 在 `ct.Code`），无则省略；`usage` 未上报 = `null`，不臆造。
- 错误映射（core 执行策略，旧版 `runGLM` 口径）：`session_dead`→401；`soft_rate`→429 + **模型级**冷却；`waf_block`/`account_fault`→502 + 短冷却；`content_blocked`/`bad_params`/`passthrough`→400 不罚号；流截断且无产物→`truncated`，**不得回 `ok:true`、不得伪造产物或补 `[DONE]`**（W3-10/R36）。
- 上游事实（glm）：文生图 = 对话通道换 `assistant_id=DrawingAssistantID` + `meta_data.cogview{aspect_ratio, rm_label_watermark:true}` + SSE 收 image 项（`part.status=finish`，URL 去重保序，revised prompt 在 `ct.Code`），墙钟兜底 3min；参考图改图 = 同步 `POST /chatglm/drawing-api/v1/image/reference`（`type=Intelligent Editing`，`aspect_ratio` 占位无效，size 被上游忽略）。实测出图 12~15s/4 图、改图 17~22s、不扣积分（决议 R106）。

对外 HTTP 映射（gateway，**已落地** `main/gateway/internal/v1/abilities.go` + `main/core/internal/api/abilities.go`）：`POST /v1/systemone {state,questions,model?,channel_id?,uid?}` → core IPC `systemone.decide`；`POST /v1/images/generations` 与 `POST /v1/images/edits`（multipart 与 JSON 两种形态；`image`/`image[]` 在 gateway 归一成契约的 `images[]`）→ core IPC `images.generate`。三个端点都是**非流式** JSON 应答，不走 chat 的流式管线（W3-13 #9 只约束对话数据面，本节能力非对话）；鉴权与三协议同为 API Key。
错误体口径：`/v1/*` 一律 OpenAI 形状 `{"error":{message,type,code,scope?}}`（`type`/`code` 都填稳定 kind，`scope` 仅 ww3 内部错误带），**不得**把 core 管理面的 `{ok,error,kind,scope}` 直接透给外部客户端。

---

## 6. 拦截器（hook）特定协议

独立 executable，按配置顺序 A→B→C：
- **请求正向传递、响应事件反向返回**；SSE 逐事件透传，**不得为逆序处理而缓存整段**。
- 三类 hook：`request.prepare`（标准化/改写请求，**已落地**，形状与安全边界见 `HOOK_PROTOCOL.md §4`）/ `response.event`（单事件流，即 `hook.stream`）/ `request.finalize`（结束状态/错误/用量摘要，**尚未定义**）。
- 更高权限（重试/重放上游/注入工具调用）作为**单独声明的可选能力**，不默认开放。
- 失败策略：日志/观测类 fail-open；请求变换类默认 fail-closed（可选声明可 fail-open）；流式响应崩溃中断当前流报错（不得伪造正常结束）；超时按策略跳过或终止，不得无限阻塞。
- 进程形态（W3-25/W3-49 定案）：渠道插件与拦截器插件**都是一请求（一流）一进程**，不常驻；早期“拦截器按需拉起后常驻”的措辞已作废，stdio 长连接只是调试形态。

---

## 7. 错误

- 统一错误结构含 `kind`（沿用 `provider.ErrKind` 全集，见 IPC_CHAT §4.1）+ `scope`（request/model/account/channel）。
- 新增稳定错误码 `not_supported`（W3-30，additive）：渠道不支持某标准可选业务能力（§5.8）。scope=channel，**不冷却、不换号**（`errkind.Rotatable` 默认 false），core/前端转可读提示；与 `not_found`（框架对未注册方法的默认回包）对 core 等价处理。
- core 据 scope/kind 决定冷却、换号、降级、透传策略；原则：**插件报告事实，core 执行策略**——插件不得私自重试多次/换模型/吞错。
- 终止事件只能一次（completed/incomplete/error）。

---

## 8. 契约可测试性 & 注册

- 契约 = 文档 + JSON Schema + 标准样例 + 错误场景测试 + 跨语言契约测试（W3-13 边界 B）。
- 现有 schema：`protocol/schema/{request.chat.generate,event.chat.stream,event.utils}.json`；
  **W3-30 新增**（一次性能力，invoke→result 单帧，无事件流）：
  `params.systemone.decide.json`、`result.systemone.decide.json`、`params.images.generate.json`、`result.images.generate.json`，
  样例在 `protocol/test/samples/abilities/`（现有跑器只扫 `samples/*.jsonl`，不递归该子目录；接入方式见 `protocol/test/README.md` 的 TODO）。
- 更新/分发 / 插件清单（目录清单 + 版本清单、SHA-256、签名、原子切换、回滚）见 `PLUGIN_REGISTRY.md`（待冻结，AGENTS §H）。
- 插件 ID/版本/协议版本由元数据提供并校验，不写死。

---

## 9. 完整样例：`auth` 控制面（loopback）交互

```jsonl
{"v":1,"id":"a1","op":"invoke","method":"initialize","params":{"protocol":1,"plugin_id":"custom-api"}}
{"v":1,"id":"a1","op":"result","ok":true,"result":{"protocol":1,"capabilities":["models.list","auth.begin","accounts.list","config.get"]}}
{"v":1,"id":"a2","op":"invoke","method":"auth.begin","params":{"type":"browser_callback"}}
{"v":1,"id":"a2","op":"event","event":"auth.progress","data":{"callback_url":"http://127.0.0.1:53291/cb?state=abc"}}
{"v":1,"id":"a3","op":"invoke","method":"auth.status","params":{"poll_key":"k1"}}
{"v":1,"id":"a3","op":"result","ok":true,"result":{"state":"pending","hint":"请在浏览器完成授权"}}
{"v":1,"id":"a4","op":"invoke","method":"shutdown","params":{}}
{"v":1,"id":"a4","op":"result","ok":true,"result":{}}
```