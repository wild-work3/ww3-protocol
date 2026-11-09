# 网页 AI 逆向渠道 CLI 的命令界面契约

> 状态：**已冻结 v1**（2026-10-27）。依据两个已落地的完整案例反推共性：
> `chatglm2api/chatglm-cli`（智谱清言）与 `ww3/chatgpt-cli`（ChatGPT）。
> 本文是**命令界面层**的契约，与 `PLUGIN_CLI.md`（进程/开关/数据目录）和
> `PLUGIN_PROTOCOL.md`（RPC 方法/能力）并列，不重复它们的内容。
>
> 适用范围：**「网页版 AI 服务 → ww3 渠道插件」**这一类。判定特征是
> ① 上游是浏览器私有接口而非公开 API；② 需要浏览器指纹/对抗算法；
> ③ 有会话概念但无标准 API。API Key 型渠道（`custom-api-ext`）不需要这么重的外壳。

---

## 0. 一句话

**一个可执行文件，既是 ww3 渠道插件（`call`/`stdio` 走 JSONL IPC），又是人能直接用的
CLI（`chat`/`images`/`conv-*` 走 stdout JSONL 事件）。两者共用同一套内核与同一套方法表，
CLI 模式**必须 spawn 自身子进程走真实 IPC**，不允许「CLI 专用捷径」。**

```
                 ┌─────────────────────────────────────────┐
   ww3 core ────►│ call / stdio   （协议本体，stdin JSONL） │
                 │                                          │
   人类/脚本 ───►│ chat / images / conv-*  （便利层）        │
                 │        └─ spawn 自身 `call` ─────────────┘│
                 └─────────────────────────────────────────┘
```

---

## 1. 三层结构与各层职责

| 层 | 内容 | 是否可自由发挥 |
|---|---|---|
| **契约层** | `call`/`stdio`/`manifest`/`ping`（必需）+ `systemone`/`images`（可选但命令必须存在） | ❌ 冻结 |
| **外壳层** | 命令解析、开关、事件编码、退出码、数据目录、日志、凭据存储 | ❌ 冻结（照抄） |
| **便利层** | `chat`/`conv-*`/`user`/`models`/… 以及渠道专属命令 | ✅ 允许差异，但命名与开关形状要一致 |

**两个案例的代码结构完全同构**：

```
cmd/<name>/main.go          ← 只有 17~20 行，调 cli.Main(os.Args[1:])
internal/protocol/          ← 从契约仓复制（或直接 `go get`；W3-53）
internal/cli/               ← 外壳层：cli.go/register.go/cmd_*.go/helpers.go
internal/channel/           ← 桥接层：把 ww3 契约映射到内核（manifest/registry/ops）
internal/<渠道包>/          ← 内核：transport/cred/sentinel/sse/chat/upload/conv/account
```

> `internal/protocol/` 必须**复制**而非依赖模块。两个案例各有一份 3728 行的副本，
> 靠 `protocol/test` 的跨语言契约测试兜住漂移——这是 W3-28 的明确取舍。

---

## 2. 命令命名契约

### 2.1 硬规则

| 规则 | 说明 | 反例 |
|---|---|---|
| **命令名是裸词，无前导减号** | 第一个位置参数即命令 | `-mode chat` ❌ |
| **多词用 kebab-case，不用空格分子命令** | `conv-list` 而非 `conv list` | `conv list` ❌ |
| **开关一律双短横线** | `--data`；不提供单短横线简写 | `-data` ❌ |
| **本命令不认的开关直接报错** | 按命令隔离 FlagSet | 全局 FlagSet ❌ |
| **缺省命令 = `call`** | 不给命令名时走 `call`（gateway/core 的缺省是 `serve`） | — |
| **`--help`/`-h`/`help` → 特殊哨兵** | 返回 `ErrHelp`，打印用法后退出 0 | 报 usage_error ❌ |
| **不接受位置参数** | 业务参数一律走开关或 stdin | `chat "你好"` ❌ |

### 2.2 命令全集

**① 契约必需（4）**——`PLUGIN_CLI.md §2`

| 命令 | 语义 | 允许的开关 |
|---|---|---|
| `call` | stdin 读**一条** invoke → 事件 + 一条 result → 退出 | **只有 `--data`** |
| `stdio` | JSONL RPC 循环直到 EOF（自测/调试） | **只有 `--data`** |
| `manifest` | 打印 manifest JSON（`--out` 落文件，否则 stdout） | `--data`/`--out` |
| `ping` | 枚举 registry 全部方法逐个打 `✓` 到 **stderr** | `--data` |

> `call`/`stdio` 只接受 `--data` 是**硬约束**：业务参数全从 stdin params 来。
> 加别的开关会让「CLI 跑通」与「协议跑通」不再是同一件事。

**② 契约可选（2）**——命令**必须存在**，不支持时回 `not_supported` + 退出码 2

| 命令 | 语义 |
|---|---|
| `images` | `images.generate`（参考图 `--ref` 可重复 0~N 张） |
| `systemone` | `systemone.decide`（结构化决策） |

**③ 通用便利（8~10）**——所有渠道 CLI 都应有，形状固定

| 命令 | 语义 | 关键开关 |
|---|---|---|
| `chat` | 流式对话 | `--prompt/--cid/--model/--title` + 渠道特有 |
| `models` | 模型清单 | `--list`（只打 slug） |
| `user` | 当前账号信息 | `--raw` |
| `accounts` | 本地凭据列表（离线）/ 删除 | `--remove` |
| `auth` | 凭据状态 / 强制续期 | `--refresh` |
| `login` | 登录并落盘凭据 | 渠道特有 |
| `stats` | 本地统计流水汇总 | `--days` |
| `raw` | 直调上游接口（逃生门） | `--method/--path/--body/--param*` |
| `schema` | **机器可读契约自描述** | 无 |
| `version` | 版本信息 | 无 |

**④ 会话管理（6~7）**——有会话概念的渠道必备，命名固定

| 命令 | 语义 | 关键开关 |
|---|---|---|
| `conv-list` | 会话列表（内部翻页取全量） | `--limit/--offset/--grep` |
| `conv-show` | 会话详情（标题/时间/消息数） | `--cid` |
| `conv-history` | 单会话历史（按轮归并） | `--cid/--turns/--raw` |
| `conv-rename` | 改标题 | `--cid/--title` |
| `conv-delete` | 删会话 | `--cid`（**可重复**）`--yes` |
| `conv-stop` | 中止正在生成的回答 | `--cid` 或 `--message-id`（看上游语义） |
| `conv-read` | 标记已读（**仅当上游有此概念**） | `--message-id` |

**⑤ 渠道专属（可选）**——允许新增，但必须①在 `schema.commands` 里列出②有 `--help` 说明

例：chatgpt 的 `quota`（额度与限流）、`verify`（升级预警门禁）；
glm 的 `agents`（内置智能体表）。

> **禁止**：为了对齐而虚构上游没有的概念（如 chatgpt 不做 `conv-read`、glm 不做 `quota`）。
> 缺口写进 `schema.gaps`，比造一个假命令好。

---

## 3. 开关契约

### 3.1 契约通用开关（7）——`PLUGIN_CLI.md §3`

| 开关 | 语义 | 优先级 |
|---|---|---|
| `--data` | 数据目录 | flag > `$WW3_DATA` > **exe 所在目录**（绝不回退 cwd） |
| `--auth` | 凭据标识（= `<data>/auths/<name>.json`） | — |
| `--config` | 渠道配置 JSON（`@file` 读外置文件） | — |
| `--proxy` | 代理 URL | — |
| `--base-url` | 覆盖上游基址（离线 e2e 用） | — |
| `--timeout` | 秒 | — |
| `--help` | 用法 | — |

**`--auth` 的语义必须一致**：

| 取值 | 含义 |
|---|---|
| 不传 / 空串 | **匿名**（若上游支持）；不支持则报 `auth_error` |
| `auto` | 自动挑第一条未过期凭据 |
| `<name>` | 加载 `<data>/auths/<name>.json` |

> **不要做 `--anon` 开关**。匿名是「没给凭据」的后果，不是独立模式。
> chatgpt-cli 早期有 `--anon`，被用户判为累赘后删除（m04639 #2）。

### 3.2 外壳扩展开关（可选，允许渠道差异）

| 开关 | 用途 | 案例 |
|---|---|---|
| `--debug` | 打印调试日志到 stderr | 两者都有 |
| `--insecure` | 跳过 TLS 校验 | 两者都有 |
| `--tls-profile` | 指纹 profile（`chrome_152` 等） | chatgpt |
| `--identity` | 身份头族（`codex` 等） | chatgpt |
| `--no-cache` | 关全部磁盘缓存 | chatgpt |
| `--prefetch` | 并行预取下一轮对抗 token | chatgpt |
| `--allow-drift` | 对抗算法漂移时仍继续（缺省 fail-closed） | chatgpt |
| `--quiet` | 关进度事件 | 预留 |

### 3.3 命令专属开关

**必须遵守形状**：

- 可重复开关用 **`StrList`**（一个开关一个值，**不切逗号**）：
  `--ref a.png --ref b.jpg --ref <url>`。理由：data URI 本身合法含逗号。
- 布尔开关用 `--flag`（true）/ `--flag=false`（false），不用 `--no-flag` 反向命名（除 `--no-save`/`--no-cache` 这类历史命名）。
- 危险操作（删会话）必须 `--yes` 二次确认。

#### 3.3.1 思考档位必须叫 `--effort`（W3-32）

**开关名冻结为 `--effort`**，不得另造 `--think` / `--reasoning` / `--show-thoughts`。

| 层 | 值 | 谁定 |
|---|---|---|
| **通用（所有渠道必支持）** | `off` | 契约冻结 |
| **渠道特定** | 其余枚举（`auto`/`on`/`low`/`high`/`thinking`/`deep_thinking`/…） | 渠道自定，以 `schema.thinking.efforts` 与 `models.list` 的 `efforts` 为准 |

- **思考正文不做渠道级开关**：有就发 `reasoning` 事件，没有就不发（`result` 里的
  `reasoning_chars` / `thought` 已足够脚本判断）。
- **语义是 hint 级**：`off` 不保证上游不思考，`on|high` 不保证一定返回 CoT。
  必须在 `schema.quirks` 里如实写明（两案例都已写）。
- 别家枚举应**兼容降级而不是报错**（下游可能按别家口径发）：
  `low/medium/high/xhigh/max/minimal/ultra/true` → `on`；`none/false/disabled` → `off`；其余未知 → `auto`。
- 两个案例的枚举差异（合法）：

| 渠道 | `--effort` 值域 | 依据 |
|---|---|---|
| `glm2cli` | `thinking` / `deep_thinking`（与 `low/high/max` 两套写法） | 上游 `reasoning_effort` 直接接受这两个词 |
| `chatgpt-cli` | `off` / `auto`（缺省）/ `on` | free 号无分档（11 个模型 `thinking_efforts` 全 `[]`、`settings/user` 只有 `["instant"]`） |

---

## 4. 输出契约

### 4.1 事件模型（两个案例逐字段同构）

**单结构体 + `omitempty`**，字段顺序即输出顺序（比 map 稳定、比多结构体简单）。
机器只需一套解析器，未知字段忽略即可（`v:1` 前向兼容）。

```go
type Event struct {
    V    int    `json:"v"`    // 恒为 1
    Type string `json:"type"` // 9 种之一

    // 标识
    RequestID, ConversationID, MessageID, AgentID, Model string
    New bool   // true = 本次创建了会话（首轮）
    Cmd string // 产生该事件的命令名
    TS  int64  // Unix 秒

    // 流式增量
    Part, Delta, Text string   // Text 仅在 resync 纠正时出现

    // 生图
    URL, PolishedPrompt string
    Index int

    // 数据类命令载荷
    Data    json.RawMessage
    HasMore bool

    // 收尾统计
    Frames, ElapsedMS int; Finished bool
    Images []string; TextChars, ReasoningChars, Count int

    // 错误
    Code, Message, Detail string
    Retryable  *bool  // 指针：nil=不出现；error 事件恒出现，false 也要表达
    HTTPStatus, BizStatus int
}
```

### 4.2 九种事件

| type | 出现时机 | 关键字段 |
|---|---|---|
| `meta` | 拿到首帧后**立即**发（保证 `conversation_id` 是真实值而非占位） | `conversation_id`/`message_id`/`model`/`new` |
| `text` | 正文增量 | `delta`/`part`（= message_id） |
| `reasoning` | 思考链增量 | `delta` |
| `image` | 生图结果 | `url`/`index`/`polished_prompt` |
| `item` | **进度事件**（长耗时的阶段提示） | `data{step,detail,…}` |
| `result` | 每个命令**恒有一条**，最后一个 | `data`（命令载荷） |
| `done` | 流式命令的收尾 | `frames`/`elapsed_ms`/`text_chars`/`images` |
| `warn` | 非致命异常（**不终止流程**） | `code`/`message` |
| `error` | 终止错误 | `code`/`message`/`retryable`/`http_status` |

### 4.3 stdout / stderr 分工（硬红线）

| 通道 | 内容 |
|---|---|
| **stdout** | 只出 JSONL 事件（一行一条，`SetEscapeHTML(false)`） |
| **stderr** | 日志、`ping` 的 `✓` 行、`[结果]` 汇总、`--debug` 输出 |

**正文只出现一份**：`Proc.Out != nil` 时用 `RawFile`（只写文件），不要再 `Raw`（会写 stderr）。

### 4.4 退出码（8 值，两个案例同值同义）

| 值 | code | 含义 | 可重试 |
|---|---|---|---|
| 0 | — | 成功 | — |
| 1 | `upstream_error` | 上游业务/HTTP 错误、非 JSON（可能被 WAF 拦） | ❌ |
| 2 | `usage_error` | 用法错误（未知 flag、缺参数、非法取值、超长输入） | ❌ |
| 3 | `auth_error` | 凭据/鉴权失效（401、token 过期、匿名能力不足） | ❌ |
| 4 | `transient_rejection` | 风控软拒（可换号重试） | ✅ |
| 5 | `stream_truncated` | 流被截断（未收到 `[DONE]`） | ✅ |
| 6 | `rate_limited` | 限流/额度耗尽（429） | ✅ |
| 7 | `not_proven` | 对抗算法未通过（VM 不认识新 opcode / 指纹漂移 / 无法证明有效） | ❌ |

`Retryable() = (4 || 5 || 6)`。**7 刻意不可重试**：重试只会拿同一套失效算法再撞一次。

> **分类是契约的一部分**，不是实现细节。chatgpt-cli 曾把「Free plan limit」错报成
> `not_supported`（退出码 1），导致上层不换号——正确是 `rate_limited`（退出码 6）。

---

## 5. `schema` 命令：机器可读的契约自描述

**这是此类 CLI 最容易被忽略但最重要的命令**。上层（ww3 core / gateway / 运维脚本）
靠它判断能力边界，而不是靠读文档。

**必需字段**：

| 字段 | 内容 |
|---|---|
| `channel_id` / `version` / `protocol` | 身份与版本 |
| `commands[]` | 全部命令名 |
| `events[]` | 全部事件类型 |
| `exit_codes{}` | code → 数值 |
| `retryable[]` | 哪些 code 可重试 |
| `abilities{}` | **能力矩阵**（匿名 vs 登录，逐项 true/false + `trigger` 说明） |
| `gaps[]` | **明确不支持的项 + 原因** |
| `quirks[]` | **反直觉的行为**（消费方必须知道的坑） |

**`gaps` 与 `quirks` 是契约的一部分**，必须诚实填写：

```jsonc
// chatgpt-cli 的 gaps（7 条）
"没有 conv-read（chatgpt 无「标记已读」概念）",
"生图不接受 size/aspect_ratio（上游不收，只能在 prompt 里描述）",
"匿名通道不能生图（上游明确要求先登录）",
...

// chatgpt-cli 的 quirks（6 条）
"每轮对话前必须重走 sentinel 五步（token 一次性 + conduit 60s TTL）",
"图片产物是 sediment://file_… 指针，不是 http URL（两步换真 URL，签名会过期）",
"conv-stop 用 conversation_id 不是 message_id，且需当轮 conduit",
"续期只靠 GET /api/auth/session（业务请求不续期），无 refresh_token",
"chat.generate 的 messages 只放当前这一条 user 消息，历史由上游按 conversation_id + parent_message_id 自己拼",
"续轮不给 parent_message_id 时会自动回查会话详情取 current_node（零配额）",
```

**能力矩阵的写法**（chatgpt-cli 示例）：

```jsonc
"abilities": {
  "anon": {  // 匿名通道
    "trigger": "不提供 --auth（或 --auth 空串）即匿名",
    "chat": true, "search": true, "image": false, "image_ref": false,
    "models": ["gpt-6", "gpt-6-mini"],
    "limits": "单条约 24K token 或 122.9K 字符（双上限）；token 一次性，复用即 403"
  },
  "web": {   // 登录通道
    "trigger": "--auth <凭据标识>（或 --auth auto）",
    "chat": true, "multi_turn": true, "conv_manage": true,
    "image": true, "image_ref": true, "search": true,
    "limits": "free 号 reason 15 次/窗口；image_gen 6 次/日；file_upload 6 次/日"
  }
}
```

---

## 6. 数据目录契约

```
<data>/                       ← --data > $WW3_DATA > exe 所在目录（绝不回退 cwd）
├─ auths/                     ← 凭据（文件名即凭据标识 = --auth 参数 = core 的 account_uid）
│   ├─ <prefix>-<id>.json     ← 嵌套形 {auth:{...},account:{...}}；expiresAt 为 Unix 秒 int64
│   └─ flows/<flow_id>.json   ← 登录流程状态（撤 daemon 后 begin/status 在不同进程）
├─ logs/<name>.log            ← 日志（每行 fsync；落盘前必经 RedactJSON）
├─ stat/{stats,daily}.jsonl   ← 统计流水（每行 fsync；未上报 token 写 -1）
├─ cache/                     ← 磁盘缓存（可全关）
│   ├─ home.json              ← 首页 data-build + script src（TTL 30 分钟）
│   ├─ <token>-<账号>.json    ← 对抗 token（**读到即删**，一次性语义）
│   └─ <fp>-<账号>.json       ← 升级预警基线
└─ config.json                ← 可选：proxy / tls_profile / identity / timeout / base_url
```

**凭据格式与旧版 `wild-work.exe` 的 `auths/` 可互换**（这是刻意设计：用户可以
把旧版的凭据目录直接指给新 CLI 用，`--data <旧版 dist 目录>` 就生效）。

---

## 7. 两个案例的差异矩阵

| 维度 | glm2cli（智谱清言） | chatgpt-cli（ChatGPT） |
|---|---|---|
| **命令数** | 23 | 24 |
| 契约 4 + 可选 2 | ✅ 全有（`systemone` 恒 not_supported） | ✅ 全有（同） |
| 会话管理 | 7 个（含 `conv-read`） | 6 个（**无 `conv-read`**，上游无此概念） |
| 渠道专属 | `agents` | `quota`、`verify` |
| **`--proxy`** | ✅ 支持（W3-47 合并自 glm-ext：`glm.Opt.Proxy`，空则跟随 `HTTPS_PROXY`） | ✅ 支持 |
| `--tls-profile`/`--identity` | ❌ | ✅ |
| **登录范式** | `form`（粘贴 refresh_token） | 导入浏览器 Cookie + access_token |
| **多轮定位符** | `conversation_id`（线） | `conversation_id` + **`parent_message_id`**（树） |
| **匿名通道** | ❌ 必须登录 | ✅ **一等形态**（同一套算法，只是 base path 不同） |
| **参考图** | 拼版 + 第三方图床（绕 WAF） | **原生多图**（N 个 `image_asset_pointer`） |
| **产物形态** | URL（上游直接给） | `sediment://` 指针（两步换真 URL） |
| **用量** | `left_score` 余额（积分） | 无 token 用量，只有 `limits_progress` 额度计数 |
| **思考档位** | `--effort thinking/deep_thinking` | `--effort off/auto/on`（缺省 auto）；枚举各自自定，`off` 是共有通用值 |
| **首字延迟** | 首 token 即上游首 token | 冷启动额外 2~6 秒；靠缓存 + 预取压到接近 0 |
| **升级预警** | 无 | `verify` + 每轮指纹对比（三档 fatal/block/warn） |
| `schema` 丰富度 | 6 字段 | 11 字段（多 `abilities`/`gaps`/`quirks`/`cache`/`drift_guard`） |
| **IPC 方法数** | 18 | 20（多 `accounts.refresh`/`accounts.resource_detail`） |
| 代码规模 | 4721 行 + 7881 行（含测试） | 8770 行自研 + 3728 行协议副本 |

**差异的合法来源**：上游能力不同（chatgpt 有匿名/原生多图/树状会话，glm 有积分/智能体）。
**差异的非法来源**：外壳行为不一致（退出码、事件形状、开关命名）——这些必须同构。

---

## 8. 新增渠道 CLI 的落地清单

### 8.1 必做（缺一即不算完成）

- [ ] `internal/protocol/` 从本仓 **整目录复制**（或直接 `go get github.com/wild-work3/ww3-protocol`）
- [ ] `cmd/<name>/main.go` 只有 `cli.Main(os.Args[1:])`
- [ ] 契约 4 命令 + 可选 2 命令（不支持时命令仍在，回 `not_supported` + 退出码 2）
- [ ] 7 个契约开关（`--proxy` 不支持就写进 `gaps`）
- [ ] 9 种事件 + 单结构体 `omitempty` + `v:1`
- [ ] 8 个退出码，`Retryable() = (4||5||6)`
- [ ] `schema` 命令含 `abilities`/`gaps`/`quirks`
- [ ] 数据目录三子目录 `auths`/`logs`/`stat` + `cache`
- [ ] 日志落盘前 `RedactJSON`（零 token 落盘）
- [ ] `ping` 枚举全部方法（glm 18 个 / chatgpt 20 个，全 ✓）

### 8.2 有会话概念时追加

- [ ] `conv-list/show/history/rename/delete/stop`（`--cid` 可重复、删除要 `--yes`）
- [ ] `conv-read` **仅当上游真有「已读」概念**，否则写进 `gaps`
- [ ] `chat --cid` 续聊，`--parent` 可省略（自动取当前分支叶子）

### 8.3 有对抗算法时追加

- [ ] `verify` 命令（`--offline` 只读快照，漂移退码 7）
- [ ] 指纹基线落盘 + 每轮对比 + **fail-closed 不落盘新基线**
- [ ] 高敏感调用（生图上传/非匿名对话）前置 `EnsureFresh`
- [ ] 缓存 token 的前置条件是「指纹新鲜」，否则缓存可绕过门禁
- [ ] `chat --dry-run`（跑到对抗算法最后一步就停，验证算法是否仍有效）

### 8.4 自测顺序（分层验证，不许跳步）

```
1. manifest / ping          → 方法表齐全
2. call + chat.generate     → IPC 通
3. chat --dry-run           → 对抗算法通（零配额）
4. chat（匿名，如支持）      → 端到端通
5. login → user → chat      → 登录通道通
6. images / images --ref    → 多模态通
7. conv-*                   → 会话管理通
8. schema                   → 契约自描述完整
```

**每步都是真实上游**，不用 mock 替代——mock 只能验证解析逻辑，验证不了对抗算法。

---

## 9. 红线（沿用 `PLUGIN_CLI.md` + 本层补充）

- ⛔ stdout 只出协议事件；日志/进度/汇总走 stderr
- ⛔ 零 token 落盘（`RedactJSON` 递归遮蔽 key/token/secret/password/authorization/cookie）
- ⛔ **不存在「CLI 专用捷径」**：便利命令必须 spawn 自身 `call` 子进程走真实 IPC
- ⛔ 流式截断不得伪造 `[DONE]`（R36）
- ⛔ 不虚构上游没有的能力（缺口写 `gaps`，不造假的命令）
- ⛔ 不把 HTTP SSE 当内部传输协议（JSONL ≠ SSE）
- ⛔ 已发出部分响应后不得透明重放整段生成（W3-10）
- ✅ 契约变更必须走版本协商（`v:1` 前向兼容：未知字段忽略、未知事件忽略）
- ✅ `schema` 必须与实际行为一致（`gaps`/`quirks` 撒谎比不写更糟）

---

## 10. 与 `PLUGIN_CLI.md` 的关系

| 文档 | 管什么 |
|---|---|
| `PLUGIN_CLI.md` | **进程形态**：`call`/`stdio` 两态、开关优先级、数据目录三子目录、凭据格式 |
| `PLUGIN_PROTOCOL.md` | **RPC 层**：方法名、params/result 形状、能力声明、错误 kind |
| **本文** | **命令界面层**：命令命名、开关形状、事件模型、退出码、`schema` 结构 |

三者的关系是**逐层收窄**：进程形态 → RPC 契约 → 命令界面。
一个渠道 CLI 三者全对才算合规；本文档补的是前两份没覆盖的「人怎么用、脚本怎么解析」。
