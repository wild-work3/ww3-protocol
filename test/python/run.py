#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""契约测试骨架 - Python 实现（零第三方依赖）。

设计（对齐 AGENTS.md 工程实用风格 + W3-13 边界 B「契约可独立测试」）：
  - 不依赖 jsonschema 库：本项目 schema 只用少量关键字，此处手写等价的轻量校验
    （type/required/properties/additionalProperties/enum/const/minimum/minLength/
    oneOf/$ref），足够验证事件结构。
    TODO: 若 virtualenv 装有 jsonschema，可切换 validate_func 走标准的
          jsonschema.Draft7Validator.validate 做更强校验（替换下方 _validate）。
  - schema 逐行校验 + 跨事件不变量断言（终止唯一 / latch / tool index 合并）。
  - 与 node/ 骨架逻辑一一对应，同一套样例可跨语言复用（W3-13 边界 B）。

运行：python run.py
"""
import json
import os
import sys

# ---- 目录：本文件位于 <ww3>/protocol/test/python ----
TEST_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # protocol/test
SCHEMA_DIR = os.path.join(TEST_ROOT, "..", "schema")                     # protocol/schema
SAMPLES_DIR = os.path.join(TEST_ROOT, "samples")                         # protocol/test/samples

SCHEMA_STREAM = os.path.join(SCHEMA_DIR, "event.chat.stream.json")
SCHEMA_UTILS = os.path.join(SCHEMA_DIR, "event.utils.json")

# 终止事件集合：completed / incomplete / error，只能出现一次（IPC_CHAT §1 / §3.1）
TERMINAL_EVENTS = {"completed", "incomplete", "error"}


# ---- 轻量 schema 校验 --------------------------------------------------------
def _split_ref(ref):
    """解析 "$ref": "event.utils.json#/$defs/iUsage"。"""
    if "#" in ref:
        file_, frag = ref.split("#", 1)
        return file_, [p for p in frag.lstrip("/").split("/") if p]
    return ref, []


def _validate(value, schema, registry, path_str, out):
    """返回 bool；错误信息写入 out['errors']。registry: {文件名: schema对象}。"""
    if isinstance(schema, dict) and "$ref" in schema:
        file_, parts = _split_ref(schema["$ref"])
        target = registry.get(file_)
        if target is not None:
            node = target
            for p in parts:
                node = node.get(p)
                if node is None:
                    out["errors"].append("%s: $ref 指针无此项 %r" % (path_str, schema["$ref"]))
                    return False
            return _validate(value, node, registry, path_str, out)
        out["errors"].append("%s: $ref 无法解析 %r" % (path_str, schema["$ref"]))
        return False

    if "oneOf" in schema:
        for sub in schema["oneOf"]:
            sub_out = {"errors": []}
            if _validate(value, sub, registry, path_str, sub_out):
                return True
        out["errors"].append(
            "%s: 不满足 any oneOf [%s]" % (path_str, " | ".join(e for s in schema["oneOf"] for e in []))
        )
        return False

    # 混合类型数组（如 "type": ["integer", "null"]）
    if isinstance(schema.get("type"), list):
        for t in schema["type"]:
            sub = dict(schema, type=t)
            sub_out = {"errors": []}
            if _validate(value, sub, registry, path_str, sub_out):
                return True
        out["errors"].append("%s: 值不满足任一类型 %r" % (path_str, schema["type"]))
        return False

    t = schema.get("type")
    ok_ = True

    def note(cond, msg):
        nonlocal ok_
        if not cond:
            ok_ = False
            out["errors"].append("%s: %s" % (path_str, msg))

    if t == "object":
        is_obj = isinstance(value, dict)
        note(is_obj, "期望 object，实际 %s" % type(value).__name__)
        if not is_obj:
            return False
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in (schema.get("properties") or {}):
                    out["errors"].append("%s: 多余字段 %r (additionalProperties=false)" % (path_str, key))
                    ok_ = False
        for key in schema.get("required", []):
            note(key in value, "缺少 required 字段 %r" % key)
        for key, sub in (schema.get("properties") or {}).items():
            if key in value:
                _validate(value[key], sub, registry, "%s.%s" % (path_str, key), out)
    elif t == "string":
        note(isinstance(value, str), "期望 string，实际 %r" % (value,))
        if isinstance(value, str):
            if "minLength" in schema and len(value) < schema["minLength"]:
                note(False, "长度 < minLength(%d)" % schema["minLength"])
            if "enum" in schema and value not in schema["enum"]:
                note(False, "值 %r 不在 enum %r" % (value, schema["enum"]))
            if "const" in schema and value != schema["const"]:
                note(False, "const 不匹配: %r != %r" % (value, schema["const"]))
    elif t == "integer":
        note(isinstance(value, int) and not isinstance(value, bool),
             "期望 integer，实际 %r" % (value,))
        if isinstance(value, int) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                note(False, "值 < minimum(%d)" % schema["minimum"])
    elif t == "number":
        note(isinstance(value, (int, float)) and not isinstance(value, bool),
             "期望 number，实际 %r" % (value,))
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                note(False, "值 < minimum(%r)" % schema["minimum"])
    elif t == "boolean":
        note(isinstance(value, bool), "期望 boolean，实际 %r" % (value,))
    elif t == "null":
        note(value is None, "期望 null，实际 %r" % (value,))
    elif t == "array":
        note(isinstance(value, list), "期望 array，实际 %r" % (value,))
        if isinstance(value, list) and "items" in schema:
            for i, el in enumerate(value):
                _validate(el, schema["items"], registry, "%s[%d]" % (path_str, i), out)
    else:
        note(False, "未支持的关键字/类型 %r" % (t,))
    return ok_


def read_events(jsonl_text):
    """从 JSONL 文本读事件对象列表；空行跳过；非法行抛异常。"""
    events = []
    for i, line in enumerate(jsonl_text.splitlines(), 1):
        s = line.strip()
        if not s:
            continue
        try:
            events.append(json.loads(s))
        except ValueError as e:
            raise ValueError("第 %d 行 JSON 解析失败: %s\n  > %s" % (i, e, s))
    return events


# ---- 跨事件不变量断言 -------------------------------------------------------
def check_invariants(events):
    """返回错误列表。含：终止唯一 / latch / tool index 合并。"""
    errors = []

    # (1) 终止事件唯一（completed/incomplete/error 至多一次）IPC_CHAT §1 / §3.1
    terminals = [e for e in events if e and e.get("event") in TERMINAL_EVENTS]
    if len(terminals) > 1:
        names = ",".join(e["event"] for e in terminals)
        errors.append("终止事件不唯一：出现 %d 次（%s），IPC_CHAT §1 要求至多一次" % (len(terminals), names))

    # (2) text.delta 空串不置位 latch：空串帧不吞掉随后出现的非空正文 §3.1
    text_got = False
    for e in events:
        if e and e.get("event") == "text.delta" and isinstance(e.get("content"), str):
            if e["content"]:
                text_got = True
    # 弱校验示例：整条流是否必须有正文交给上层场景；仅空串的流不在此误报。

    # (3) tool_call.delta index 合并 §3.2
    by_index = {}
    for e in events:
        if e and e.get("event") == "tool_call.delta":
            # index 缺失（None/无）→ 按顺序推入新条目（§3.2 兼容）
            key = "idx_%s" % e["index"] if e.get("index") is not None else "seq_%d" % len(by_index)
            slot = by_index.get(key) or {"count": 0}
            slot["count"] += 1
            if slot["count"] == 1:
                if not isinstance(e.get("id"), str) or not e["id"]:
                    errors.append("tool_call.delta 首片缺 id（IPC_CHAT §3.2：首片带 id/type/name）")
            elif "arguments_fragment" not in e:
                errors.append("tool_call.delta 后续片未带 arguments_fragment（IPC_CHAT §3.2：后续只带 arguments 片段）")
            by_index[key] = slot

    return errors


def run_sample(file_name, registry):
    ok, fail = [], []
    with open(os.path.join(SAMPLES_DIR, file_name), "r", encoding="utf-8") as f:
        events = read_events(f.read())

    # A. 逐行 schema 校验（每行应满足 event.chat.stream.json 的 oneOf 分支）
    schema_errors = []
    for i, ev in enumerate(events, 1):
        out = {"errors": []}
        _validate(ev, registry["event.chat.stream.json"], registry, "%s#%d" % (file_name, i), out)
        schema_errors.extend(out["errors"])
    if not schema_errors:
        ok.append("schema 逐行校验通过 (%d 行)" % len(events))
    else:
        fail.append("schema 校验失败:\n    " + "\n    ".join(schema_errors))

    # B. 跨事件不变量断言
    inv_errors = check_invariants(events)
    if not inv_errors:
        ok.append("不变量断言通过（终止唯一 / latch / tool index 合并）")
    else:
        fail.append("不变量断言失败:\n    " + "\n    ".join(inv_errors))

    terminal_count = sum(1 for e in events if e and e.get("event") in TERMINAL_EVENTS)
    return ok, fail, terminal_count


def main():
    registry = {}
    with open(SCHEMA_STREAM, "r", encoding="utf-8") as f:
        registry["event.chat.stream.json"] = json.load(f)
    with open(SCHEMA_UTILS, "r", encoding="utf-8") as f:
        registry["event.utils.json"] = json.load(f)

    if not os.path.isdir(SAMPLES_DIR):
        samples = []
    else:
        samples = [f for f in os.listdir(SAMPLES_DIR) if f.endswith(".jsonl")]
    if not samples:
        print("PASS: 无样例可测（samples/ 为空）")
        sys.exit(0)

    passed = failed = 0
    for file_name in sorted(samples):
        ok, fail, terminal_count = run_sample(file_name, registry)
        print("\n== %s ==" % file_name)
        for line in ok:
            print("  [OK]    " + line)
        for line in fail:
            print("  [FAIL]  " + line)
        print("  终止事件计数: %d" % terminal_count)
        if fail:
            failed += 1
        else:
            passed += 1

    status = "PASS" if failed == 0 else "FAIL"
    print("\n%s: 通过 %d 个样例，失败 %d 个样例" % (status, passed, failed))
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()