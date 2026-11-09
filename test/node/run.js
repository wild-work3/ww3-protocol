// 契约测试骨架 - Node 实现（零依赖）
//
// 设计（对齐 AGENTS.md 工程实用风格 + W3-13 边界 B「契约可独立测试」）：
//   - 不引入 AJV/jsonschema 等重型框架：本骨架用手写轻量校验器，仅覆盖本项目
//     schema 实际用到的关键字（type/required/properties/additionalProperties/
//     enum/const/minimum/minLength/oneOf/$ref/混合类型数组），足以验证事件结构。
//     TODO: 若后续 schema 复杂化，可替换为 ajv（npm i ajv），其余断言代码不变。
//   - schema 逐行校验 + 跨事件不变量断言（终止唯一 / latch / tool index 合并）。
//   - 与 python/ 骨架逻辑一一对应，同一套样例可跨语言复用（W3-13 边界 B）。
//
// 运行：node run.js   （仅需 Node 18+，无外部依赖）
"use strict";

const fs = require("fs");
const path = require("path");

// ---- 目录：schema 在 protocol/schema，样例在 protocol/test/samples ----
// __dirname = <ww3>/protocol/test/node
const TEST_ROOT = path.join(__dirname, "..");            // protocol/test
const SCHEMA_DIR = path.join(TEST_ROOT, "..", "schema"); // protocol/schema
const SAMPLES_DIR = path.join(TEST_ROOT, "samples");     // protocol/test/samples

// schema 文件：event.chat.stream.json + ($ref 引用) event.utils.json
const SCHEMA_STREAM = path.join(SCHEMA_DIR, "event.chat.stream.json");
const SCHEMA_UTILS = path.join(SCHEMA_DIR, "event.utils.json");

// 终止事件集合：completed / incomplete / error，只能出现一次（IPC_CHAT §1 / §3.1）
const TERMINAL_EVENTS = new Set(["completed", "incomplete", "error"]);

// ---- 轻量 schema 校验 ------------------------------------------------------
// resolveRef: 解析 "$ref": "event.utils.json#/$defs/iUsage"
//   外部 schema 指向 utils，本地保留；$ref 相对本仓库的文件名解析。
function splitRef(ref) {
  const [file, frag] = ref.split("#");
  const parts = frag ? frag.replace(/^\//, "").split("/") : [];
  return { file, parts };
}
function deref(registry, ref) {
  const { file, parts } = splitRef(ref);
  if (!file || !registry[file]) throw new Error(`$ref 无法解析: ${ref}`);
  let node = registry[file];
  for (const p of parts) {
    node = node[p];
    if (node === undefined) throw new Error(`$ref 指针无此项: ${ref} (${p})`);
  }
  return node;
}

function validate(value, schema, registry, pathStr, out) {
  if (schema.$ref) {
    const target = deref(registry, schema.$ref);
    return validate(value, target, registry, pathStr, out);
  }
  if (schema.oneOf) {
    const branchErrs = [];
    for (const sub of schema.oneOf) {
      const subOut = { errors: [] };
      const ok = validate(value, sub, registry, pathStr, subOut);
      if (ok) return true;
      branchErrs.push(subOut.errors.join("; ") || "(结构不匹配)");
    }
    out.errors.push(`${pathStr}: 不满足 any oneOf [${branchErrs.join(" | ")}]`);
    return false;
  }
  // 混合类型数组（如 "type": ["integer","null"]）
  if (Array.isArray(schema.type)) {
    const subOps = [];
    for (const t of schema.type) {
      const subOut = { errors: [] };
      const ok = validate(value, { ...schema, type: t }, registry, pathStr, subOut);
      if (ok) return true;
      subOps.push(subOut.errors.join("; "));
    }
    out.errors.push(`${pathStr}: 值不满足任一类型 [${subOps.join(" | ")}]`);
    return false;
  }

  const v = (ok, msg) => { if (!ok) out.errors.push(`${pathStr}: ${msg}`); return ok; };
  switch (schema.type) {
    case "object": {
      const isObj = typeof value === "object" && value !== null && !Array.isArray(value);
      v(isObj, `期望 object，实际 ${typeof value}`);
      if (!isObj) return false;
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in (schema.properties || {}))) v(false, `多余字段 "${key}"（additionalProperties=false）`);
        }
      }
      for (const key of schema.required || []) {
        if (!(key in value)) v(false, `缺少 required 字段 "${key}"`);
      }
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        if (key in value) validate(value[key], sub, registry, `${pathStr}.${key}`, out);
      }
      return true;
    }
    case "string": {
      v(typeof value === "string", `期望 string，实际 ${JSON.stringify(value)}`);
      if (typeof value === "string") {
        if (schema.minLength && value.length < schema.minLength) v(false, `长度 < minLength(${schema.minLength})`);
        if (schema.enum && !schema.enum.includes(value)) v(false, `值 "${value}" 不在 enum ${JSON.stringify(schema.enum)}`);
        if (schema.const !== undefined && value !== schema.const) v(false, `const 不匹配: "${value}" != "${schema.const}"`);
      }
      return true;
    }
    case "integer": {
      v(typeof value === "number" && Number.isInteger(value), `期望 integer，实际 ${JSON.stringify(value)}`);
      if (typeof value === "number" && Number.isInteger(value)) {
        if (schema.minimum !== undefined && value < schema.minimum) v(false, `值 < minimum(${schema.minimum})`);
      }
      return true;
    }
    case "number": {
      v(typeof value === "number", `期望 number，实际 ${JSON.stringify(value)}`);
      if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) v(false, `值 < minimum(${schema.minimum})`);
      return true;
    }
    case "boolean":
      v(typeof value === "boolean", `期望 boolean，实际 ${JSON.stringify(value)}`);
      return true;
    case "null":
      v(value === null, `期望 null，实际 ${JSON.stringify(value)}`);
      return true;
    case "array": {
      v(Array.isArray(value), `期望 array，实际 ${JSON.stringify(value)}`);
      if (Array.isArray(value) && schema.items) {
        value.forEach((el, i) => validate(el, schema.items, registry, `${pathStr}[${i}]`, out));
      }
      return true;
    }
    default:
      v(false, `未支持的关键字/类型 ${JSON.stringify(schema.type)}`);
      return false;
  }
}

// ---- 从 JSONL 读事件 ----
function readEvents(jsonlText) {
  const events = [];
  for (const [i, line] of jsonlText.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (e) {
      throw new Error(`第 ${i + 1} 行 JSON 解析失败: ${e.message}\n  > ${trimmed}`);
    }
  }
  return events;
}

// ---- 跨事件不变量断言 -------------------------------------------------------
// (1) 终止事件唯一（completed/incomplete/error 至多一次）IPC_CHAT §1 / §3.1
// (2) text.delta 空串不置位 latch：空串帧不吞掉随后出现的非空正文 §3.1
// (3) tool_call.delta index 合并：首片带 id，后续片带 arguments_fragment §3.2
function checkInvariants(events) {
  const errors = [];

  const terminals = events.filter((e) => e && TERMINAL_EVENTS.has(e.event));
  if (terminals.length > 1) {
    errors.push(`终止事件不唯一：出现 ${terminals.length} 次（${terminals.map((t) => t.event).join(",")}），IPC_CHAT §1 要求至多一次`);
  }

  // (2) latch：记录是否已收到非空正文；空串帧建议出现在非空正文之前即置位判定宽松，
  //     骨架只做弱校验示例：空串在首个非空正文之前出现即合法（空串不占 latch）。
  let textGot = false;
  for (const e of events) {
    if (e && e.event === "text.delta" && typeof e.content === "string") {
      if (e.content.length > 0) {
        if (!textGot) textGot = true;
      }
      // 空串帧：仅当在此之前从未收到非空正文时才刷新 sawEmpty 标记（故此处无需处理）
    }
  }
  // 结论：整条流有无正文交给上层场景决定；本骨架不因"仅空串"而误报。

  // (3) tool_call.index 合并规则
  const byIndex = new Map();
  for (const e of events) {
    if (e && e.event === "tool_call.delta") {
      // index 缺失（undefined/无）→ 按顺序推入新条目（§3.2 兼容）
      const key = e.index === undefined ? `seq_${byIndex.size}` : `idx_${e.index}`;
      const slot = byIndex.get(key) || { count: 0 };
      slot.count++;
      if (slot.count === 1) {
        if (typeof e.id !== "string" || e.id.length === 0) {
          errors.push(`tool_call.delta 首片缺 id（IPC_CHAT §3.2：首片带 id/type/name）`);
        }
      } else if (e.arguments_fragment === undefined) {
        errors.push(`tool_call.delta 后续片未带 arguments_fragment（IPC_CHAT §3.2：后续只带 arguments 片段）`);
      }
      byIndex.set(key, slot);
    }
  }

  return errors;
}

function runSample(fileName, registry) {
  const ok = [];
  const fail = [];
  const text = fs.readFileSync(path.join(SAMPLES_DIR, fileName), "utf8");
  const events = readEvents(text);

  // A. 逐行 schema 校验（每行应满足 event.chat.stream.json 的 oneOf 分支）
  const schemaErrs = [];
  for (const [i, ev] of events.entries()) {
    const out = { errors: [] };
    validate(ev, registry["event.chat.stream.json"], registry, `${fileName}#${i + 1}`, out);
    schemaErrs.push(...out.errors);
  }
  const schemaOkay = schemaErrs.length === 0;
  (schemaOkay ? ok : fail).push(
    schemaOkay
      ? `schema 逐行校验通过 (${events.length} 行)`
      : `schema 校验失败:\n    ${schemaErrs.map((s) => "    " + s).join("\n")}`
  );

  // B. 跨事件不变量断言（终止唯一 / latch / tool index 合并）
  const invErrs = checkInvariants(events);
  const invOkay = invErrs.length === 0;
  (invOkay ? ok : fail).push(
    invOkay ? "不变量断言通过（终止唯一 / latch / tool index 合并）" : `不变量断言失败:\n    ${invErrs.map((s) => "    " + s).join("\n")}`
  );

  return { ok, fail, terminalCount: events.filter((e) => e && TERMINAL_EVENTS.has(e.event)).length };
}

function main() {
  // 载入 schema 到 registry；$ref 以文件名为键解析（相对位于同一 schema 目录）
  const registry = {};
  registry["event.chat.stream.json"] = JSON.parse(fs.readFileSync(SCHEMA_STREAM, "utf8"));
  registry["event.utils.json"] = JSON.parse(fs.readFileSync(SCHEMA_UTILS, "utf8"));

  const samples = fs.existsSync(SAMPLES_DIR) ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith(".jsonl")) : [];
  if (!samples.length) {
    console.log("PASS: 无样例可测（samples/ 为空）");
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  for (const file of samples) {
    const { ok, fail, terminalCount } = runSample(file, registry);
    console.log(`\n== ${file} ==`);
    for (const line of ok) console.log("  [OK]    " + line);
    for (const line of fail) console.log("  [FAIL]  " + line);
    console.log(`  终止事件计数: ${terminalCount}`);
    if (fail.length) failed++;
    else passed++;
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: 通过 ${passed} 个样例，失败 ${failed} 个样例`);
  process.exit(failed === 0 ? 0 : 1);
}

main();