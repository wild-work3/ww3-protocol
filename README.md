# protocol — WW3 插件契约（文本 + Go SDK + 参考实现）

本仓是 **WW3（wild-work3）渠道 / 拦截器插件的唯一契约权威**，三件事合一：

| 内容 | 位置 | 给谁看 |
|---|---|---|
| **契约散文**（稳定、公开） | `docs/*.md` | 所有语言的插件作者 |
| **机器契约**（JSON Schema + 标准样例 + 跨语言断言） | `schema/`、`test/` | 任何语言的实现与测试 |
| **Go SDK + 参考实现** | 本仓根目录的 Go 包 | Go 插件作者（直接 `go get`） |

> 非 Go 插件**不需要** Go 代码：读 `docs/` + 对 `schema/` 与 `test/samples/` 即可实现。
> Go 代码的价值是「一份可运行的参考实现」，不是准入要求。

## 契约文档

| 文档 | 内容 |
|---|---|
| [`docs/PLUGIN_PROTOCOL.md`](docs/PLUGIN_PROTOCOL.md) | 进程生命周期、JSONL RPC 框架、能力声明、控制面方法表 |
| [`docs/IPC_CHAT.md`](docs/IPC_CHAT.md) | 归一化对话流式契约（`chat.generate` 请求/事件/错误/用量） |
| [`docs/PLUGIN_CLI.md`](docs/PLUGIN_CLI.md) | 插件 CLI 契约（命令、开关、数据目录、凭据格式、统计） |
| [`docs/HOOK_PROTOCOL.md`](docs/HOOK_PROTOCOL.md) | 拦截器插件契约（`hook.stream` 双向流、帧、失败策略） |
| [`docs/WEB_CLI_CONTRACT.md`](docs/WEB_CLI_CONTRACT.md) | 网页 AI 逆向渠道的命令界面契约（退出码、事件、`schema` 命令） |
| [`docs/AUTH_FLOW.md`](docs/AUTH_FLOW.md) | 认证六范式（`device_poll` / `loopback_callback` / `cdp_capture` / `form` / `credential_import` / `none`） |

## Go 用法

```bash
go get github.com/wild-work3/ww3-protocol
```

```go
import (
    "github.com/wild-work3/ww3-protocol/chat"     // 归一化对话类型与用量
    "github.com/wild-work3/ww3-protocol/jsonl"    // JSONL 帧
    "github.com/wild-work3/ww3-protocol/plugin"   // 插件两形态底座（call / stdio）
    "github.com/wild-work3/ww3-protocol/rpc"      // JSONL RPC 客户端/服务端
    "github.com/wild-work3/ww3-protocol/meta"     // manifest / 模型 / 资源结构
    "github.com/wild-work3/ww3-protocol/cli"      // 命令式 CLI 外壳 + 日志 + 脱敏
    "github.com/wild-work3/ww3-protocol/errkind"  // 错误分类（core 据此冷却/换号/降级）
    "github.com/wild-work3/ww3-protocol/stat"     // 插件自记统计流水
    "github.com/wild-work3/ww3-protocol/authflow" // 六范式认证类型
)
```

包依赖关系（无环，`jsonl` 是根）：

```
jsonl  ←  rpc  ←  cli
  ↑        ↑
  └── plugin ──→ meta
chat / errkind / meta / stat / authflow  （互相独立）
```

## 版本策略

**module major = IPC 协议版本**（`const Version` 见根包）。插件在 `manifest.protocol` 里声明
`{"min":1,"max":1}`，与 module major 同一个真值来源。

| 版本位 | 允许的改动 |
|---|---|
| **major** | 破坏性：删字段、改语义、改帧形状。**必须同步升 IPC 协议版本** |
| **minor** | 只加可选字段 / 新增方法（append-only） |
| **patch** | 修 bug、修文档，不改 wire |

**契约是 append-only 的**：已发布的字段不得改语义、不得删；要改就升 major。
插件锁 minor（如 `v1.2.0`），这样 `v1.9` 出来老插件不用重编译。

## 与其他仓的关系

| 仓 | 关系 |
|---|---|
| [`wild-work3/wild-work3`](https://github.com/wild-work3/wild-work3) | 主程序（gateway + core + 官方样板）。**本仓的 Go 代码是它的副本**，主仓内嵌同一份 `protocol` 包以保持「克隆即可构建」 |
| [`wild-work3/ww3-conformance`](https://github.com/wild-work3/ww3-conformance) | 契约符合性自检工具（**不是门禁**）。它按文本契约独立实现最小 framing，不复用本仓代码 |
| [`wild-work3/ww3-ext-registry`](https://github.com/wild-work3/ww3-ext-registry) | 插件市场注册表 |

## 测试

```bash
go test ./...                     # Go 实现的自测
node test/node/run.js             # 跨语言契约断言（Node 18+，零依赖）
python test/python/run.py         # 跨语言契约断言（Python 3.8+，零依赖）
```

三套都要过：**契约实现多份是允许的，漂移才是缺陷**。
