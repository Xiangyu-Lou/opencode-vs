#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""措施推荐的主入口：问答对 →（未命中才）兜底级，命中即退出。

兜底级是**知识库或图谱，二选一**（`env.json` 的 KB_ENABLED / GRAPH_ENABLED，两个都开会报配置错误），
也可以都关。当前部署：知识库开、图谱关（图谱库还在入库）。

这是 SKILL.md 里唯一需要照抄的命令。传进来的 --query 必须是**已改写好的自洽问题**
（多轮对话里补全主语/井号/事故类型），脚本不做改写。

  python3 scripts/recommend.py -q "卡钻怎么处理？"
  python3 scripts/recommend.py -q "Koulele CE-19 2021年10月卡钻是怎么处理的？" --threshold 0.72
  python3 scripts/recommend.py -q "键槽卡钻怎么处理" --source kb    # 用户点名要查《钻井事故与复杂问题》，跳过问答对
  python3 scripts/recommend.py -q "什么是键槽卡钻" --json

结论行同时打在**第一行和最后一行**（平台截断输出时保首尾）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from platform_client import (
    FALLBACK_CN,
    PlatformError,
    describe,
    fmt_sim,
    graph_search,
    guard_hits,
    is_definition,
    kb_search,
    load_config,
    qa_search,
    run_cli,
)

RULE = "─" * 58
# 知识库片段整体最多打这么多字，超了让人去跑 kb_search.py --full（片段是《钻井事故与复杂问题》原文，可能很长）
KB_PRINT_BUDGET = 6000


def preview(text, width=64):
    flat = " ".join((text or "").split())
    return (flat[:width] + ("…" if len(flat) > width else "")) if flat else "(答案为空)"


def run_fallback(cfg, level, args):
    """跑《钻井事故与复杂问题》那一级（知识库或图谱），返回 (kb, graph, kb_error, graph_error)。"""
    kb = graph = kb_error = graph_error = None
    if level == "kb":
        try:
            kb = kb_search(cfg, args.query, threshold=args.kb_threshold)
        except PlatformError as exc:
            kb_error = str(exc)
    else:
        try:
            graph = graph_search(cfg, args.query, mode=args.mode)
        except PlatformError as exc:
            graph_error = str(exc)
    return kb, graph, kb_error, graph_error


def print_kb(kb, query):
    print(
        f"\n[来源] 知识库（《钻井事故与复杂问题》）│ 命中 {len(kb['chunks'])} 段 │ "
        f"最高 {kb['top_score']:.4f} │ 文档 {'、'.join(kb['sources']) or '未标来源'} │ "
        f"阈值 {kb['threshold']}（服务端过滤）"
    )
    print("[提醒] 以下是**《钻井事故与复杂问题》的原文片段，不是答案**：自己归纳成结论 + 步骤，"
          "并在回答里写明依据来自《钻井事故与复杂问题》")
    budget = KB_PRINT_BUDGET
    for i, chunk in enumerate(kb["chunks"], 1):
        if budget <= 0:
            print(f"\n[片段 {i}–{len(kb['chunks'])}] 未打印（超出输出预算），需要就跑："
                  f"python3 scripts/kb_search.py -q \"{query}\" --full")
            break
        body = chunk["content"]
        if len(body) > budget:
            body = body[:budget] + "…（截断，全文用 kb_search.py --full）"
        budget -= len(body)
        print(f"\n{RULE}\n[片段 {i}] {chunk['score']:.4f} │ {chunk['source'] or '未标来源'}\n{body}\n{RULE}")


def print_graph(graph):
    print(
        f"\n[来源] 图谱库（《钻井事故与复杂问题》）│ kb_id={graph['kb_id']} │ "
        f"模式 {graph['query_mode']} │ 实体 {len(graph['entities'])} 关系 {len(graph['relationships'])}"
        + ("" if graph["done"] else " │ ⚠️ 未收到 [DONE]，答案可能被截断")
    )
    print(f"\n{RULE}\n{graph['answer'] or '(图谱没有给出答案)'}\n{RULE}")
    names = [str(e.get("entity")) for e in graph["entities"][:12] if e.get("entity")]
    if names:
        print(f"[图谱实体] {'、'.join(names)}")


def main():
    parser = argparse.ArgumentParser(description="井下作业措施推荐：问答对 → 兜底级，命中即退出")
    parser.add_argument("-q", "--query", required=True, help="已改写为自洽的检索问题（不要直接塞用户原话的追问）")
    parser.add_argument("--source", choices=("auto", "qa", "kb", "graph"), default="auto",
                        help="auto=问答对→兜底级（默认）；qa=只查问答对；"
                             "kb/graph=**跳过问答对**直接查该库（仅在用户点名要查《钻井事故与复杂问题》/图谱时用）")
    parser.add_argument("--threshold", type=float, default=None, help="问答对相似度阈值，默认读 env.json 的 QA_THRESHOLD")
    parser.add_argument("--k", type=int, default=None, help="问答对召回条数，默认读 env.json 的 QA_TOP_K")
    parser.add_argument("--kb-threshold", type=float, default=None, help="知识库阈值，默认读 env.json 的 KB_THRESHOLD")
    parser.add_argument("--no-fallback", "--no-graph", dest="no_fallback", action="store_true",
                        help="等同 --source qa：问答对未命中就到此为止")
    parser.add_argument("--no-guard", action="store_true", help="关掉井控红线拦截（默认开）")
    parser.add_argument("--mode", default=None, help="图谱 query_mode，默认 hybrid")
    parser.add_argument("--json", action="store_true", help="输出 JSON（给脚本用，人读用默认格式）")
    parser.add_argument("--env-file", default=None)
    args = parser.parse_args()

    cfg = load_config(args.env_file)
    guards = [] if args.no_guard else guard_hits(cfg, args.query)
    source = "qa" if args.no_fallback else args.source

    qa = kb = graph = kb_error = graph_error = None
    definitional = False
    threshold = None
    forced_note = ""

    # ---- 决策 --------------------------------------------------------------
    if source in ("kb", "graph"):
        # 用户点名要查《钻井事故与复杂问题》/图谱 → 跳过问答对。env.json 里关着也照查，但要说明。
        level_cn = FALLBACK_CN[source]
        enabled = cfg.kb_enabled if source == "kb" else cfg.graph_enabled
        if not enabled:
            key = "KB_ENABLED" if source == "kb" else "GRAPH_ENABLED"
            forced_note = (f"[提示] env.json 里这一级是关着的（{key}=0），本次因为点名指定才查；"
                           "结果可能不可靠，回答时要提醒用户")
        kb, graph, kb_error, graph_error = run_fallback(cfg, source, args)
        got = bool((kb and kb["state"] == "hit") or (graph and graph["state"] == "hit"))
        failed = bool(kb_error or graph_error)

        if got:
            decision = "use_kb_answer" if source == "kb" else "use_graph_answer"
            what = ("下面给的是**《钻井事故与复杂问题》的原文片段，不是写好的答案**：按 SKILL.md「统一回答结构」"
                    "归纳成【结论】+【处置步骤】" if source == "kb" else "照图谱答案回答")
            headline = (
                f"[决策] 按要求**跳过问答对**，直接查{level_cn}（《钻井事故与复杂问题》）→ {what}。"
                "回答里必须写明「依据来自《钻井事故与复杂问题》」，"
                "并告诉用户默认流程会先查历史记录，需要的话可以再问一次"
            )
        else:
            decision = "no_answer"
            why = f"{level_cn}调用失败" if failed else f"{level_cn}里没有相关内容"
            headline = (
                f"[决策] 按要求跳过问答对直接查{level_cn}，但{why} → 不要编造措施。"
                "告诉用户《钻井事故与复杂问题》这一级没有对应内容，并建议回到默认流程（先查尼日尔历史记录）"
            )
    else:
        # 定义题（「什么是X」）单独抬高阈值：台账记录事故处置、不记术语定义，这类问题该落到《钻井事故与复杂问题》那一级
        definitional = is_definition(args.query)
        threshold_in = cfg.qa_threshold if args.threshold is None else args.threshold
        if definitional:
            threshold_in = max(threshold_in, cfg.definition_threshold)

        qa = qa_search(cfg, args.query, threshold=threshold_in, k=args.k)
        threshold = qa["threshold"]
        top = fmt_sim(qa["top_similarity"])
        fallback = "none" if source == "qa" else cfg.fallback

        if qa["state"] == "hit":
            primary = qa["hits"][0]
            decision = "use_qa_answer"
            headline = (
                f"[决策] 问答对命中（相似度 {primary['similarity']:.4f}，{describe(primary)}）"
                "→ 把下面的「答案正文」原样输出给用户，不要改写、不要再补《钻井事故与复杂问题》的内容、不要追加追问示例"
            )
        else:
            if qa["state"] == "answer_null":
                reason = f"问答对召回到了（最高 {top} ≥ 阈值 {threshold:.2f}）但 answer 为空 —— 该类别没点「发布」"
            elif qa["state"] == "below_threshold":
                reason = f"问答对未命中（最高 {top} < 阈值 {threshold:.2f}）"
            else:
                reason = "问答对未命中（向量库零召回）"

            if fallback == "none":
                why = ("指定了 --source qa" if source == "qa"
                       else "两级兜底都关着（env.json 里 KB_ENABLED=0、GRAPH_ENABLED=0）")
                decision = "no_answer"
                headline = f"[决策] {reason}，且{why} → 不要编造措施，如实说明台账里没有同类记录"
            else:
                level_cn = FALLBACK_CN[fallback]
                kb, graph, kb_error, graph_error = run_fallback(cfg, fallback, args)
                got = bool((kb and kb["state"] == "hit") or (graph and graph["state"] == "hit"))
                failed = bool(kb_error or graph_error)

                if got and fallback == "kb":
                    decision = "use_kb_answer"
                    headline = (
                        f"[决策] {reason} → 已转知识库。下面给的是**《钻井事故与复杂问题》的原文片段，不是写好的答案**："
                        "按 SKILL.md「统一回答结构」归纳成【结论】+【处置步骤】，"
                        "必须写明「依据来自《钻井事故与复杂问题》」"
                        "（【依据】就写书名，不写「图谱」「知识库」，也不补「台账里没有」）"
                    )
                elif got:
                    decision = "use_graph_answer"
                    headline = (
                        f"[决策] {reason} → 已转知识图谱。图谱答案来自《钻井事故与复杂问题》构建的本体图谱："
                        "回答时必须写明「依据来自《钻井事故与复杂问题》」"
                        "（【依据】就写书名，不写「图谱」「知识库」，也不补「台账里没有」）"
                    )
                else:
                    decision = "no_answer"
                    tail_reason = f"{level_cn}调用失败" if failed else f"{level_cn}也没有给出内容"
                    headline = (
                        f"[决策] {reason}，{tail_reason} → 不要编造措施，"
                        "向用户说明没有同类记录，请其补充井号/井深/工况，或转人工"
                    )

    detail_line = ""
    if guards:
        decision = "route_to_well_control"
        detail_line = headline.replace("[决策]", "[检索结论]", 1)
        headline = (
            "[决策] 命中井控红线 → **不做措施推荐**：回答「立即执行井控程序（按设计关井、压井）、"
            "上报值班、转人工」。下面的检索结果只作背景，不得当作本项目处置经验"
        )

    if args.json:
        print(json.dumps(
            {
                "query": args.query,
                "decision": decision,
                "source": source,
                "guards": guards,
                "definitional": definitional,
                "threshold": threshold,
                "qa": qa,
                "kb": kb,
                "kb_error": kb_error,
                "graph": graph,
                "graph_error": graph_error,
            },
            ensure_ascii=False, indent=2,
        ))
        return 3 if (graph_error or kb_error) else 0

    # ---- 人读格式：结论行在最前 --------------------------------------------
    if guards:
        print(
            f"[⚠️ 井控红线] 问题命中 {('、'.join(guards))}：历史台账对井喷零覆盖，"
            "**不得按措施推荐作答**。"
        )
    print(headline)
    if detail_line:
        print(detail_line)
    print(f"[检索问题] {args.query}")
    if forced_note:
        print(forced_note)
    if definitional:
        print(
            f"[提问类型] 定义题 → 问答对阈值临时提到 {threshold:.2f}"
            "（台账记录的是事故处置，术语定义应由《钻井事故与复杂问题》/图谱回答）"
        )

    if qa is None:
        print(f"[跳过问答对] --source {source}：本次没有查尼日尔历史记录，答案只来自《钻井事故与复杂问题》")
    else:
        if qa["nulls"]:
            print(
                f"[⚠️ 问答对未发布] 有 {len(qa['nulls'])} 条召回的 answer 为 null —— "
                "向量命中但回表取不到主问答，去平台把对应类别点「发布」（平台部署说明 §8.4）"
            )

        if qa["state"] == "hit":
            primary = qa["hits"][0]
            if qa["promoted_aggregate"]:
                print("[排序调整] 问题未带井名，已把聚合条目（综合结论那一类）提为首选（单案例条目会抢命中）")
            print(
                f"[来源] 问答对（尼日尔历史记录）│ {describe(primary)} │ "
                f"相似度 {primary['similarity']:.4f} │ QA-ID {primary['id']}"
            )
            print(f"\n{RULE}\n{(primary['answer'] or '').strip()}\n{RULE}")
            if len(qa["hits"]) > 1:
                print("\n[同时命中的其他条目]（供你判断，用户没追问就别拼进答案）")
                for hit in qa["hits"][1:]:
                    print(f"  {hit['similarity']:.4f} {describe(hit)} │ {preview(hit['answer'])}")
        elif qa["all"]:
            print("[问答对召回明细]")
            for hit in qa["all"][:3]:
                if not (hit["answer"] or "").strip():
                    flag = "答案为空"
                elif hit["similarity"] >= threshold:
                    flag = "≥阈值"
                else:
                    flag = "<阈值"
                print(f"  {hit['similarity']:.4f} [{flag}] {describe(hit)} │ {preview(hit['answer'])}")
        else:
            print("[问答对] 向量库零召回")

    if kb_error:
        print(f"\n[知识库错误] {kb_error}")
    elif kb and kb["state"] == "hit":
        print_kb(kb, args.query)
    elif kb:
        print(f"\n[知识库] 零片段：阈值 {kb['threshold']} 以上没有内容（离题片段一般只有 0.12–0.25）")

    if graph_error:
        print(f"\n[图谱错误] {graph_error}")
    elif graph:
        print_graph(graph)

    if qa and qa["state"] == "hit":
        stage = "qa"
    elif kb and kb["state"] == "hit":
        stage = "kb"
    elif graph and graph["state"] == "hit":
        stage = "graph"
    else:
        stage = "none"

    tail = (
        f"\n[RESULT] decision={decision} stage={stage} source={source} "
        f"qa_state={qa['state'] if qa else 'skipped'} "
        f"qa_top={fmt_sim(qa['top_similarity']) if qa else '—'} "
        f"threshold={f'{threshold:.2f}' if threshold is not None else '—'} "
        f"guards={','.join(guards) if guards else 'none'}"
    )
    if kb is not None or kb_error:
        tail += f" kb={'error' if kb_error else kb['state']}"
    if graph is not None or graph_error:
        tail += f" graph={'error' if graph_error else graph['state']}"
    print(tail)
    return 3 if (graph_error or kb_error) else 0


if __name__ == "__main__":
    run_cli(main)
