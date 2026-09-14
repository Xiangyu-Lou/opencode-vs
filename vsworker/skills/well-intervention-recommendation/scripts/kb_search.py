#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只跑兜底级之一：知识库向量检索（《钻井事故与复杂问题》的原文片段）。

一般流程请用 recommend.py。本脚本用于单独验证知识库是否通、看片段与分值。

  python3 scripts/kb_search.py -q "键槽卡钻怎么判断"
  python3 scripts/kb_search.py -q "井漏了怎么处理" --k 5 --full

**返回的是原文片段，不是成稿答案**：拿去回答用户前必须自己归纳，
并写明「依据来自《钻井事故与复杂问题》」。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from platform_client import kb_search, load_config, run_cli

PREVIEW_CHARS = 600


def render(result, full=False):
    state = f"命中 {len(result['chunks'])} 段" if result["state"] == "hit" else "零片段"
    top = f"{result['top_score']:.4f}" if result["top_score"] is not None else "—"
    print(
        f"[知识库] {state}｜最高 {top}｜阈值 {result['threshold']}（服务端过滤）｜"
        f"top_k {result['k']}｜expand_step {result['expand_step']}"
    )
    print(f"[检索问题] {result['question']}")
    if result["sources"]:
        print(f"[命中文档] {'、'.join(result['sources'])}")
    if result["state"] != "hit":
        print(
            "\n零片段 = 库里没有相关内容，或阈值偏高。"
            "确认 KB_ID_LIST 是知识库 ID、文档已「保存并处理」入库；"
            "调低 KB_THRESHOLD 前先想清楚：离题片段的分值也就 0.12–0.25。"
        )
    for i, chunk in enumerate(result["chunks"], 1):
        head = f"\n[片段 {i}] {chunk['score']:.4f}｜{chunk['source'] or '未标来源'}"
        if chunk["page_no"]:
            head += f"｜p.{chunk['page_no']}"
        print(head)
        body = chunk["content"]
        if not full and len(body) > PREVIEW_CHARS:
            body = body[:PREVIEW_CHARS] + f"…（还有 {len(chunk['content']) - PREVIEW_CHARS} 字，加 --full 看全文）"
        print(body)

    print(
        f"\n[RESULT] stage=kb state={result['state']} top={top} "
        f"chunks={len(result['chunks'])} threshold={result['threshold']}"
    )


def main():
    parser = argparse.ArgumentParser(description="知识库向量检索（兜底级之一）")
    parser.add_argument("-q", "--query", required=True, help="改写后的自洽问题")
    parser.add_argument("--threshold", type=float, default=None, help="默认读 env.json 的 KB_THRESHOLD（0.6）")
    parser.add_argument("--k", type=int, default=None, help="片段数，默认 env.json 的 KB_TOP_K")
    parser.add_argument("--expand-step", type=int, default=None, help="片段前后扩几块，默认 env.json 的 KB_EXPAND_STEP")
    parser.add_argument("--full", action="store_true", help="打印片段全文（默认每段截到 600 字）")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--env-file", default=None)
    args = parser.parse_args()

    cfg = load_config(args.env_file)
    result = kb_search(cfg, args.query, threshold=args.threshold, k=args.k, expand_step=args.expand_step)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        render(result, full=args.full)
    return 0


if __name__ == "__main__":
    run_cli(main)
