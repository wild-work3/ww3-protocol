# 跨语言契约测试骨架（protocol/test/）

校验任意 `chat.generate` 事件流实现是否合规（W3-13 边界 B：契约可独立测试）。
同一套样例 + 同一套断言逻辑分别在 Node 与 Python 实现了一遍，保证跨语言兼容。

## 目录结构

```
protocol/test/
├─ samples/            ← 标准事件样例（JSONL，每行一个事件对象）
│  ├─ chat.generate.ok.jsonl                     # 完整正常流（正文+推理+工具+用量+正常结束）
│  ├─ chat.generate.err_multiple_terminals.jsonl # 错误场景：双终止事件（应 FAIL）
│  └─ abilities/                                 # 一次性能力（systemone.decide / images.generate）的
│     ├─ systemone.decide.ok.jsonl                #   invoke + result 样例；本目录**不被跑器扫描**
│     ├─ images.generate.ok.jsonl                #   （runner 只读 samples/ 下的 *.jsonl），
│     └─ images.generate.not_supported.jsonl     #   供人工比对与后续断言接入；
│                                                #   not_supported = 不支持姿势：ok=false + kind=not_supported（W3-30）
├─ node/run.js         ← Node 实现（零依赖，仅需 Node 18+）
└─ python/run.py       ← Python 实现（零依赖，仅需标准库）
```

Schema 位于 `../schema/`（`event.chat.stream.json` 引用 `event.utils.json`）。
W3-30 补充的四个 schema（文档已冻结、**断言未接入**）：
`params.systemone.decide.json` / `result.systemone.decide.json` /
`params.images.generate.json` / `result.images.generate.json`。

## 运行

```bash
# Node
node protocol/test/node/run.js

# Python（Windows 若控制台乱码：`set PYTHONUTF8=1` 后用 `py protocol/test/python/run.py`）
py protocol/test/python/run.py
```

退出码：全部样例 PASS = 0，任一 FAIL = 1。

## 每个样例校验的断言

1. **schema 逐行校验**：每行事件对象须满足 `event.chat.stream.json` 的 oneOf 分支
   （`text.delta`/`reasoning.delta`/`tool_call.delta`/`finish_reason`/`usage`/`error`/
   `completed`/`incomplete`），`usage`/`error` 经 `$ref` 复用 `event.utils.json` 的
   `iUsage`/`iError`。
2. **终止事件唯一**：`completed`/`incomplete`/`error` 整条流至多出现一次（IPC_CHAT §1/§3.1）。
3. **text.delta 空串不置位 latch**：空串帧不吞掉随后出现的非空正文（IPC_CHAT §3.1）。
4. **tool_call.delta index 合并**：首片须带 `id`；同一 index 的后续片只带 `arguments_fragment`；
   index 缺失时按顺序推入新条目（IPC_CHAT §3.2）。

## 当前为骨架，留下 TODO

- Node：手写轻量校验器仅覆盖本项目用到的关键字；若 schema 复杂化可换 `ajv`（`npm i ajv`），断言代码不变。
- Python：同理可切 `jsonschema`（若 virtualenv 已装），替换 `_validate` 用 `Draft7Validator`。
- 未实现：完整 `request.chat.generate` 请求体校验（`request.chat.generate.json` 已就绪，样例与断言未接入）；
  错误场景每 `kind` 至少一条样例与 Rotatable 分类判定（IPC_CHAT §4.1/§7）；
  非流式整条 message 帧 → tool 合并的同构分支（IPC_CHAT §3.2 末段）样例。
- **W3-30 待接入**：`systemone.decide` / `images.generate` 是一次性 invoke/result（无事件流），跟本跑器
  的假定（每行一个 chat 事件 + 终止唯一）不同构；当前 runner 只扫 `samples/*.jsonl`，`samples/abilities/`
  不参与执行。接入时需新增一类「单帧能力」断言：invoke 与 result 成对、`ok=false` 必带 `error.kind`、
  结果体过 `result.<method>.json` schema。
- 样例目录尚未覆盖：`incomplete`、latch 中途空串、无 index 的 tool 合并、每类错误 kind。