# 渠道登录授权范式（AUTH_FLOW）

> 本文是 `PLUGIN_PROTOCOL.md §5.3`（`auth.*` 契约）的**渠道侧映射总表**，
> 替代旧版 `dev/docs/全渠道登录授权方式梳理.md`（该文是单进程硬编码时代的产物）。
> ww3 的差异：**登录流程归插件，编排归 core**，core 只认范式（Type）不认渠道。
>
> 新增渠道前必读；改 `authflow` 契约时先更新本文。Go 类型见 `authflow/authflow.go`。

---

## 1. 为什么需要「范式」而不是「每渠道一个 case」

旧版 dev 的 `internal/app/app.go` 有 **4337 行**，其中 `loginFlows` 表 + `StartLoginFor` +
`pollLogin` + 13 个 `complete*Login` 把「每个渠道怎么登录」硬编码进了主程序。后果：

- 加一个渠道 = 改 core（违反 W3-13 边界 A「core 不承载渠道业务」）；
- 前端要知道哪些渠道需要「粘贴回调 URL」输入框，于是 `manualCallbackKind()` 白名单
  在 handler 与前端各写一份（旧文 §4.5 的 `TestManualCallbackSingleSource` 就是为此设的锁）；
- 跨机失败的根因（回调写死回环）散落在 5 个 `login_*` 包里重复解释。

ww3 的解法：**把登录差异压成 6 种范式**，插件的 `auth.methods` 声明自己属于哪种，
core 据范式做**通用编排**（起不起轮询 / 给不给浏览器 / 要不要粘贴框），从此加渠道不用动 core。

---

## 2. 六种范式

| Type | 一句话 | 浏览器回调 | 本地端口 | 跨机（浏览器≠网关机） | 需要粘贴兜底 |
|---|---|---|---|---|---|
| `device_poll` | 插件向自己上游申请 state/device_code，**自行轮询**到凭据 | 无 | 无 | ✅ 天然通 | 无物可贴 |
| `loopback_callback` | 插件监听 `127.0.0.1:<port>` 收 code 再换 token | 有 | 有（动态端口） | ❌ 恒失败 | ✅ **必须** |
| `cdp_capture` | 插件拉起独立 profile 浏览器，经 CDP 读 Cookie | 无 | CDP 调试口（限本机） | 同机才行 | 不适用 |
| `form` | 用户表单输入（API Key / Cookie） | 无 | 无 | ✅ 天然通 | 不适用 |
| `credential_import` | 从本机已登录的官方客户端导入凭据 | 无 | 无 | 同机才行 | 不适用 |
| `none` | 无需登录（匿名通道 / 免费池） | 无 | 无 | — | 不适用 |

### 2.1 core 的三个判据（唯一来源，不得在 gateway/前端再判）

```go
Type.NeedsPoll()         // device_poll / loopback_callback / cdp_capture → true
Type.NeedsBrowser()      // 同上三种 → true（form / credential_import 不需要开浏览器）
Type.CanPasteCallback()  // 仅 loopback_callback → true
```

`auth.begin` 的 `BeginResult` 还会回一个 `can_paste_callback` 布尔——前端只需读它，
不必知道 `Type` 是什么。这是旧版 `manualCallbackKind()` 白名单的替代物。

### 2.2 跨机失败的根因与唯一通用解（沿用 R101）

- **根因**：回调地址写死回环（`127.0.0.1` / `localhost`），远端浏览器的回调打在**用户自己
  机器**上，凭据到不了网关 ⇒ 只能枯等超时。
- **唯一通用解**：`auth.finish` 让用户把浏览器地址栏里打不开的那条回调 URL 原样粘回来，
  插件解析出 code 后走**与自动回调完全相同**的兑换路径。不依赖网关机有人。
- **明确不做**（沿用旧文 §4.4）：CDP 化五渠道（只解决「人在网关机前」，本工具主流部署
  形态是远端面板 + 无人值守）、回调改 LAN IP（LobsterAI 已实测证伪）。

### 2.3 凭据边界（硬红线 W3-07）

- token **绝不过 IPC**：`auth.status` 只上报 `Account{uid,nickname,region,expires_at,credits}` 事实。
- 插件把凭据写进**自己**的私有目录 `<data>/auths/`（W3-21 起统一为旧版兼容的 `auths/`，不再用 `<data>/creds/<plugin_id>/`；格式见 `PLUGIN_CLI.md §5.1`），core 不持有、不落盘、不打印。
- 落盘前必经 `cli.RedactJSON()`（`cli/proc.go`），端到端测试有一条「日志中无明文 token」的断言。

---

## 3. 旧版渠道 → 范式映射（13 组，来自旧文 §1 总表）

| 旧版渠道 | 范式 | 凭据流 / 关键事实 | 旧版参考实现 |
|---|---|---|---|
| workbuddy（国内） | `device_poll` | `POST /v2/plugin/auth/state?platform=CLI` → 轮询 `/v2/plugin/auth/token?state=` → `/v2/plugin/login/account` 拿 uid/nickname；无 PKCE，state 由服务端签发 | `dev/internal/login/login.go` |
| workbuddyai（国际） | `device_poll` | 同上，仅 host 换 `www.workbuddy.ai`；token 响应常缺 `domain`，**须按区域兜底**否则账号被判成 CN | `dev/internal/login_wbai` |
| qoder / qodercn / qodercom | `device_poll` | PKCE + nonce，本地生成 verifier；授权后轮询 `deviceToken/poll` 换 `dt-`/`drt-` | `dev/internal/login_qoder{,cn,com}` |
| zcode | `device_poll` | **服务端中介**：`POST /api/v1/oauth/cli/init` → 轮询 `poll/{flow_id}`；**凭据不可续期**（JWT 无 exp，无 refresh 端点），`expires_at` 写远期值 | `dev/internal/login_zcode` |
| minimax | `device_poll` | PKCE + `POST /oauth2/device/code`，拿 `verification_uri_complete`；轮询 `/oauth2/token`，按上游 `interval`（秒）节流 | `dev/internal/login_minimax` |
| traework | `loopback_callback` | PKCE loopback `?authCodeInfo=`（10 分钟一次性）；**无 state 参数，回调端口是唯一会话锚点**；监听寿命 5 分钟 | `dev/internal/login_trae` |
| codearts | `loopback_callback` | PKCE + DPoP JWK loopback `?code=`；授权 URL 由 `port` 参数驱动；换临时 AK/SK（15 分钟）+ 安全令牌 | `dev/internal/login_codearts` |
| lobsterai | `loopback_callback` | code + state loopback（无 PKCE）；**portal 严格只认 127.0.0.1 hostname**；端口可固定（`lobsterai_callback_port`）以便预建 ssh -L | `dev/internal/login_lobsterai` |
| qwenwork | `loopback_callback` | PKCE(Hydra) loopback `?code=&state=`；redirect_uri 白名单制，回环随机端口是实测允许的例外 | `dev/internal/login_qwenwork` |
| gemini | `loopback_callback` | OAuth code（**刻意无 PKCE**）loopback；Google installed-app 政策限 `localhost`（不是 127.0.0.1），且可能解析成 `::1` ⇒ 监听器双栈 | `dev/internal/login_gemini` |
| glm（智谱清言） | `form`（W3-47 起） | 官方无编程式登录：手工粘贴 `chatglm_refresh_token`（浏览器 F12 从 Cookie 复制）。旧版 `dev` 用 CDP 拉独立 profile 浏览器读 Cookie（`dev/internal/login_glm`、`dev/internal/cdp`），ww3 的 `glm-ext` 早期也保留过该路径，现已随 W3-47 一并废弃——**不实现 CDP 自动抓取**（依赖整包 CDP 客户端成本高，且新访客会被上游自动下发访客凭据，故以「能换出真实账号 access_token」为登录完成判据） | `dev/internal/login_glm`、`dev/internal/cdp`（仅旧版） |
| raccoon（小浣熊） | `cdp_capture` | 同上，读小浣熊网页版 Cookie；未登录时读到访客凭据（`owner_type=visitors`）须判为「尚未登录」 | `dev/internal/login_raccoon` |
| loomy | `device_poll`（特殊） | 本机引导页 + 短信验证码，插件持 127.0.0.1 监听端口；形态接近 `loopback_callback` 但需用户填码 | `dev/internal/login_loomy` |
| officeace | `loopback_callback`（两步） | 华为云授权码 + 云端轮询捕获；双层凭据（临时 AK/SK 需续期，R70） | `dev/internal/officeace` |
| monkeycode | `credential_import` | 从其本机官方客户端导入凭据 | `dev/internal/monkeycode` |
| oczen / kilo / cline | `none` 或 `form` | oczen 匿名；kilo 免费池；cline 为 API Key 表单 | `dev/internal/{oczen,kilo,cline}` |

### 3.1 旧版 `loginFlows` 表的四种语义 → ww3 的落点

旧版每条记录恰好表达一种「发起方式」（`Start` / `DisplayURL` / `noFlowReason`），
并有自检 panic 防止漏填。ww3 对应关系：

| 旧版语义 | ww3 |
|---|---|
| `Start` + `Poll` | `auth.methods` 声明一条 `device_poll`/`loopback_callback`/`cdp_capture` 方式 |
| `DisplayURL`（GLM 只给链接不起流程） | `auth.methods` 声明 `form`（给 `Fields` 表单）+ `cdp_capture`（自动路径），二选一 |
| `noFlowReason`（无需登录/无法登录） | `auth.methods` 返回 `TypeNone` + `note` 可读理由 |
| `openIncognito`（CodeArts 避开日常登录态） | 插件内部细节，core 不管（`auth.begin` 只需回 `auth_url`） |
| `pollTimeout`（各包 flowTTL 不一致） | `BeginResult.expires_at` 由插件给出，core 不再硬编码 5 分钟 |

---

## 4. 新增渠道的检查清单

1. **先定范式**：按上表判断属于哪一类；能选 `device_poll` 就不要选 `loopback_callback`
   （前者天然跨机，后者要额外做粘贴兜底）。
2. **`auth.methods` 声明方式**：`Method{ID,Type,Label,Region,Default,Fields}`；
   一个渠道可声明多条（如 workbuddy = `device_poll` + `credential_import`）。
3. **`auth.begin` 只做「发起」**：拿 state/device_code、起监听器、返回 URL 与提示。
   **不要在 begin 里轮询**——长阻塞会让前端超时（旧版 minimax 注释明确写了这点：
   `window.open` 的瞬态激活窗口只有约 5 秒）。
4. **`auth.status` 幂等**：同一个 `flow_id` 反复调只返回当前状态，不得重复打上游
   （旧版纪律：一旦得到终态就固化进 state 文件，后续 Poll 直接短路）。
5. **`auth.finish` 与自动回调共用兑换路径**：不要写第二套解析/兑换代码。
6. **凭据落盘到 `<data>/auths/<前缀>-<标识>.json`**（旧版兼容格式：嵌套形 + `expiresAt` Unix 秒，读取兼容扁平形，见 `PLUGIN_CLI.md §5.1`），绝不进 core 配置、绝不进日志。
7. **多账号**：`flow_id` 与账号无绑定；成功后上报 `Account.uid` 作为账号身份。
8. **零臆造**：`BeginResult` / `StatusResult` 的字段上游没有就不填（省略而非 0/空串）。

---

## 5. core 侧落地（已实现）

新增文件 `main/core/internal/api/auth.go`（主仓），路由挂在 `/api/auth/*`（gateway 反代为 `/core/auth/*`）：

| 端点 | 说明 |
|---|---|
| `GET /core/auth/methods?channel=<id>` | 转发 `auth.methods`；渠道未声明认证能力时返回**空列表**而不是报错（前端据此不显示登录按钮） |
| `POST /core/auth/begin` | `{channel_id,method,region,values}` → 记下 `flow_id → {channel,plugin,region}` 归属后转发 `auth.begin` |
| `POST /core/auth/status` | `{flow_id}` → 转发 `auth.status`；成功后调 `upsertAccount()` 落账号表 + 账号池；**终态结果缓存**在 core 内存（成功结果可重复读取，避免前端在途 poll 把 success 读成 expired） |
| `POST /core/auth/finish` | `{flow_id,callback_url,values}` → 转发 `auth.finish`（人工粘贴兜底，只有 loopback_callback 用得上） |
| `POST /core/auth/cancel` | `{flow_id}` → 转发 `auth.cancel` 并释放记录 |

core 侧三条实现要点（都是踩过的坑）：

1. **账号内部主键掺渠道 ID**：`config.Account.UID = <插件侧uid>@<渠道ID>`，另存 `RemoteUID` 保存插件侧原始 uid。
   原因：同一自然人可能同时登录国内版和国际版两个渠道实例，插件侧 uid 相同（mock 两区都回 `wb-uid-001`），
   不掺渠道 ID 会互相覆盖，`/core/accounts` 只剩一个。
   所有回传插件控制面的 `uid` 参数必须用 `RemoteUID`（见 `main/core/internal/api/api.go` 的 `remoteUID`）。
2. **`ControlCall` 的第一参数是插件 ID**，账号相关转发要先用 `Store.Channel(account.ChannelID).PluginID` 反查。
3. **控制面调用必须带 `config`**：`map[string]any{"uid":..., "config": ch.Config}`。
   漏传会让插件拿不到 `base_url`/`region`，打到真实上游并 401（联调期踩过）。

前端（`main/gateway/web/app.js`）已实现登录向导 `openLoginWizard()`：按 `method.type` 渲染，
`device_poll/loopback_callback/cdp_capture` 走轮询，只有 `loopback_callback`（`can_paste_callback=true`）才显示粘贴框；
渠道卡片对有 `auth.begin` 能力的渠道显示「登录」按钮，新建渠道保存后也会主动询问是否立即登录。
