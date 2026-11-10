# 拦截器插件契约（W3-25 / W3-26）

> 对象：写拦截器（hook）插件的人，以及改 core hook 链的人。
> 权威决议见 `AGENTS.md §2-E`（拦截器职责）、`§2-Y`（命名与形态）、`§2-Z`（数据根）。
> 本文只讲**协议**：怎么连、发什么帧、错了怎么办。

---

## 1. 一句话

拦截器是插在 core 对话主链路上的一层，**看得到请求与流式响应，并能改写或终止它**。
一个拦截器进程服务**一次对话请求**，走一条双向流 `hook.stream`：

```
下游客户端 ← gateway ← core ← H0 ← H1 ← … ← Hn ← 渠道插件 ← 上游
                         (链头)              (链尾)
```

请求正向穿过链（H0 最先看到请求），响应事件**反向**回传（Hn 最先看到上游事件）。

---

## 2. 命名与形态

> **命名无固定定义，由开发者自己定**（用户 m00634/m00642）：项目名、仓库名、可执行文件名
> **都不是契约**，身份只由 `manifest.json` 的 `id` 与 `kind` 决定。下表右列是**推荐**写法。

| 项 | 说明（推荐值，非约束） |
|---|---|
| 项目/仓库名 | 建议 `xxx-hook`（github `ww3-xxx-hook`，本地 `xxx-hook`），一眼看出是拦截器 |
| 可执行文件名 | 建议 `<id>-hook[.exe]`（渠道插件 `<id>-ext[.exe]`）；实际叫什么都能被发现（core `resolveExe` 三级解析） |
| `manifest.kind` | **`"hook"` —— 唯一真正的约束**（不是 hook 的插件不会被纳入链） |
| `execution` | `{control: "call", conversation: "call"}` —— **一请求一进程**，不常驻 |
| 调用 | core 每收到一次 `chat.generate`，按链序为每层 hook 各 spawn 一个进程（**与渠道 worker 并行启动**，见 §3.2） |
| 数据目录 | `<core data>/plugins/<id>/`（W3-39：在 core 数据根之下，**不在安装树里**），下含 `auths/` `logs/` `stat/` |

> 为什么不是常驻：AGENTS §2-E 早期写“按需拉起后常驻”，那是为了复用进程。双向流
> 已经在单请求内解决了复用；而流水线下（§3.2）spawn 与渠道 worker 的启动**重叠**，
> 那 ≈7ms 根本不在关键路径上。实测（`temp/hook_resident_eval.md`）：
> ① spawn ≈7ms，其中几乎全是 CreateProcess + Go 运行时（jq 空跑地板 6.8ms），与 hook 代码无关；
> ② 常驻反而**更慢**：8 路并发下常驻单进程多路复用比一请求一进程慢 1.15–1.22x
> （所有流的 JSON 编解码挤在一个 readLoop + 一把 encoder mutex + 一个 GC 堆上）；
> ③ 常驻每层长期占 ~12MB RSS / ~19.5MB private（Go 不归还 OS），而一次性进程退出即释放。
> 故与渠道插件统一为一次性进程（W3-25）。

---

## 3. 方法：`hook.stream`

能力声明位置：`manifest.capabilities.conversation` 必须含 `"hook.stream"`。

### 3.1 params（core → hook，invoke 时一次性下发）

```json
{
  "request":  { /* 完整 chat.GenerateRequest，见 IPC_CHAT.md */ },
  "config":   { /* 该 hook 实例的插件专属配置，来自 config.json 的 core.hooks[].config */ },
  "hook_id":  "loopguard-1",
  "chain":    { "index": 1, "total": 2 }
}
```

| 字段 | 说明 |
|---|---|
| `request` | 本次对话请求。hook 可据此决策（例如只对某个 model 生效），**不应改写它**（改写请求是 `request.prepare` 类能力，另议） |
| `config` | 该实例配置，字段由插件自定义（`config.schema` 声明） |
| `hook_id` | 实例 ID，用于日志 |
| `chain.index` | 0 = 链头（最靠近下游） |
| `chain.total` | 链长 |

> **params 里没有上游结果摘要**（旧版本曾有一个 `upstream: {ok:true}` 字段，已删除）：
> 链是流水线，hook 进程在上游还没出第一帧时就已经 spawn，此时根本不存在“上游结果”。
> 成败与错因一律以 `upstream.end` 帧的 `{ok,kind?,message?}` 为准（§3.2）。

### 3.2 帧（双向）

两个方向都用 `event` 帧，`event` 字段**直接是归一化事件名**，`data` 是该事件的原始 JSON。

**core → hook（`op=push`）**

| event | data | 说明 |
|---|---|---|
| `text.delta` | `{content}` | 正文增量 |
| `reasoning.delta` | `{content}` | 思维链增量 |
| `tool_call.delta` | `{index,id?,type?,name?,arguments_fragment?}` | 工具调用增量 |
| `usage` | `{prompt_tokens,completion_tokens,...,cache?}` | 用量 |
| `finish_reason` | `{reason}` | 结束原因 |
| `error` | `{kind,scope,message,...}` | 上游错误（若上游失败） |
| `upstream.end` | `{ok,kind?,message?}` | **结束信号，唯一特殊帧**；不转发给下游 |

**hook → core（`op=event`）**：同样的 `event` 名 + `data`。core 把 hook 发出的帧原样
交给它的下游（下一层 hook 或 gateway）。

顺序保证：`upstream.end` 一定是最后一帧；它之后的 `op=result` 表示 hook 处理完毕。

#### 3.2.1 时序是契约的一部分（流水线，不是“先收集再回放”）

core 必须在**发起渠道调用之前**就把链跑起来，让 hook 进程与渠道 worker 并行：

```
t0  spawn H0..Hn（链头先起，每层的下游落点已就绪）   ┐ 并行
t0  spawn 渠道 worker（chat.generate）                 ┘
t1  渠道第一帧 → core → 注入链尾 → 逐层向外 → 下游（首字延迟 ≈ spawn + 上游首字）
…   每帧如此，链上只有一个小缓冲抹平抖动（core 侧 queue 容量 256）
tN  渠道流结束 → core 注入 upstream.end → 各层收尾 result → 进程回收
```

两条硬约束（违反任一条都会把“能跑”变成“跑不动”）：

1. **不得缓存整段响应**（AGENTS §2-E / §9 红线）。旧实现把 `RunHooks` 放在渠道调用之后，
   链内部的流水线写得再对，整体仍是“先收集再回放”：首字延迟 = 整段生成时长
   （实测 251 帧的响应 ttft 从 197ms 变成 1286ms），且一旦帧数超过 queue 容量，
   反压会一路堵回上游——401 帧的响应客户端 45s 收 0 帧，直到 `ChatTimeout=300s`。
   回归：`main/core/internal/runtime/chatstream_hook_test.go`（流水线时序 / 600 帧不死锁）。
2. **背压靠同步写，不靠缓冲**。`s.Event()` 与 core 的注入都是同步写 stdin，写不进去就阻塞；
   hook 因此**不得**为了“批量看完再判”而无限吸收事件（那等于把整段响应缓存到了插件里）。
   确实需要窗口的判定（如 loopguard 的行级滑窗）只保留**定长**状态，不持有原始帧序列。

### 3.3 result

成功：`{"ok": true}`（`ok=false` 时表示 hook 主动终止）。

### 3.4 主动终止（本次样板的核心语义）

hook 发现不该继续（例如思考链死循环）时：**返回错误**，不要自己发 `error` 事件。

```go
return nil, jsonl.Errorf(errkind.ReasoningLoop, errkind.ScopeModel,
    "检测到思考链死循环，已中断生成：%s", hit.Reason)
```

core 收到 `ok=false` 后统一构造终止事件发给下游：

- 流式：`data: {"error":{"code":"reasoning_loop","type":"reasoning_loop","message":"…"}}` 后
  **不补 `data: [DONE]`**（R36：截断不得伪装正常收尾）。
- 非流式：HTTP 5xx + `{"error":{...}}`。

终止的**两个连带后果**（都是刻意的）：

1. **渠道 worker 被提前杀掉，上游不再白跑**。hook 一退出，core 就唤醒仍在写事件的渠道侧
   回调（返回内部信号 `errHookGone`）→ 渠道 `Invoke` 立即返回 → 插件进程回收。
   实测 8s 的流在命中后 0.2s 内结束。反过来说：**命中后上游不会再继续计费**，
   也不要把“命中后还能读到上游帧”当成可用行为写进插件。
2. **下游看到的是 hook 的 `kind`，不是传输层噪声**。hook 退出会让 core 的注入写失败
   （EPIPE/`closed`），core 因此**先把链收干净**、取带 `kind` 的 result 再归因，
   只有在链上确实没有业务错误时才回退到“拒绝事件”这类传输层消息。

**为什么不让 hook 自己发 error**：终止事件只能出现一次（W3-10）。统一出口才能保证
不重复、也不伪造。副作用是 hook 无法决定 HTTP 状态码——那由 core 按 `kind` 映射。

---

## 4. 失败策略

配置项 `hooks[].fail_open`（默认 `false`）。

| 场景 | `fail_open=false`（默认） | `fail_open=true` |
|---|---|---|
| 启动失败（exe 不存在/握手超时） | 中断请求 | **该层退化成直通**（入口直接接到它的下游），记警告 |
| 流中途崩溃 | **一律中断请求** | **同样中断** |
| 收尾 result 报错 | 中断请求 | 记警告继续 |

**为什么流中途的 fail-open 也只能中断**：hook 可能把 3 帧合成 1 帧、丢弃若干帧、
或改成完全不同的内容。它崩在第 k 帧之后时，core 只知道“上游已推到第 k+t 帧、
下游收到未定数量的帧”，既无法续接也无法回滚。唯一诚实的做法是中断并报错。

超时与取消：hook 的 ctx 派生自母请求 ctx，母请求取消（客户端断连）即级联取消。
取消/超时时 core 返回的是 **ctx 错误**而不是链上的“拒绝事件”——后者只是前者的后果，
冒到路由层会被误判成拦截器故障。

---

## 5. 配置（`<data>/config.json` 的 `core` 段，W3-35）

整个 ww3 只有一份 `config.json`（分 `gateway` / `core` / `rules` 三段），拦截器链在 `core.hooks`：

```json
{
  "core": {
    "hooks": [
      {
        "id": "loopguard-1",
        "plugin_id": "loopguard",
        "enabled": true,
        "order": 10,
        "fail_open": false,
        "config": { "enabled": true, "watch": "both" }
      }
    ]
  }
}
```

- 顺序：`order` 升序，同 `order` 按 `id` 字典序（稳定，两次跑结果必须一致）。
- 只纳入 `enabled` 且插件**已安装**且声明了 `hook.stream` 的实例。配置里残留一个
  已卸载插件的条目不应该让全部对话挂掉。

---

## 6. 控制面方法（可选但建议）

| 方法 | 说明 |
|---|---|
| `config.schema` | JSON Schema，面板据此生成表单（core 会缓存 10 分钟） |
| `config.get` | 回显当前配置（`{config}`），便于排查 |
| `ping` / `health.check` | 生命周期（由 `plugin.Registry.Lifecycle` 统一注册） |

拦截器**不需要**声明 `chat.generate`（它不产生对话）。

---

## 7. 写一个拦截器的最小骨架

```go
// internal/hook/hook.go
func (d *Daemon) Stream(ctx context.Context, p jsonl.RawMessage, s *rpc.Stream) (jsonl.RawMessage, *jsonl.ErrObj) {
	var env struct {
		Config json.RawMessage `json:"config"`
	}
	_ = json.Unmarshal(p, &env)

	for {
		m, err := s.Next(ctx)
		if err != nil { // 上游已结束或 ctx 取消
			return mustJSON(map[string]any{"ok": true}), nil
		}
		if m.Event == "upstream.end" { // 结束信号不转发
			return mustJSON(map[string]any{"ok": true}), nil
		}
		// 你的判定逻辑：命中则 return nil, jsonl.Errorf(...)
		if err := s.Event(m.Event, m.Data); err != nil { // 转发
			return nil, jsonl.Errorf(errkind.Conn, errkind.ScopeChannel, "写下游事件失败: %v", err)
		}
	}
}

// main.go
app.Cmd("call", "一次性调用").Str("--data", ...)
// ...
case "call":
    return d.Registry().ServeOnce(ctx, os.Stdin, os.Stdout)  // 读一条 invoke → 事件 + result → 退出
case "stdio":
    return d.Registry().ServeStdio(ctx, os.Stdin, os.Stdout) // 仅调试用；两形态共用同一个 registry
```

`s.Next()` 返回 `io.EOF` 表示 core 已关闭流（正常收尾），不是错误。
`s.Event(name, data)` 写一帧给下游。

---

## 8. 样板：`loopguard-hook`

参考实现 `main/loopguard-hook/`（思考链死循环守卫）：

- `internal/guard/guard.go` — 纯算法，四条判据（连续复读 / 空转窗口 / 短行高频 /
  行内周期），**围栏代码块内不计**，宁可漏报不可误杀。
- `internal/hook/hook.go` — 协议胶水：只盯 `reasoning.delta`（可配 `watch: text|both`），
  命中即返回 `reasoning_loop` 错误；其余事件原样透传。
- 新增 kind `reasoning_loop`（scope=model，**不可换号**——换号只会让同一死循环重跑）。

验证脚本与回归：

- `temp/test_hook_loop.py`（20 项）：正常不中断、两种发癫被中断且不补 `[DONE]`、
  代码块不误杀、非流式明确失败、开关生效、链路可配置。
- `temp/test_hook_long.py`（6 项，需 `temp/mock_loop.py` 的 `mock-long[N]` 场景）：
  长响应的**首字延迟**与**超队列容量**两个时序断言（hook 开/关对照），并检查
  core/gateway 日志里无 panic、无 `context deadline exceeded`、core 仍存活。
- `main/core/internal/runtime/chatstream_hook_test.go`（4 例，测试二进制自扮演插件，
  不依赖 dist 产物）：流水线时序、600 帧（>256）不死锁、命中即终止上游且 kind 正确、
  无 hook 时直通。
