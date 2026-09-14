#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只跑第二级检索：LightRAG 图谱检索（SSE）。

一般流程请用 recommend.py。本脚本用于单独验证图谱库是否通、看实体与关系。

  python3 scripts/graph_search.py -q "键槽卡钻怎么判断"
  python3 scripts/graph_search.py -q "键槽卡钻怎么判断" --graph --mode hybrid
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from platform_client import graph_search, load_config, run_cli


def render(result, with_graph=False):
    state = "有答案" if result["state"] == "hit" else "图谱没给出答案"
    print(f"[图谱] {state}｜kb_id={result['kb_id']}｜模式 {result['query_mode']}｜实体 {len(result['entities'])} 关系 {len(result['relationships'])}")
    print(f"[检索问题] {result['question']}")
    if not result["done"]:
        print("[⚠️] 没有收到 [DONE]，答案可能不完整（连接中断或超时，必要时调大 GRAPH_TIMEOUT）")
    print("\n────── 图谱答案 ──────")
    print(result["answer"] or "(空)")

    if with_graph and result["entities"]:
        print("\n[实体]")
        for ent in result["entities"][:40]:
            print(f"  {ent.get('id')} {ent.get('entity')}（{ent.get('type')}）{(ent.get('description') or '')[:60]}")
        if result["relationships"]:
            names = {str(e.get("id")): e.get("entity") for e in result["entities"]}
            print("[关系]")
            for rel in result["relationships"][:40]:
                src = names.get(str(rel.get("source")), rel.get("source"))
                dst = names.get(str(rel.get("target")), rel.get("target"))
                print(f"  {src} → {dst}：{(rel.get('description') or '')[:60]}")
    for note in result["notes"]:
        print(f"[备注] {note}")

    print(
        f"\n[RESULT] stage=graph state={result['state']} done={result['done']} "
        f"entities={len(result['entities'])} relationships={len(result['relationships'])}"
    )


def main():
    parser = argparse.ArgumentParser(description="图谱检索（第二级）")
    parser.add_argument("-q", "--query", required=True, help="改写后的自洽问题")
    parser.add_argument("--mode", default=None, help="query_mode，默认 env.json 的 GRAPH_QUERY_MODE（hybrid）")
    parser.add_argument("--graph", action="store_true", help="打印实体与关系明细")
    parser.add_argument("--timeout", type=float, default=None, help="秒，默认 env.json 的 GRAPH_TIMEOUT")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--env-file", default=None)
    args = parser.parse_args()

    cfg = load_config(args.env_file)
    result = graph_search(cfg, args.query, mode=args.mode, timeout=args.timeout)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        render(result, with_graph=args.graph)
    return 0


if __name__ == "__main__":
    run_cli(main)
