#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""配置与连通性自检。换环境、换 token、报鉴权错时先跑这个。

  python3 scripts/check_env.py
  python3 scripts/check_env.py --skip-graph -q "卡钻怎么处理？"

最后一行一定是 [自检结果] PASS/FAIL，照它判断，别看退出码。
"""
from __future__ import annotations

import argparse
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from platform_client import (
    FALLBACK_CN,
    ConfigError,
    PlatformError,
    fmt_sim,
    graph_search,
    kb_search,
    load_config,
    opener,
    qa_search,
    use_utf8,
)


def show_config(cfg):
    print("────── 当前配置 ──────")
    print(f"  env.json 文件          {cfg.env_file}")
    print(f"  PLATFORM_BASE_URL  {cfg.base_url or '(空)'}")
    print(f"  PLATFORM_TOKEN     {cfg.masked_token()}")
    if cfg.token:
        print(f"  鉴权头             {cfg.auth_header}: {(cfg.auth_prefix + ' ') if cfg.auth_prefix else ''}<token>")
    else:
        print("  鉴权头             不发（问答对/知识库/图谱三级当前都不需要鉴权；若网关回 610 先查路由拼写，不是凭证问题）")
    print(f"  网络               {'走系统代理' if cfg.use_proxy else '直连（绕开系统代理）'}")
    if cfg.cookie:
        print(f"  PLATFORM_COOKIE    已设置（{len(cfg.cookie)} 字符）")
    if cfg.extra_headers:
        print(f"  额外请求头         {', '.join(cfg.extra_headers)}")
    if cfg.qa_type_id:
        print(f"  QA_TYPE_ID         {cfg.qa_type_id}（单库检索）")
    print(f"  QA_ID_LIST         {len(cfg.qa_ids)} 个问答库")
    for qa_id in cfg.qa_ids:
        print(f"      - {qa_id}  →  {cfg.qa_labels.get(qa_id, '(未标注类别)')}")
    print(f"  QA_THRESHOLD       {cfg.qa_threshold}    QA_TOP_K {cfg.qa_top_k}")
    print(f"  聚合优先           {'开' if cfg.prefer_aggregate else '关'}（margin {cfg.aggregate_margin}）")
    print(f"  兜底级             {FALLBACK_CN[cfg.fallback]}"
          + ("（知识库与图谱只能开一个）" if cfg.fallback != "none" else ""))
    print(f"  KB_ID_LIST         {'、'.join(cfg.kb_ids) or '(空)'}    "
          f"阈值 {cfg.kb_threshold}  top_k {cfg.kb_top_k}  expand_step {cfg.kb_expand_step}"
          f"    {'开' if cfg.kb_enabled else '关（KB_ENABLED=0）'}")
    print(f"  GRAPH_KB_ID        {cfg.graph_kb_id or '(空)'}    模式 {cfg.graph_mode}    "
          f"{'开' if cfg.graph_enabled else '关（GRAPH_ENABLED=0）'}")
    print(f"  超时               HTTP {cfg.http_timeout}s / 图谱 {cfg.graph_timeout}s")
    print(f"  井控红线关键词     {'、'.join(cfg.guard_keywords) or '(无)'}")
    print()


def check_reachable(cfg):
    if not cfg.base_url:
        print("[FAIL] 连通性：PLATFORM_BASE_URL 为空")
        return False
    try:
        with opener(cfg).open(cfg.base_url, timeout=min(cfg.http_timeout, 10)) as resp:
            print(f"[PASS] 连通性：{cfg.base_url} 返回 HTTP {resp.status}")
        return True
    except urllib.error.HTTPError as exc:
        if exc.code in (502, 503, 504) and cfg.use_proxy:
            print(f"[FAIL] 连通性：{cfg.base_url} 返回 HTTP {exc.code}；"
                  "当前 PLATFORM_USE_PROXY=1，多半是本机代理把内网地址劫走了，设回 0 直连")
            return False
        print(f"[PASS] 连通性：{cfg.base_url} 返回 HTTP {exc.code}（能连上就算通）")
        return True
    except urllib.error.URLError as exc:
        print(f"[FAIL] 连通性：连不上 {cfg.base_url} —— {exc.reason}（确认在内网/VPN 内）")
        return False


def check_qa(cfg, question):
    try:
        result = qa_search(cfg, question, threshold=cfg.qa_threshold)
    except (ConfigError, PlatformError) as exc:
        print(f"[FAIL] 问答对检索：{exc}")
        return False
    state, top = result["state"], fmt_sim(result["top_similarity"])
    if state == "hit":
        print(f"[PASS] 问答对检索：命中 {len(result['hits'])} 条，最高 {top}，类别 {result['hits'][0]['label'] or '未标注'}")
        return True
    if state == "answer_null":
        print(f"[FAIL] 问答对检索：召回到了（最高 {top}）但 answer 为 null —— 该类别没点「发布」")
        return False
    if state == "below_threshold":
        print(f"[WARN] 问答对检索：接口通，但最高相似度 {top} < 阈值 {cfg.qa_threshold}（换个探针问题，或调阈值）")
        return True
    print(f"[WARN] 问答对检索：接口通，但零召回。确认 QA_ID_LIST 的 ID 正确且问答对已发布")
    return True


def check_kb(cfg, question):
    try:
        result = kb_search(cfg, question)
    except (ConfigError, PlatformError) as exc:
        print(f"[FAIL] 知识库检索：{exc}")
        return False
    if result["state"] == "hit":
        print(
            f"[PASS] 知识库检索：命中 {len(result['chunks'])} 段，最高 {result['top_score']:.4f}，"
            f"文档 {'、'.join(result['sources']) or '未标来源'}"
        )
        return True
    print("[WARN] 知识库检索：接口通但零片段。确认 KB_ID_LIST 是知识库 ID、文档已「保存并处理」入库；"
          f"或探针问题本就离题（当前阈值 {cfg.kb_threshold}）")
    return True


def check_graph(cfg, question):
    try:
        result = graph_search(cfg, question)
    except (ConfigError, PlatformError) as exc:
        print(f"[FAIL] 图谱检索：{exc}")
        return False
    if result["state"] == "hit":
        print(
            f"[PASS] 图谱检索：有答案（{len(result['answer'])} 字），"
            f"实体 {len(result['entities'])} 关系 {len(result['relationships'])}"
            + ("" if result["done"] else "，但没收到 [DONE]")
        )
        return True
    print("[WARN] 图谱检索：接口通但没给出答案。确认 GRAPH_KB_ID 是图谱库 ID 且已入库")
    return True


def main():
    use_utf8()
    parser = argparse.ArgumentParser(description="配置与连通性自检")
    parser.add_argument("-q", "--query", default="卡钻怎么处理？", help="探针问题")
    parser.add_argument("--skip-fallback", "--skip-graph", dest="skip_fallback", action="store_true",
                        help="只查连通性和问答对，不碰兜底级")
    parser.add_argument("--env-file", default=None)
    args = parser.parse_args()

    try:
        cfg = load_config(args.env_file)
    except ConfigError as exc:
        print(f"[FAIL] 读配置：{exc}")
        print("[自检结果] FAIL —— 配置读不出来")
        return 2

    show_config(cfg)
    results = [("连通性", check_reachable(cfg)), ("问答对", check_qa(cfg, args.query))]
    if args.skip_fallback:
        print("[SKIP] 兜底级（--skip-fallback）")
    elif cfg.fallback == "kb":
        print("[SKIP] 图谱检索（env.json 里 GRAPH_ENABLED=0）")
        results.append(("知识库", check_kb(cfg, args.query)))
    elif cfg.fallback == "graph":
        print("[SKIP] 知识库检索（env.json 里 KB_ENABLED=0）")
        results.append(("图谱", check_graph(cfg, args.query)))
    else:
        print("[SKIP] 兜底级：知识库和图谱都关着（问答对未命中会直接 no_answer）")

    failed = [name for name, ok in results if not ok]
    print()
    if failed:
        print(f"[自检结果] FAIL —— 未通过：{('、'.join(failed))}（按上面每条的提示改 {cfg.env_file}）")
        return 1
    print(f"[自检结果] PASS —— {len(results)}/{len(results)} 项通过，可以跑 scripts/recommend.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
