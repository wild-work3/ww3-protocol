# 归一化对话流式 IPC 契约（IPC_CHAT）

> 本契约定义 ww3 内部**对话数据面**的统一流式 IPC：`chat.generate` 的请求体、事件序列、错误分类与用量归一。
> 结构参考 OpenAI Chat Completions（W3-13 #7），同一契约复用于 **ww3-gateway ↔ core ↔ 拦截器 ↔ 渠道 worker**（W3-13 #8）。
> 权威来源 = 本文档（+未来的 JSON Schema/样例/契约测试）；不依赖任何语言 SDK。细节语义从旧版 dev 借实（见 §后「来源」）。
> 进程生命周期、JSONL RPC 框架、控制面通用能力见 `PLUGIN_PROTOCOL.md`。两者共享同一底层 RPC。

---

## 1. 定位与边界

| 项 | 值 |
|---|---|
| 传输 | stdio，一行一个 JSON 对象 + `\n`（JSONL），非 HTTP、非 SSE |
| 方向 | 上游侧（调用方）：gateway/client → core ↔ 拦截器链 → 渠道 worker |
| 数据面 | **只支持流式**（W3-13 #9）：每次 `chat.generate` 调用内逐事件输出，无整条响应聚合 |
| 非流式上游 | 渠道仅支持非流式 → 转换为「单块流式」事件：文本/工具调用/结束原因/可用用量一次给出，**不得把原始 JSON 当文本输出** |
| 非流式下游 | 下游要非流式 → 由抽象层在流式管线**完成后**聚合（在 gateway 侧，非 IPC 层） |
| 事件终结 | `completed`/`incomplete`/`error` 三个终止事件**只会出现一次** |
| stdout | 只输出协议消息；**日志走 stderr** |

统一请求/事件对象约定：每条消息有唯一 `id`（调用方生成，字符串）；事件携带与请求相同的 `id` 关联。可选字段缺省即不存在，不视为 0/空串。

---

## 2. 请求：`chat.generate`

调用方→被调方（stream 语义为 invoke，如 `invoke: chat.generate`）。请求体字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✓ | 请求唯一 ID（幂等/取消关联键） |
| `conversation_id` | string | - | 多轮会话标识（W3-03：不绑进程，仅作插件持久化 session 映射键） |
| `model` | string | ✓ | 客户端请求的原始模型名（含 `channel/` 前缀，由 core 显式下发，**不靠渠道内部记忆**） |
| `messages` | array | ✓ | OpenAI Chat 消息；含 `role`/`content`，`tool` 消息带 `tool_call_id` |
| `tools` | array | - | OpenAI 工具定义（`$ref` 需在出站前内联消毒，见 W3-09） |
| `tool_choice` | string/obj | - | 工具选择策略 |
| `stream` | bool | - | 恒 true（本项目对话面只走流式） |
| 采样参数 | 混合 | - | `temperature`/`max_tokens`/`top_p` 等透传 |
| 推理强度 | 混合 | - | 私有透传字段 `reasoning_effort`/`thinking`（沿旧版 `chatRequest`「map 透传」），拦截器只读不改结构 |
| 扩展字段 | obj | - | 客户端协议来源等，向前兼容容器 |

> 复用旧版 `type chatRequest = map[string]any`（旧版 dev 仓 `internal/gateway/gateway.go:161-164`）的「map 透传私有字段」设计：统一结构是**最小超集**，不拦截上游私有字段。

### 2.0 请求改写规则（W3-35）

到达插件之前，请求已经过**两阶段规则改写**，因此插件**不应该**再实现通用归一化（`developer→system`、
出站脱敏、`max_completion_tokens` 翻译、tool 配对清理）：

- **Pass A（gateway，路由前）**：`chat.NormalizeBody` → 图片瘦身 → 无 `scope.channels` 的规则。
  三协议（Chat/Responses/Anthropic）在 gateway 内已收敛为统一 chat JSON，故一处覆盖全部。
- **Pass B（core，确定候选渠道后）**：带 `scope.channels` 的规则，**每个候选从 pristine 请求重建**
  （fallback 到渠道 B 时不得累积 A 的改写）。core 在规则生效前摘掉 `channel_config`/`account_uid`/`extra`，
  只回写 `messages`/`tools`/`tool_choice`——规则不得读写渠道配置（含凭据/基址）与调度字段。

规则权威是统一配置 `<data>/config.json` 的 `rules` 段（默认集内嵌 `main/rules/default_rules.json`）。
**插件只需处理方言结构投影**（Anthropic/Responses 报文结构、`systemInstruction`、首条必须为 system 等上游硬约束）；
某渠道若有特殊替换需求，写 channel-scoped 规则配置即可（见 `docs/PLUGIN_CLI.md` §8.1）。

### 2.1 模型命名
沿用旧版模型命名空间（旧版 dev 仓 `internal/provider/provider.go:140-186`）：
- `PublicModelID`：客户端可见模型名（可能带 `channel/` 前缀）。
- `SplitModelID` / `UpstreamModelOf` / `CanonicalModelID`：解析出渠道 + 上游模型名。
- 请求 `model` 一律为 PublicModelID；渠道 worker 用 `UpstreamModelOf` 换取上游模型名。**core 负责路由与模型名解析，渠道不复写。**

---

## 3. 事件序列（`event` 流）

`chat.generate` 调用过程中逐条输出的事件（行 = 独立 JSON）。按时间序：

| 事件 | 载荷关键字段 | 说明 |
|---|---|---|
| `text.delta` | `content`(str) | 正文增量；**空串不算已取到正文**（latched，见语义 3.1） |
| `reasoning.delta` | `content`(str) | 推理/思考增量（可选，凡上游给 reasoning 才发） |
| `tool_call.delta` | `index`(int), `id`/`name`/`arguments_fragment`(str) | 工具调用增量：**首片带 id/type/name，后续只带 arguments 片段**；按 `index` 合并（3.2） |
| `finish_reason` | `reason`(str) | `stop`/`length`/`tool_calls`/`content_filter`…；**截断不得补 `[DONE]` 伪装正常收尾（R36）** |
| `async.complete` | `request_id` | 同步穿行辅助：见 PLUGIN_PROTOCOL（保留） |
| `usage` | 见 §5 | 用量事件（可多帧，末帧为准或逐帧更新） |
| `error` | 见 §4 | 终止事件（之一） |
| `completed` | `request_id`, `finish_reason` | 终止事件（之一）：正常结束 |
| `incomplete` | `request_id`, `cause` | 终止事件（之一）：被截断/取消/超时等非错误中断 |

### 3.1 正文 latch（借旧版规约，`sse.go:78-91`）
- `content` 用「已取到正文」互斥 latch：一旦任一帧含非空 content，后续空 content 帧不再追加；**空串不占 latch 名额**（OpenAI 风格 role-only 首帧/整条空 message 帧是常态）。
- 一个请求只能以**一个**终止事件收尾。

### 3.2 工具调用合并（借旧版 `sse.go:92+`、`toolCallAccumulator`）
- `tool_call.delta` 按 `index` 累积合并到局部表（OpenAI 规范帧带 index 标记分片归属）。
- `index` 缺失的兼容：按顺序推入新条目。
- **非流式消息整条下发**：若上游以完整 `message` 帧给工具调用（非 delta），合并逻辑与 delta 分支**同构**（首并 id/name，后续并入 arguments）。

---

## 4. 错误

任何阶段喷出的错误都作为**终止事件** `error` 发出（且只能一次）。统一结构：

```
{ "id", "event":"error", "error":{ "kind", "scope", "message", "retryable", "retry_after_ms", "cause" } }
```

| 字段 | 说明 |
|---|---|
| `kind` | 稳定错误码，沿用旧版 `ErrKind`（§4.1） |
| `scope` | `request` / `model` / `account` / `channel` —— core 据此决定处置 |
| `message` | 人类可读描述 |
| `retryable` | 是否可换号/换上游重试 |
| `retry_after_ms` | 上游建议重试间隔（如排队帧 Retry-After），可空 |

### 4.1 `kind` 全集（借旧版 `provider.ErrKind`，`provider.go:178-275`）
沿用旧版枚举，保证 core 冷却/换号/降级语义可迁移：

| kind | 含义 | retryable(=Rotatable) | scope 建议 |
|---|---|---|---|
| `hard_credit` | 余额/权益不足 → 长冷却 | ✓ | account |
| `soft_rate` | 429 软限流 → 短冷却 | ✓ | account |
| `session_dead` | 登录态失效 → 禁用 | ✓ | account |
| `not_found` | 上游偶发 404 | ✓（不累计 errCount） | account/channel |
| `server` | 5xx 上游故障（**不换号**，实测同波多号全 500） | ✗ | channel |
| `client` | 其他 4xx/业务错误（如 model not allowed for user type） | ✓ | account/model |
| `content_blocked` | 内容策略拦截 → 不罚账号，透传原文 | ✗ | request |
| `prompt_too_long` | 上下文超限 → 请求级，不罚号不轮转 | ✗ | request |
| `image_invalid` | 图片无效（11135）→ 请求级 | ✗ | request |
| `bad_params` | 出站 body/参数不被接受 → 请求级 | ✗ | request |
| `waf_block` | 403+非业务信封（WAF 页）→ 账号软冷却 | ✗ | account |
| `account_fault` | 账号级授权/配额故障（11140/14017）→ 换号冷却 | ✓ | account |
| `model_blocked` | 后端无此模型（11102）→ (账号,模型) 负缓存避让 | ✗ | model |
| `passthrough` | 请求级拒绝（形态/地域）→ 原文透传，不罚号不轮转 | ✗ | request |
| `queued` | 模型排队（qodercn 10605 isQueued）→ 换号可能命中不同队列 | ✓ | model |
| `reasoning_loop` | **拦截器主动终止**（思考链死循环，W3-25）→ 换号只会重跑同一死循环 | ✗ | model |

> 额外分类：`conn`（连接失败）、`auth`（认证失败）、`idle_timeout`（空闲看门狗）、`cancel`（客户端取消）、`truncated`（截断）可作为扩展 kind，但**必须映射到上述画布或明确标注为非 Rotatable**，避免 core 误判。旧版另含 `IsIdleTimeout`(`context.Canceled`/`DeadlineExceeded`/`net.ErrClosed` 形态识别，`stream.go:129`)、`TruncationCause`（压平截断原始原因）——迁移时归入 `cause` 字段。

---

## 5. 用量归一（usage）

统一 `usage` 结构（可逐帧增量更新，core 汇总口径保留「实际 vs 估算」）：

```
{ "prompt_tokens", "completion_tokens", "total_tokens", "prompt_reported", "completion_reported", "total_reported", "prompt_estimated", "completion_estimated", "total_estimated", "cache":{ "cached", "cached_reported", "write", "write_reported" }, "time_ms", "first_token_ms" }
```

- **字段缺失/`null` = 上游未提供，不等于 0**；显式 `0` 仍是有效实报。core 按字段合并多帧 usage，在成功收口时只发一帧 finalized usage。
- token 三个维度分别带 `prompt|completion|total_reported` 与 `prompt|completion|total_estimated`；同一维度二者互斥。上游未报时 core 以归一化输入和实际输出文本粗估，`total` 未报时用最终 prompt+completion 推导。粗估只用于统一统计，不代表模型 tokenizer 的精确计费结果。
- `cached_reported`/`write_reported` 布尔标记「上游是否真的报告」，防把「未报」当成「0 命中」；缓存 token 不做估算。
- 缓存计量借旧版 `ExtractUsageCache`（`provider/usage.go:158-205`）的多形态识别：`prompt_cache_hit_tokens`(workbuddy) / `cache_read_input_tokens`(traework) / `prompt_tokens_details.cached_tokens`(Qoder 系/cline/oczen/monkeycode) / `cache_creation_input_tokens`(Anthropic 写入) / `prompt_tokens_details.cache_write_tokens`。
- Anthropic 互斥缓存语义：`input_tokens = prompt − cached − write`。core 记录耗时/首 token/吞吐，供降级与 Dashboard。

---

## 6. 取消 / 超时

| 能力 | 语义 |
|---|---|
| 取消 | `request.cancel`（invoke）携带 `id` → 被调方中断当前流，随后发一个**唯一**终止事件（`incomplete` cause=cancel 或 `error`） |
| idle 看门狗 | 连接/认证/首 token/整体/空闲 五类超时需区分（W3-05）；空闲超时 `idle_timeout` 需可从错误形态识别（借 `IsIdleTimeout`） |
| 背压 | 下游消费慢时，stdout 写阻塞天然提供背压；不缓冲整段（拦截器逐事件透传） |
| 不可逆边界 | **已发出部分响应后不得透明重放整段生成（W3-10）**；可安全重放需插件显式声明并由 core 裁决 |

---

## 7. 契约可测试性（W3-13 边界 B / W3-14）

契约同时是：
- 协议文档（本文档）；
- JSON Schema（或等价定义，待补充）；
- **标准事件样例**（含一条完整 `chat.generate` 的文本+工具调用+用量+正常结束）；
- 错误场景测试（每种 `kind` 至少一条，含 Rotatable 分类判定）；
- 跨语言契约测试（gateway/core/拦截器/渠道各以声明语言实现，同一套契约测试验证兼容性）。

> **JSON Schema 与契约测试骨架位置**：`protocol/schema/`（request.chat.generate.json / event.chat.stream.json / event.utils.json）与 `protocol/test/`（samples/ + node/run.js + python/run.py，各字段语义见 schema 内中文注释）。

任何改 kind/字段/事件序 = 协议版本演进，须多仓同步并走 W3-12 版本协商，不得破坏已发布插件。

---

## 8. 完整样例（`chat.generate` 流，文本+工具调用+用量+正常结束）

```jsonl
{"v":1,"id":"req-1","op":"invoke","method":"chat.generate","conversation_id":"c-7","model":"workbuddy/deepseek-v3","stream":true}
{"v":1,"id":"req-1","op":"event","event":"text.delta","content":"查看天气"}
{"v":1,"id":"req-1","op":"event","event":"tool_call.delta","index":0,"id":"call_1","name":"get_weather","arguments_fragment":"{\"city\":\"上海\""}
{"v":1,"id":"req-1","op":"event","event":"tool_call.delta","index":0,"arguments_fragment":"\"}\"}
{"v":1,"id":"req-1","op":"event","event":"finish_reason","reason":"tool_calls"}
{"v":1,"id":"req-1","op":"event","event":"usage","prompt_tokens":120,"completion_tokens":30,"total_tokens":150,"prompt_reported":true,"completion_reported":true,"total_reported":true,"cache":{"cached":80,"cached_reported":true},"time_ms":840,"first_token_ms":210}
{"v":1,"id":"req-1","op":"event","event":"completed","request_id":"req-1","finish_reason":"tool_calls"}
```

（`arguments_fragment` 可跨多帧累积；`finish_reason` 与 `completed` 都可在同一请求出现一次，`completed` 为主终止事件。）