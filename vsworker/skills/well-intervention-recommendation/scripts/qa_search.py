#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只跑第一级检索：问答对相似检索。

一般流程请直接用 recommend.py（它会在未命中时自动接兜底级：知识库或图谱）。
本脚本用于单独看问答对的召回明细、调阈值、排查「命中但 answer 为 null」。

  python3 scripts/qa_search.py -q "卡钻怎么处理？"
  python3 scripts/qa_search.py -q "卡钻怎么处理？" --threshold 0.6 --k 10 --show-all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from platform_client import describe, fmt_sim, load_config, qa_search, run_cli

STATE_TEXT = {
    "hit": "命中",
    "answer_null": "召回到了但答案为空（问答对大概率没发布）",
    "below_threshold": "未命中（全部低于阈值）",
    "empty": "未命中（向量库零召回）",
}


def preview(text, width=70):
    flat = " ".join((text or "").split())
    return flat[:width] + ("…" if len(flat) > width else "")


def render(result, show_all=False, full=True):
    state = result["state"]
    head = f"[QA] {STATE_TEXT[state]}｜阈值 {result['threshold']:.2f}｜最高相似度 {fmt_sim(result['top_similarity'])}"
    if result["hits"]:
        head += f"｜{describe(result['hits'][0])}"
    print(head)
    print(f"[检索问题] {result['question']}")
    print(f"[检索范围] {result['scope']}，k={result['k']}，原始召回 {result['raw_count']} 条 → 去重 {len(result['all'])} 条")
    if result["promoted_aggregate"]:
        print("[排序调整] 问题没带井名，已把「综合结论」聚合条目提到第一位（单案例条目相似度相近时会抢命中）")

    for idx, hit in enumerate(result["hits"], 1):
        print(
            f"\n────── #{idx} 相似度 {hit['similarity']:.4f} │ {describe(hit)} │ QA-ID {hit['id']} │ 召回 {hit['recall_count']} 次 ──────"
        )
        print((hit["answer"] or "").strip() if full else preview(hit["answer"], 200))

    if result["nulls"]:
        print("\n[⚠️ 答案为空的召回]")
        for hit in result["nulls"]:
            print(f"  {hit['similarity']:.4f} QA-ID {hit['id']}（答案为空，判不出类型）")
        print("  → 向量命中但回表取不到主问答：检查该类别是否点了「发布」（平台部署说明 §8.4）")

    rest = [it for it in result["all"] if it not in result["hits"] and it not in result["nulls"]]
    if rest and (show_all or state != "hit"):
        print(f"\n[阈值以下的召回]（共 {len(rest)} 条，调阈值时看这里）")
        for hit in rest[: (len(rest) if show_all else 5)]:
            print(f"  {hit['similarity']:.4f} {describe(hit)} │ {preview(hit['answer'])}")

    print(
        f"\n[RESULT] stage=qa state={state} top={fmt_sim(result['top_similarity'])} "
        f"hits={len(result['hits'])} nulls={len(result['nulls'])} threshold={result['threshold']:.2f} "
        f"platform_status={result['platform_status'] or '?'}"
    )


def main():
    parser = argparse.ArgumentParser(description="问答对相似检索（第一级）")
    parser.add_argument("-q", "--query", required=True, help="改写后的自洽问题")
    parser.add_argument("--threshold", type=float, default=None, help="相似度阈值，默认读 env.json 的 QA_THRESHOLD")
    parser.add_argument("--k", type=int, default=None, help="召回条数，默认读 env.json 的 QA_TOP_K")
    parser.add_argument("--show-all", action="store_true", help="把阈值以下的召回全部列出")
    parser.add_argument("--preview-only", action="store_true", help="答案只打摘要，不打全文")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--env-file", default=None)
    args = parser.parse_args()

    cfg = load_config(args.env_file)
    result = qa_search(cfg, args.query, threshold=args.threshold, k=args.k)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        render(result, show_all=args.show_all, full=not args.preview_only)
    return 0


if __name__ == "__main__":
    run_cli(main)
