# 渠道插件命令行契约（PLUGIN_CLI v1）

> 权威文档。对应决议 **W3-21（CLI 形态）/ W3-22（插件数据目录与统计）/ W3-30（标准可选能力命令）**。
> 适用对象：所有渠道插件与拦截器插件。**目录/仓库/可执行文件的名字无固定定义，由开发者自己定**
> （用户 m00634/m00642：不能假定插件后缀一定是 `-ext` / `-hook`）；本文与样例里用 `*-ext`（渠道）、
> `*-hook`（拦截器，不带 `-ext`，W3-25）只是为了**一眼能看出分类**，属建议而非约束。
> 真实身份以包内 `manifest.json` 的 `id` 为准。拦截器命令集不同（多 `hook.stream` 会话面方法，见 `docs/HOOK_PROTOCOL.md`）。
> 相关文档：`PLUGIN_PROTOCOL.md`（RPC/IPC 契约）、`IPC_CHAT.md`（对话流式契约）、`AUTH_FLOW.md`（登录范式）。

---

## 0. 一句话

**`<plugin>.exe <command> --switch value`** —— 命令是裸名（无减号），开关一律双短横线，
不接受位置参数。插件数据目录固定为 `<data>/{auths,logs,stat}`。

---

## 1. 为什么要自己定一层外壳

需求来源（W3-20/21）：

1. **不能假定目标机器 65ms 能起一个进程** → 渠道插件全部 one-shot，每次调用一个新进程，
   因此「怎么调」必须极简且可预测。
2. **插件同时是核心的调用目标与人的调试工具** → 两条路径必须走同一份实现，
   不允许存在「CLI 专用捷径」（否则 CLI 跑通不代表协议跑通）。
3. **参数只由 core 与脚本传，不面向人类手打** → 不要 `-h`/`-d` 这类单字母简写，
   不要 `-mode xxx` 这种二段式；多用 5 个字符换可读性与 grep 友好。

所以：`--data`、`--auth` 这类开关**永远全名**；命令名**不带前导减号**
（Go 标准 `flag` 只处理 `-x` 形式的开关，位置参数天然就是命令名）。

---

## 2. 命令契约（所有渠道插件必须实现）

| 命令 | 必需 | 语义 | 开关 |
|---|---|---|---|
| `call` | ✅ | **协议本体**：stdin 读**一帧** `invoke` → 写事件 + 一帧 `result` → 退出。core 的唯一调用方式 | 仅 `--data` |
| `stdio` | ✅ | **协议本体**：stdin/stdout 上跑 JSONL RPC 循环直到 EOF。供自测/调试；core 对渠道插件不用它 | 仅 `--data` |
| `manifest` | ✅ | 把 manifest.json 打到 stdout（`--out` 可写文件）；渠道插件可声明安装默认 `default_channels`（见下文） | `--out` |
| `ping` | ✅ | 控制面逐项自检，结果打 stderr（`✓/✗ method`） | 见 §3 |

`call` 与 `stdio` 都调用**同一份 `plugin.Registry`**（方法表），差异只在收发循环：
`call` 读一帧就退，`stdio` 循环。`call` **不支持持续 stdin**——一次进程只服务一次 invoke，
这是进程回收语义的前提（W3-03 一请求一进程）。

> 想「连续问同一个进程」请用 `stdio`（拦截器场景）或直接写脚本反复起 `call`（渠道场景）。

### 2.0.1 `manifest` 的默认渠道声明

`manifest` 输出与安装包中的 manifest 均可包含 `default_channels` 数组：

```json
{"id":"custom-api","kind":"channel","default_channels":[{"id":"custom-api","name":"自定义模型"}]}
```

每项 `id` 为渠道实例 ID（不是插件 ID/模型前缀），`name` 为显示名称，`config` 为初始配置对象（空配置经 Go `omitempty` 序列化可省略，等同 `{}`）；Go 类型对应 `meta.Manifest.DefaultChannels []meta.DefaultChannel{ID,Name,Config}`。一个插件可声明多条渠道实例，每条可有多个账号；省略/空数组不自动添加，hook 不声明。安装只新增缺失的默认渠道，不覆盖已有渠道配置、名称、启停状态或账号；升级/回滚同样不得重置。官方 `custom-api` 的空配置仅用于占位，缺 `base_url`、`api_key` 时不可使用；旧版自定义模型已有配置保留兜底，用户须填写并验证后再启用新占位。完整生命周期与兼容约束见 `PLUGIN_PROTOCOL.md §3.1.1`。

卸载只删除安装树中的插件二进制与 manifest，**不删除** core 的渠道配置/账号记录或 `<data>/auths/` 凭据；缺插件期间渠道不可调用，重装同一插件 ID 即恢复旧渠道/账号/凭据，并补齐尚不存在的默认渠道。删除数据需用户显式操作，不能由 `manifest` 或卸载隐式完成。

## 2.1 标准可选能力命令（W3-30）

除 §2 的四个必需命令，契约还固定两个**可选能力命令**。它们与 RPC 方法一一对应（参数/结果
形状见 `PLUGIN_PROTOCOL.md §5.8`），**命令名、开关名、背后的方法名一律不得改**；渠道不支持时
按 §2.1.2 返回，不得自创命令名。

| 命令 | 背后方法（仍 spawn 自身 `call`） | 语义 | 当前已支持渠道 |
|---|---|---|---|
| `systemone` | `systemone.decide` | 结构化决策（noul/choice/score），**非流式**、一次一答 | oczen（Jev `jev-1.13-free`） |
| `images` | `images.generate` | 生图，**非流式**；`--ref` 传 0~N 张参考图，无参考图即文生图 | glm（出图 + 改图） |

### 2.1.1 开关（§3 的通用开关同样适用）

| 命令 | 开关 | 语义 |
|---|---|---|
| `systemone` | `--state <文本>` | 必填。判定上下文；无上下文写 `--state ""`（上游要求该键存在，空串合法） |
| | `--questions <json\|@file>` | 必填。问题字典（同 `params.questions`）；`@file` 从文件读，与 `--config` 同机制 |
| | `--model <id>` | 决策模型；缺省由插件固定。未知模型由插件拒（`model_blocked`），CLI 不校验 |
| `images` | `--prompt <文本>` | 必填 |
| | `--n <num>` | 期望张数，缺省 1（上游单批多张时插件自行截断） |
| | `--size <WxH\|auto>` | 尺寸（OpenAI 形状）。非法值由**插件**报错，CLI 不校验 |
| | `--ratio <w:h>` | 比例形状；与 `--size` 同时给出时 `--ratio` 优先 |
| | `--ref <url\|路径\|dataURI>` | 参考图，**可重复出现任意多次**（`--ref a.png --ref b.jpg`），按给出顺序编号为第 1..N 张 |
| | `--format <b64_json\|url>` | 产物形态，缺省 `b64_json`（直链会过期） |
| | `--out-dir <dir>` | 落盘目录，缺省 `<data>/images/`，文件名 `<created>-<i>.<ext>`；`--no-save` 只回 JSON 不落盘 |
| 两者 | `--raw` | 原样打印插件返回的 result（默认 `systemone` 打 `answers`、`images` 打落盘路径清单） |

- `--ref` **一个开关只对应一张图**，要传多张就重复写（不设上限）。**不得用逗号切分值**——
  data URI 与部分预签名 URL 本身合法地含 `,`（如 `data:image/png;base64,iVBOR…`），按逗号切会拆坏图片。
  一次都不给 = 文生图。
- 每个 `--ref` 的值可以是本地路径、http(s) URL 或 data URI。本地路径由命令读文件转成
  `{"b64_json","mime_type"}`，mime 从扩展名推（png/jpg/jpeg/webp/gif/bmp）；**推不出就报错，不猜 mime**。
  **IPC params 里绝不会出现本地路径**——插件可能在另一台机器上被拉起（§5「不依赖 cwd」同理）。
- 多张的**语义编号**（第几张叫 reference1）由给出顺序固定，后续拼版/直传都按这个顺序，不得重排。
- 多张参考图怎么用（原生多图 / 拼版 / 逐个改图 / 图床托管）**全由插件决定**，CLI 与 core 都不参与（W3-30）。
- `--auth` 与 `chat` 同义：省略时由插件按自己的账号策略选号（匿名渠道如 oczen 本来就没凭据）。
- 正文走 stdout（可管道），日志与 `[结果] ok=…` 汇总行走 stderr 与 `<data>/logs/`（与 `chat` 命令同一规则）；
  **参考图的 base64 绝不落日志**（只记张数与字节数，W3-07）。

示例：

```bash
# 结构化决策（无参考图概念，一问一答）
x.exe systemone --data ./data --auth oczen-anonymous \
  --state "用户工单：付款后被要求等待 3 天发货…" \
  --questions '{"refund":{"type":"noul","criteria":{"true":"应退款","false":"不应退款"}},
               "team":{"type":"choice","criteria":{"billing":"账务","tech":"技术","sales":"售前"}}}'

# 文生图（3 张 1:1）
x.exe images --data ./data --auth glm-308790 --prompt "一只戴帽子的柴犬" --n 3 --ratio 1:1

# 参考图生图（2 张本地参考图 + 1 张公网图，由插件决定拼版还是多图直传）
x.exe images --data ./data --auth glm-308790 --prompt "把参考图1的人物放进参考图2的场景" \
  --ref ./a.png --ref ./b.jpg --ref https://cdn.example.com/c.png --out-dir ./out
```

> 实现注：多值开关由 `cli` 的 `Command.StrList(name, usage) *[]string` 承载
>（同名开关每出现一次 append 一个，保持顺序，**不做逗号切分**；一次不给 = 空切片非 nil）。
> 已实现并同步到各独立仓的 `internal/protocol/cli/` 副本（W3-28），有单测 `flags_test.go`（多值累积 + 不切逗号 + 缺省空切片）。

### 2.1.2 不支持的姿势（渠道必须照做，不得 panic、不得静默成功）

1. manifest `capabilities.control` **不声明**该能力 → core 的 `hasCap` 先行拦住，回可读提示
   「渠道 X 不支持生图」（W3-30，与现有 `checkin`/`refresh` 同一处理）；
2. 方法**仍要注册**，被调到时返回 `kind=not_supported`、`scope=channel`，消息形如
   `glm 渠道不支持结构化决策`（新增稳定错误码，`errkind.Rotatable("not_supported")=false`，
   core 不会因此换号或冷却）；未注册时框架默认回 `not_found`/`unknown method`，语义等价；
3. 命令**仍要存在**（缺命令会让脚本先撞 `unknown command`，更难读）：执行后 stderr 打同一条不支持消息，
   **退出码非 0**，不落盘、不写成功流水。

> 实现建议：`plugin` 提供 `Registry.HandleUnsupported(method, 中文名)` 一行注册兜底，
> 插件不必自拼返回体。独立仓插件的 `internal/protocol/` 副本同步即可（W3-28）。

## 3. 通用开关（契约）

| 开关 | 适用命令 | 语义 |
|---|---|---|
| `--data <dir>` | 全部 | 插件数据目录（`auths/`、`logs/`、`stat/` 的父目录）。**core 永远传 `<core data>/plugins/<plugin_id>`**（W3-39：与安装树分离，卸载/回滚碰不到数据）。缺省：`$WW3_DATA` → exe 所在目录 |
| `--auth <name>` | 需要凭据的命令 | 凭据文件名**不含 `.json`**，即读 `<data>/auths/<name>.json`。例：`--auth workbuddyai-wb-uid-001` |
| `--config <json>` | `call` 之外的便利命令 | 渠道配置 JSON（`base_url`/`api_key`/`region`/`proxy`/`timeout`…）。`--config @file` 从文件读。让 CLI 脱离 core 也能调插件 |
| `--proxy <url>` | 同上 | 出站代理 |
| `--base-url <url>` | 同上 | 上游基址覆盖（联调 / 自建反代 / mock） |
| `--timeout <sec>` | 同上 | 上游整体超时（流式用 idle 看门狗，此值只约束非流式请求） |
| `--help` | 全部 | 打印本命令帮助 |

开关取值优先级：**flag > `WW3_*` 环境变量 > 缺省**。`--data` 也接受 `WW3_DATA`，
但 core 一律用 flag 传（显式优于隐式；子进程曾因漏传 `--data` 把凭据写到 cwd）。

`call`/`stdio` 只有 `--data`：协议本体的一切业务参数都从 stdin 的 `params` 里来
（`channel_config`、`account_uid` 等，见 `PLUGIN_PROTOCOL.md §5.2.1`）。
**不要给 `call` 加业务开关**——那会让「CLI 能跑、core 不能跑」重新出现。

### 3.1 思考档位（`--effort`，W3-32）

便利命令需要暴露思考档位时，**开关名固定为 `--effort`**（不得叫 `--think` / `--reasoning` /
`--thinking-budget`），值域分两层：

| 层 | 值 | 谁定 |
|---|---|---|
| **通用（所有渠道必支持）** | `off` | 契约冻结 |
| **渠道特定** | `auto` / `on` / `low` / `medium` / `high` / `xhigh` / `tiered` / … | 插件在 `models.list` 的 `efforts` 里声明 |

IPC 字段是 `reasoning_effort`（主流口径：OpenAI Chat Completions / DeepSeek / Qwen / GLM 都用它；
Anthropic 的 `thinking:{type,budget_tokens}` 是对象、Gemini 的 `thinkingConfig.thinkingBudget` 是数字，
两者都不作为本契约字段）。`thinking: bool` 是 ww3 早期简化，**仅为兼容保留**，新插件应优先读 `reasoning_effort`。

**语义是 hint 级，不是开关**——这一点必须在插件实现与 `schema` 里都如实声明：

- `--effort off` **不保证**上游真的不思考（例：`gemini-ext` 实测上游「关闭思考」是假关，
  关掉照样思考照样计费；`loomy-ext` 的模型是强制思考型，三件套只能把思考从 98 字降到 59 字）；
- `--effort on|high` **不保证**上游一定返回 CoT（例：`chatgpt-cli` 实测 4 次 `on` 有 2 次
  `turn_use_case=text`、零思考正文，上游按题目难度自决）。

因此：

1. **插件不得因为收到 `off` 就不发 `reasoning` 事件**，也不得因为收到 `on` 就伪造 `reasoning` 事件
   （R36/W3-10：不得伪造内容）；一切以上游实际返回为准。
2. `models.list` 的 `efforts` 字段是**面板下拉框与参数校验的唯一依据**：
   上游声明了才填，未声明就留 `nil`（不编造）；`default_effort` 必须落在 `efforts` 内，否则视为未声明。
3. `can_disable_thinking=false` 用于表达「假关」——客户端可传 `off`，但插件如实告知上游不认。

命令实现示例（`chatgpt-cli`）：`--effort off|auto|on`，缺省 `auto`；`low/high/max` 等别家枚举
自动降级为 `on`（不报错，因为下游可能按别家口径发）。

## 4. 插件自定义命令与开关

除 §2 的四个命令外，插件可自行增加便利命令（`models`/`chat`/`login`/`status`/`accounts`/
`credits`/`checkin`…）。约束：

1. 自定义命令**必须**是 `ping` 之类便利层，内部一律 spawn 自身 `call` 子进程走真实 IPC；
2. 自定义命令**不得**引入新的能力语义（能力由 manifest 声明，走 `call` 的 `params`）；
   例外：§2.1 的 `systemone` / `images` 是**契约规定的标准命令**，命令名与方法名固定，不属于自定义；
3. 自定义开关名不得与 §3 冲突；同名必须同义。

实测命令集见 §7。

## 5. 数据目录契约（W3-22 / W3-39）

`<data>` 的形状是契约，**取值由 core 决定**：`<data> = <core --data>/plugins/<plugin_id>`。
安装树 `<plugins>/<plugin_id>/<version>/` 里只有 exe + `manifest.json`，不放任何可变量——
这样「升级/回滚只换二进制」「卸载可整**安装**目录删且不碰数据」「备份＝拷一份 core 数据目录」三条同时成立。卸载必须保留 `<core --data>/plugins/<plugin_id>`（尤其 `auths/`）、core 渠道配置和账号记录；重装同 ID 插件复用这些数据（见 §2.0.1）。

```
<data>/                      ← core 传 <core data>/plugins/<plugin_id>
├─ auths/                    ← 凭据（文件名即凭据标识，见 §5.1）
│   ├─ workbuddy-wb-uid-001.json
│   └─ workbuddyai-wb-uid-001.json
├─ logs/
│   └─ <plugin_id>.log       ← 插件日志（每行带毫秒时间戳，写后即 fsync）
└─ stat/                     ← 渠道自记统计（§6）
    ├─ stats.jsonl           ← 逐条流水（append-only）
    └─ daily.jsonl           ← 按日聚合的派生视图（可删，会自动重建）
```

三个子目录名**是契约**，不得改名；`<data>` 下其余内容插件自定（如 cookie/profile 缓存）。

归属边界（W3-39）：
- **一插件一根**，以插件 ID 为界。插件之间不得互读对方的 `<data>`（W3-07）；ID 由插件商店
  登记保证唯一（**以包内 `manifest.json` 的 `id` 为准**；老插件仓习惯用「仓库名去 `ww3-` 前缀与
  `-ext`/`-hook`/`-cli` 后缀」派生，如 `ww3-workbuddy-ext` → `workbuddy`，但这只是命名建议，
  不是派生契约：`ww3-chatgpt-cli` 的 id 是 `chatgpt`。不一致则 `store.Install` 拒装，见 `PLUGIN_REGISTRY.md` §1.3）。
- **core / gateway 可直接读**这些目录（展示凭据、聚合统计、取日志），插件 ID 即归属前缀。
- **数据文件的跨版本兼容性由插件自己保证**：`<data>` 里不掺版本号，升级换了 exe 仍读写同一批
  文件，所以新增字段要能容错读取、废弃字段要能忽略。
- 旧布局（可变量混在安装根 `<plugins>/<id>/{auths,logs,stat}`）由 core 在 `Discover()` 时自动
  迁移（`runtime.preparePluginData`）：目标已存在同样子目录则**不覆盖**，只记一条待人工合并。

- **日志**：`logs/<plugin_id>.log`。stdout 永远只走协议/正文，日志只能进文件和 stderr（§9 红线）。
- **凭据**：只有 `auths/` 一处，不再有其他凭据目录（早期版本的 `<data>/creds/<plugin_id>/`
  已废弃，见 §5.3 迁移）。

### 5.1 凭据文件（兼容旧版 `wild-work.exe`）

- 位置：`<data>/auths/<凭据标识>.json`；**凭据标识 = 文件名去掉 `.json`**，
  它就是 `--auth` 参数、也是 core 的 `account_uid`。
- 命名规则：`<渠道前缀>-<账号标识>`。渠道前缀与模型命名空间一致（`workbuddy` / `workbuddyai`
  / `qoder` / `traework`…）。**双区渠道靠前缀区分**——这正是旧版的做法
  （`auths/workbuddy-*.json` 与 `auths/workbuddyai-*.json` 并存，同一自然人两区 uid 相同也不冲突）。
- 格式：**旧版嵌套形**（`dev/internal/auth/auth.go:241 saveAtomicLocked`）：
  ```json
  {
    "auth": {
      "accessToken": "...", "refreshToken": "...",
      "expiresAt": 1793000000, "domain": "www.workbuddy.ai",
      "apiHost": "", "machineId": "", "deviceId": "",
      "machineToken": "", "machineType": "",
      "signingSecret": "", "consoleCookie": "", "baizhiCookie": "", "extra": null
    },
    "account": { "uid": "wb-uid-001", "enterpriseId": "ent-9", "nickname": "测试账号" }
  }
  ```
- **读取**必须同时兼容**扁平形**（CPA 面板格式：顶层直接 `accessToken`/`refreshToken`/`expiresAt`/`uid`/`nickname`），
  用「有无 `auth` 键」判别（`dev/internal/auth/auth.go:121 Parse`）。
- **写入**必须写嵌套形（旧版回写时保持嵌套，便于两版共存互换）。
- **`expiresAt` 是 Unix 秒（int64 数字），不是 RFC3339 字符串**——这是 ww3 早期实现
  与旧版不兼容的地方，已按旧版改正。缺该字段视为「未知过期」，不要臆造。
- 不用的字段保留键、写空串/null（旧版 `saveAtomicLocked` 如此），这样旧版读回不丢信息。
- 原子写：`tmp + rename`，mode `0600`；目录 `0700`。

### 5.2 「凭据标识」在全链的贯通

```
插件登录成功 → 写 auths/<prefix>-<标识>.json → authflow.Account{auth_file:"<prefix>-<标识>"}
  → core 落库 Account{UID:"<auth_file>@<channel_id>", RemoteUID:"<auth_file>"}
    → core 调插件 chat.generate 时 account_uid = "<auth_file>"
      → 插件按 --auth / account_uid 直接拼 auths/<...>.json 路径，无需再扫目录
```

好处：core 不再需要管「插件侧 uid 会不会撞」，撞了也是两个不同文件名。

### 5.3 迁移说明（不兼容点）

| 旧（ww3 早期实现） | 新（W3-21/22） | 处理 |
|---|---|---|
| `<data>/creds/<plugin_id>/<uid>@<region>.json` | `<data>/auths/<prefix>-<标识>.json` | 目录迁移；文件名改用前缀区分区域 |
| `expiresAt` 为 RFC3339 字符串 | Unix 秒数字（旧版格式） | 读兼容两种，写统一数字 |
| account_uid = 插件侧 uid | account_uid = 凭据标识 | core 落库时一并迁移（RemoteUID） |

## 6. 统计契约（W3-22）

插件在 `<data>/stat/` 记**渠道事实**，core 聚合后给面板用（「用量与流水」+「运行统计」）。
对齐旧版两个面板需要的数据（`dev/cmd/wild-work/web/index.html:100-175`、
`dev/internal/ledger/ledger.go`、`dev/internal/stats/stats.go:188 Snapshot`），
渠道侧能知道、core 不知道的事实是：**上游真实缓存命中、积分包消耗、单次调用耗时/首字**。

### 6.1 `stats.jsonl` 逐条流水

一行一条 `stat.Record`（见 `stat/stat.go`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ts` | string | RFC3339（本地时区） |
| `kind` | string | `chat` / `credits` / `checkin` / `models` / `auth` / `image` / `systemone`（后两个 W3-30） |
| `channel` | string | 插件 ID |
| `instance` | string | 渠道实例 ID（插件不知道时留空，core 聚合时补） |
| `account` | string | 凭据标识（`auths/` 文件名无后缀） |
| `region` | string | 区域（多区渠道） |
| `model` | string | 上游模型名（不含命名空间前缀） |
| `ok` | bool | 是否成功 |
| `err_kind` | string | 失败时的 `errkind` |
| `prompt_tokens` / `completion_tokens` / `total_tokens` | int | 上游上报值；**未上报写 `-1`** |
| `cached_tokens` | int | 缓存命中；未上报 `-1` |
| `cached_reported` | bool | 上游是否**明确**上报了缓存字段（区分「0」与「没说」） |
| `credits_delta` | number? | 本次观测到的积分变化（负=消耗）；`null` = 未观测 |
| `credits_remain` | number? | 观测到的剩余额度 |
| `time_ms` / `first_token_ms` | int | 总耗时 / 首字耗时 |

写入要求：**每条 `fsync`**（联调常强杀进程取证）；写失败静默（统计 fail-open，不影响对话）。

### 6.2 `daily.jsonl` 派生聚合

按 `(day, kind, channel, account, model)` 聚合：`requests`/`ok`/`errors`/`prompt_tokens`/
`completion_tokens`/`total_tokens`/`cached_tokens`/`credits`/`avg_time_ms`。
派生文件，**可以删**（下次 Append 重建）；不要把它当唯一数据源。

### 6.3 上报给 core

能力 `stats.get`（控制面，可选）：

```json
// params
{ "days": 7, "config": {...} }
// result —— stat.Summary
{ "requests": 128, "ok": 126, "errors": 2,
  "prompt_tokens": 51200, "completion_tokens": 8100, "total_tokens": 59300,
  "cached_tokens": 20480, "credits": -12.5,
  "days": [ { "day": "2026-10-22", "requests": 20, "ok": 20, "errors": 0,
              "prompt_tokens": 8000, "completion_tokens": 1200, "total_tokens": 9200,
              "cached_tokens": 3200, "credits": -1.5 } ] }
```

core 侧新增 `GET /core/stats/channels?days=N` = 各插件 `stats.get` 的合并视图
（按渠道 + 按日）。聚合口径固定：**只统计 `kind=chat`**；`-1`（未上报）不计入分母，
与「缓存命中率 = cached / 上报了缓存的 prompt tokens」一致（旧版同一口径）。

## 7. 开关适用矩阵（实测，随插件演进更新）

| 开关 | call | stdio | manifest | ping | models | chat | login | status | accounts | credits/checkin | systemone | images |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `--data` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `--auth` | — (走 params) | — | — | — | ✅ | ✅ | — | — | — | ✅ | ✅ | ✅ |
| `--config` | — (走 params) | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `--base-url` | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `--proxy` | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `--timeout` | — | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✅ | ✅ |
| `--out` | — | — | ✅ | — | — | — | — | — | — | — | — | — |
| `--model` / `--prompt` / `--raw` | — | — | — | — | — | ✅ | — | — | — | — | ✅ | ✅ |
| `--region` | — | — | — | ✓ | ✓ | ✓ | ✅ | ✅ | ✓ | ✓ | ✓ | ✓ |
| `--flow` / `--wait` | — | — | — | — | — | — | ✅/✅ | ✅/— | — | — | — | — |
| `--state` / `--questions` | — | — | — | — | — | — | — | — | — | — | ✅ | — |
| `--n` / `--size` / `--ratio` / `--ref`（可重复） / `--format` / `--out-dir` | — | — | — | — | — | — | — | — | — | — | — | ✅ |

✅ = §3/§2.1 契约开关；✓ = 插件自定义但推荐统一；— = 不适用（给了会报「flag provided but not defined」）。

> `systemone` / `images` 两个命令本身是契约（§2.1），但**能力可选**：不支持的插件也必须让命令存在并回 `not_supported`。

## 8. 契约 vs 插件自定义（分界）

| 类别 | 归属 | 说明 |
|---|---|---|
| 命令 `call` / `stdio` / `manifest` / `ping` | **契约** | 必须实现，语义固定 |
| 命令 `systemone` / `images` | **契约（能力可选）** | §2.1；必须存在且语义固定，不支持时回 `not_supported`、退出码非 0 |
| 命令 `models` / `chat` / `login` / `status` / `accounts` / `credits` / `checkin` | 自定义 | 推荐统一命名，可增删 |
| 开关 `--data` / `--auth` / `--config` / `--proxy` / `--base-url` / `--timeout` / `--help` | **契约** | 必须实现且语义一致 |
| 开关 `--state` / `--questions` / `--n` / `--size` / `--ratio` / `--ref` / `--format` / `--out-dir` | **契约** | §2.1.1，只作用于 `systemone` / `images` |
| 开关 `--region` / `--flow` / `--wait` / `--model` / `--prompt` / `--raw` / `--out` | 自定义 | 同名必须同义 |
| `<data>/auths`、`<data>/logs`、`<data>/stat` | **契约** | 目录名与用途固定 |
| `<data>` 下其他目录 | 自定义 | 插件私有（cookie/profile 缓存等） |
| `auths/*.json` 格式（嵌套形 + 扁平兼容 + `expiresAt` Unix 秒） | **契约** | 必须与旧版互读 |
| `stat/stats.jsonl` 字段 | **契约** | 必须产出 `chat` 流水；其余 `kind` 可选 |
| 能力名（`models.list`、`auth.*`、`stats.get`…） | **契约** | 见 `PLUGIN_PROTOCOL.md` |
| 模型命名空间前缀 | **契约** | `<channel>/<model>`，与 `auths/` 前缀一致 |
| 通用请求归一化（developer→system / 出站脱敏 / `max_completion_tokens` 翻译 / tool 配对清理） | **不归插件**（W3-35） | 由 gateway 统一规则引擎执行，插件**不得再实现一遍**；见 §8.1 |

命令集外的**任何行为**（比如某渠道特有的一次性调试命令）都算自定义，不得被 core 依赖。

### 8.1 渠道特有替换规则：用配置，不要写代码（W3-35）

网关在入站已统一执行一份**默认规则集**（`main/rules/default_rules.json`，11 条）与用户的 `rules` 覆盖段：

- 无 `scope.channels` 的规则 → **Pass A**，在 gateway 路由前对统一 chat JSON 执行；
- 带 `scope.channels` 的规则 → **Pass B**，在 core 确定候选渠道后、调用插件前执行（每次从 pristine 请求重建）。

因此**插件不需要再自己实现文本改写/脱敏**。如果某渠道有特殊替换需求，请在插件 README 或代码注释里给出**可粘贴的规则片段**，而不是写一遍通用功能：

```json
{
  "rules": {
    "acme.internal-cli-identity": {
      "kind": "regex",
      "regex": "You are Acme's internal CLI",
      "replacement": "You are a terminal assistant",
      "anchor": "You are Acme",
      "scope": { "channels": ["acme-cn"] },
      "order": 1000
    },
    "acme.drop-billing-header": {
      "kind": "jsonpath",
      "jsonpath": "$.messages[0].content",
      "regex": "(?i)x-acme-billing:[^;\\n]*;?\\s*",
      "replacement": "",
      "anchor": "x-acme-billing",
      "scope": { "channels": ["acme-cn"] },
      "order": 1010
    }
  }
}
```

要点：

- **必须给 `anchor`**：正则字面前缀，命中不了直接跳过。不填会让每条规则对每个字符串跑一次正则，
  实测 10 条无 anchor 规则扫 4MiB base64 图片请求 **252ms**（带 anchor 3.35ms，差 75 倍）。
- **`kind=jsonpath` 的路径是受限的**：只支持 `$.field` / `['field']` / `[N]` / `[*]`，**拒绝 `..` 与 filter 表达式**。
- **规则不得读写 `channel_config` / `account_uid` / `extra`**（core 侧 `ruleOpaqueKeys` 会先摘掉）。
- 渠道专属规则一律带 `scope.channels`，否则会作用到**所有**渠道。
- 插件里剩下的只应是**方言结构投影**（Anthropic/Responses 报文结构、`systemInstruction`、
  首条必须为 system 等上游硬约束）——这些不是「通用归一化」，必须保留在插件里。

## 9. 校验清单（新增/改插件时逐条过）

1. `call` 能从 stdin 读一帧 invoke、写出事件 + result、进程退出（`echo '{"v":1,"id":"r1","op":"invoke","method":"ping"}' | x.exe call`）；
2. `stdio` 能连发三个 invoke 且不串号；
3. `x.exe --help` 列出命令与「开关用双短横线」提示；
4. `x.exe ping --config '{"base_url":"http://127.0.0.1:18080"}'` 全 ✓；
5. `x.exe models --auth <标识>` 产出带命名空间前缀的模型 ID；
6. `<data>/auths/<前缀>-<id>.json` 能被旧版 `Parse` 读出（嵌套形 + `expiresAt` 数字）；
7. `<data>/logs/<plugin_id>.log` 有内容且**无明文 token**（`cli.RedactJSON`）；
8. `<data>/stat/stats.jsonl` 每次对话追加一条 `kind=chat`，`credits`/缓存字段口径正确；
9. 不传 `--data` 时数据落 exe 根目录（不是 cwd）。
10. 不支持的可选能力：`x.exe systemone --state '' --questions '{"a":{"type":"noul","criteria":{"true":"x","false":"y"}}}'` 与 `x.exe images --prompt test` **命令存在**、stderr 给出 `not_supported` 可读消息、退出码非 0、不落盘不写成功流水；
11. `x.exe images --prompt test --ref ./a.png --ref ./b.png` 后，`<data>/logs/*.log` 里**只有张数/字节数/mime，没有 base64 正文**（参考图内容属于用户私有数据，W3-07）；且两个 `--ref` 都能到达插件（验证多值开关未被后者覆盖前者）。
