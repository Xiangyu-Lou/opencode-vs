#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""井下作业措施推荐 —— 识油平台检索的共享客户端。

只用标准库（沙箱 Python 3.11 与本机 3.14 都能跑），负责四件事：

1. 读 `env.json`（skill 根目录；平台注册 skill 时会自动解析它并写进环境变量），
   进程环境变量优先 —— 所以平台上跑和本地跑读到的是同一份配置；
2. 拼装鉴权头 —— 2026-09-09 平台改版后**问答对与知识库不需要任何鉴权头**，
   只有图谱（LightRAG）那一级还要 V-* + token；头名/前缀仍然做成可配，凭证空着就不发；
3. 调 JSON 接口：问答对相似检索 `/backend/qa-algo-py/qa/robot_search`
   与知识库向量检索 `/backend/chatpdf-algo4-py/vector/query_vector`；
4. 调 SSE 接口：图谱检索 `/backend/lightrag/search`，把事件流解析成答案 + 图谱。

问答对未命中后的**兜底级只能有一个**：知识库或图谱，或都不开（见 `Config.fallback`）。

其余脚本只 import 本模块，不要各自写 HTTP。
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent

QA_PATH = "/backend/qa-algo-py/qa/robot_search"
# 路由是 lightrag，**不是 lightrag-py**（QA/KB 那两个才带 -py）。
# 写错路由时网关一律回 {"status":610,"message":"No authentication information ."}，
# 看着像鉴权失败 —— 2026-09-10 之前就是这么被误判成「图谱要凭证」的。收到 610 先查这一行。
GRAPH_PATH = "/backend/lightrag/search"
# 这个接口不在官方接口文档里，是从平台前端抓的（契约见仓库 docs/检索接口.md ③）
KB_PATH = "/backend/chatpdf-algo4-py/vector/query_vector"

KNOWN_KEYS = (
    "PLATFORM_BASE_URL",
    "PLATFORM_TOKEN",
    "PLATFORM_AUTH_HEADER",
    "PLATFORM_AUTH_PREFIX",
    "PLATFORM_COOKIE",
    "PLATFORM_EXTRA_HEADERS",
    "PLATFORM_USE_PROXY",
    "QA_ID_LIST",
    "QA_TYPE_ID",
    "QA_THRESHOLD",
    "QA_TOP_K",
    "QA_PREFER_AGGREGATE",
    "QA_AGGREGATE_MARGIN",
    "GRAPH_KB_ID",
    "GRAPH_QUERY_MODE",
    "GRAPH_ENABLED",
    "KB_ID_LIST",
    "KB_ENABLED",
    "KB_THRESHOLD",
    "KB_TOP_K",
    "KB_EXPAND_STEP",
    "HTTP_TIMEOUT",
    "GRAPH_TIMEOUT",
    "GUARD_KEYWORDS",
    "QA_DEFINITION_THRESHOLD",
)


class PlatformError(RuntimeError):
    """平台侧错误（鉴权、网络、响应格式）。退出码 3。"""


class ConfigError(RuntimeError):
    """env.json 配置缺失或写错。退出码 2。"""


def use_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass


# --------------------------------------------------------------------------- env


def _parse_env_file(path: Path) -> dict:
    values = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key] = value
    return values


def _parse_env_json(path: Path) -> dict:
    """`env.json`：**所有环境变量的唯一存放处，里面只放环境变量**。

    平台注册 skill 时会自动解析它、把每个键值写进进程环境变量；本地跑没人注入，脚本自己读同一份。
    所以它必须是**扁平的 `{"变量名": "值"}`** —— 多写任何别的键（注释、分组、嵌套）都会被平台
    当成环境变量写进去。变量的说明写在仓库的 `docs/环境变量.md`，不要写进这个文件。

    值一律用字符串（环境变量本来就是字符串）；写成数字或布尔也认（布尔转 `"1"` / `"0"`）。
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path} 不是合法 JSON：{exc}")
    if not isinstance(data, dict):
        raise ConfigError(f"{path} 顶层必须是扁平 JSON 对象，如 {{\"QA_THRESHOLD\": \"0.69\"}}")

    values = {}
    for key, value in data.items():
        if isinstance(value, bool):
            values[key] = "1" if value else "0"
        elif value is None:
            values[key] = ""
        elif isinstance(value, (int, float, str)):
            values[key] = str(value)
        else:
            raise ConfigError(
                f"{path} 里 {key} 的值是 {type(value).__name__} —— 环境变量只能是字符串"
                "（值本身是 JSON 的，例如 PLATFORM_EXTRA_HEADERS，要写成转义后的字符串）"
            )
    return values


def _parse_config_file(path: Path) -> dict:
    """按后缀分流：`.json` 走 env.json 解析，其余按 `KEY=VALUE`（旧的 env.json）解析。"""
    return _parse_env_json(path) if path.suffix.lower() == ".json" else _parse_env_file(path)


def load_values(env_file: str | None = None) -> dict:
    """合并 env.json 与环境变量；环境变量胜出（平台注入的就是环境变量，也便于临时覆盖）。"""
    candidates = []
    if env_file:
        candidates.append(Path(env_file).expanduser())
    elif os.environ.get("WIR_ENV_FILE"):
        candidates.append(Path(os.environ["WIR_ENV_FILE"]).expanduser())
    else:
        # env.json 是正主；.env 只为旧部署留个后路
        candidates.extend([
            SKILL_ROOT / "env.json", Path.cwd() / "env.json",
            SKILL_ROOT / ".env", Path.cwd() / ".env",
        ])

    values, used = {}, None
    for path in candidates:
        if path.is_file():
            values.update(_parse_config_file(path))
            used = str(path)
            break
    if env_file and used is None:
        raise ConfigError(f"--env-file 指定的文件不存在：{env_file}")

    for key in KNOWN_KEYS:
        if os.environ.get(key):
            values[key] = os.environ[key]
    values["__env_file__"] = used or ""
    return values


def _as_float(values, key, default):
    raw = (values.get(key) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        raise ConfigError(f"{key} 不是数字：{raw!r}")


def _as_int(values, key, default):
    raw = (values.get(key) or "").strip()
    if not raw:
        return default
    try:
        return int(float(raw))
    except ValueError:
        raise ConfigError(f"{key} 不是整数：{raw!r}")


def _split_list(raw: str):
    return [part.strip() for part in re.split(r"[,\n;]+", raw or "") if part.strip()]


class Config:
    """解析后的配置。每个检索前调用对应的 require_* 做前置校验。"""

    def __init__(self, values: dict):
        self.env_file = values.get("__env_file__") or "(未找到 env.json，全部取自环境变量)"
        self.base_url = (values.get("PLATFORM_BASE_URL") or "").strip().rstrip("/")
        self.token = (values.get("PLATFORM_TOKEN") or "").strip()
        self.auth_header = (values.get("PLATFORM_AUTH_HEADER") or "Authorization").strip()
        # 默认 Bearer：只有填了 token 才会用到（图谱那一级），而平台要的就是 Bearer。
        # 网关哪天改成裸 token，在 env.json 里把它设成空串。
        self.auth_prefix = values.get("PLATFORM_AUTH_PREFIX", "Bearer").strip()
        self.cookie = (values.get("PLATFORM_COOKIE") or "").strip()

        self.extra_headers = {}
        raw_extra = (values.get("PLATFORM_EXTRA_HEADERS") or "").strip()
        if raw_extra:
            try:
                parsed = json.loads(raw_extra)
            except json.JSONDecodeError as exc:
                raise ConfigError(f"PLATFORM_EXTRA_HEADERS 不是合法 JSON：{exc}")
            if not isinstance(parsed, dict):
                raise ConfigError("PLATFORM_EXTRA_HEADERS 必须是 JSON 对象，如 {\"X-Tenant\":\"1\"}")
            self.extra_headers = {str(k): str(v) for k, v in parsed.items()}

        # 平台是内网地址，本机开了代理（Clash 之类）会把请求劫走并返回 502 —— 默认绕开系统代理
        self.use_proxy = (values.get("PLATFORM_USE_PROXY") or "0").strip() not in ("0", "false", "False", "no")
        self._opener = None

        self.qa_type_id = (values.get("QA_TYPE_ID") or "").strip()
        self.qa_ids, self.qa_labels = [], {}
        for item in _split_list(values.get("QA_ID_LIST", "")):
            qa_id, _, label = item.partition("=")
            qa_id, label = qa_id.strip(), label.strip()
            if not qa_id:
                continue
            self.qa_ids.append(qa_id)
            if label:
                self.qa_labels[qa_id] = label

        self.qa_threshold = _as_float(values, "QA_THRESHOLD", 0.7)
        self.qa_top_k = _as_int(values, "QA_TOP_K", 5)
        self.prefer_aggregate = (values.get("QA_PREFER_AGGREGATE") or "1").strip() not in ("0", "false", "False", "no")
        self.aggregate_margin = _as_float(values, "QA_AGGREGATE_MARGIN", 0.05)

        self.graph_kb_id = (values.get("GRAPH_KB_ID") or "").strip()
        self.graph_mode = (values.get("GRAPH_QUERY_MODE") or "hybrid").strip()
        # 两级兜底在代码里**都默认关**，漏写不会撞成「两个都开」的配置错误。
        # 但 env.json 的约定是 KB_ENABLED / GRAPH_ENABLED **两个都写出来**，哪怕其中一个是 0 ——
        # 兜底级用哪一个是整套部署最要紧的一个选择，写全了一眼可见、要换只是把两个值对调。
        # 见 docs/环境变量.md。
        self.graph_enabled = (values.get("GRAPH_ENABLED") or "0").strip() not in ("0", "false", "False", "no")

        # 第二级兜底的另一个选项：知识库（《钻井事故与复杂问题》的原文片段，不是成稿答案）
        self.kb_ids = _split_list(values.get("KB_ID_LIST", ""))
        self.kb_enabled = (values.get("KB_ENABLED") or "0").strip() not in ("0", "false", "False", "no")
        # 这个 score 不是问答对那套余弦：对题 0.93–0.996、离题 0.12–0.25，平台前端默认 0.6。
        # 服务端就按它过滤，低于阈值的片段根本不返回。
        self.kb_threshold = _as_float(values, "KB_THRESHOLD", 0.6)
        self.kb_top_k = _as_int(values, "KB_TOP_K", 3)
        # 只加长片段、不改分值（step 0/1/2 → 同一条 content 390/479/607 字）
        self.kb_expand_step = _as_int(values, "KB_EXPAND_STEP", 1)

        # 兜底级二选一：两个都开时不猜用户想要哪个，直接报错（比静默生效安全）
        if self.kb_enabled and self.graph_enabled:
            raise ConfigError(
                "KB_ENABLED 和 GRAPH_ENABLED 只能开一个 —— 问答对未命中后的兜底级二选一，"
                "现在两个都是 1。两边装的是同一本《钻井事故与复杂问题》，同时开会让答案来源说不清。"
                "把其中一个设为 0（当前选型是图谱：GRAPH_ENABLED=1、KB_ENABLED=0，"
                f"依据见仓库 docs/兜底级对比.md）。改这个文件：{self.env_file}"
            )
        self.fallback = "kb" if self.kb_enabled else ("graph" if self.graph_enabled else "none")

        self.http_timeout = _as_float(values, "HTTP_TIMEOUT", 60)
        self.graph_timeout = _as_float(values, "GRAPH_TIMEOUT", 180)
        self.guard_keywords = _split_list(values.get("GUARD_KEYWORDS", "井喷,井口失控,井控失效"))
        # 定义题（「什么是X」）单独抬高问答对阈值：台账记录的是事故处置、不是术语定义，
        # 这类问题本该落到《钻井事故与复杂问题》那一级。实测「什么是键槽卡钻？」对卡钻聚合条目有 0.7822，
        # 比好几条真正该命中的问法还高，靠通用阈值拦不掉。
        self.definition_threshold = _as_float(values, "QA_DEFINITION_THRESHOLD", 0.90)

    # -- 校验 -------------------------------------------------------------
    def _require_base(self):
        if not self.base_url:
            raise ConfigError(f"PLATFORM_BASE_URL 没填。改这个文件：{self.env_file}")

    def require_qa(self):
        self._require_base()
        if not self.qa_type_id and not self.qa_ids:
            raise ConfigError(
                "问答对检索要 QA_ID_LIST（多库，推荐）或 QA_TYPE_ID（单库），两者都空。"
                f" 改这个文件：{self.env_file}"
            )

    def require_graph(self):
        self._require_base()
        if not self.graph_kb_id:
            raise ConfigError(f"GRAPH_KB_ID 没填，图谱检索无法执行。改这个文件：{self.env_file}")

    def require_kb(self):
        self._require_base()
        if not self.kb_ids:
            raise ConfigError(f"KB_ID_LIST 没填，知识库检索无法执行。改这个文件：{self.env_file}")

    # -- 展示 -------------------------------------------------------------
    def masked_token(self):
        if not self.token:
            return "(空)"
        if len(self.token) <= 8:
            return "*" * len(self.token)
        return f"{self.token[:4]}…{self.token[-4:]}（长度 {len(self.token)}）"

    def label_for(self, qa_id):
        if not qa_id:
            return ""
        qa_id = str(qa_id)
        if qa_id in self.qa_labels:
            return self.qa_labels[qa_id]
        for key, label in self.qa_labels.items():
            if key in qa_id or qa_id in key:
                return label
        return ""


def load_config(env_file: str | None = None) -> Config:
    return Config(load_values(env_file))


# -------------------------------------------------------------------------- HTTP


def opener(cfg: Config):
    """默认绕开系统/环境变量里的代理；确实要走代理时在 env.json 设 PLATFORM_USE_PROXY=1。"""
    if cfg._opener is None:
        handlers = [] if cfg.use_proxy else [urllib.request.ProxyHandler({})]
        cfg._opener = urllib.request.build_opener(*handlers)
    return cfg._opener


def _headers(cfg: Config, accept: str) -> dict:
    # 凭证留空就一个鉴权头都不发（问答对/知识库现在就是这样）；填了就带上（图谱那一级需要）
    headers = {"Content-Type": "application/json", "Accept": accept}
    if cfg.token:
        headers[cfg.auth_header] = f"{cfg.auth_prefix} {cfg.token}" if cfg.auth_prefix else cfg.token
    if cfg.cookie:
        headers["Cookie"] = cfg.cookie
    headers.update(cfg.extra_headers)
    return headers


def _proxy_hint(cfg: Config) -> str:
    if not cfg.use_proxy:
        return ""
    return (
        "\n当前 PLATFORM_USE_PROXY=1，请求走了系统代理。平台是内网地址，"
        "本机的代理（Clash 之类）会把它劫走并返回 502 —— 把这项设回 0 直连。"
    )


def _auth_hint(cfg: Config) -> str:
    return (
        "网关回了 610/611。**先别急着找 token —— 三级接口当前都不需要任何鉴权头**"
        "（问答对、知识库、图谱都是不带 Authorization、不带 V-* 直接通）。\n"
        "  1. **首先查路由拼写。** 写错路由时网关同样回 610「No authentication information .」，"
        "看着像鉴权失败其实不是 —— 图谱的路由是 /backend/lightrag/search，"
        "曾经误写成 /backend/lightrag-py/search，白查了很久凭证（2026-09-10 定位）。\n"
        "     当前三条路由：\n"
        f"       问答对 {QA_PATH}\n"
        f"       图谱   {GRAPH_PATH}\n"
        f"       知识库 {KB_PATH}\n"
        "  2. 路由没错才考虑平台是否改回要鉴权：往 env.json 加 PLATFORM_TOKEN，"
        "需要时再加 PLATFORM_EXTRA_HEADERS（形如 {\"V-Access-Ticket\":\"…\",\"V-Client-Id\":\"…\"}）；"
        f"当前 token {cfg.masked_token()}，"
        f"头名/前缀是 PLATFORM_AUTH_HEADER / PLATFORM_AUTH_PREFIX（{cfg.auth_header!r} + {cfg.auth_prefix!r}）。\n"
        "     token 来源：平台「知识管理 → 知识令牌」新建，或从浏览器抓一个 AT- 开头的会话 token（会过期）。\n"
        f"  配置文件：{cfg.env_file}"
    )


def _check_envelope(cfg: Config, data):
    """平台网关失败时返回 {\"meta\":{\"success\":false,...},\"data\":null}。"""
    if not isinstance(data, dict):
        return
    meta = data.get("meta")
    if not isinstance(meta, dict) or meta.get("success") is not False:
        return
    status = meta.get("status")
    message = str(meta.get("message") or "").strip()
    lines = [f"平台返回失败：status={status} message={message or '(空)'}"]
    if status in (610, 611) or "authentication" in message.lower() or "鉴权" in message or "登录" in message:
        lines.append(_auth_hint(cfg))
    elif "问答对未找到" in message:
        lines.append(
            "向量库命中了但按 ID 回表取不到记录 —— 典型原因是问答对导入后没点「发布」，"
            "或换文件时旧条目删了没发布、两套向量并存。五个类别都要发布，「未发布: N」必须归零。"
        )
    raise PlatformError("\n".join(lines))


def post_json(cfg: Config, path: str, payload: dict, timeout: float | None = None):
    url = f"{cfg.base_url}{path}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=_headers(cfg, "application/json"), method="POST")
    try:
        with opener(cfg).open(request, timeout=timeout or cfg.http_timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:800] if exc.fp else ""
        extra = "\n" + _auth_hint(cfg) if exc.code in (401, 403) else ""
        hint = _proxy_hint(cfg) if exc.code in (502, 503, 504) else ""
        raise PlatformError(f"HTTP {exc.code} {exc.reason} —— {url}\n{detail}{extra}{hint}")
    except urllib.error.URLError as exc:
        raise PlatformError(
            f"连不上平台 {url}：{exc.reason}。确认在内网/VPN 内，且 PLATFORM_BASE_URL 正确。{_proxy_hint(cfg)}"
        )
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise PlatformError(f"响应不是 JSON（前 400 字）：{raw[:400]}")
    _check_envelope(cfg, data)
    return data


def iter_sse(cfg: Config, path: str, payload: dict, timeout: float | None = None):
    """逐条 yield SSE 的 data 负载（含 [START-SSE] 这类标记）。"""
    url = f"{cfg.base_url}{path}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=_headers(cfg, "text/event-stream"), method="POST")
    try:
        with opener(cfg).open(request, timeout=timeout or cfg.graph_timeout) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data:"):
                    yield line[5:].lstrip(" ")
                elif line.startswith(("event:", "id:", "retry:")):
                    continue
                else:
                    # 非 SSE 正文（多半是网关的 JSON 错误体）
                    yield line
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:800] if exc.fp else ""
        extra = "\n" + _auth_hint(cfg) if exc.code in (401, 403) else ""
        hint = _proxy_hint(cfg) if exc.code in (502, 503, 504) else ""
        raise PlatformError(f"HTTP {exc.code} {exc.reason} —— {url}\n{detail}{extra}{hint}")
    except urllib.error.URLError as exc:
        raise PlatformError(
            f"连不上平台 {url}：{exc.reason}。确认在内网/VPN 内，且 PLATFORM_BASE_URL 正确。{_proxy_hint(cfg)}"
        )


# ---------------------------------------------------------------- 问答对相似检索


def _norm_answer(text):
    return re.sub(r"\s+", "", text or "")


# 五个类别导进了同一个问答库，`qa_id` 分不出类别 —— 只能按答案正文判定。
# 聚合条目以【结论】开头，单案例以【井号】(钻井/试修完井) 或【队号】(HSE/井场建设) 开头。
CASE_MARKERS = ("【井号】", "【队号】")
AGGREGATE_MARKERS = ("【结论】",)
KIND_CN = {"aggregate": "聚合结论", "case": "单案例", "unknown": "未判定类型"}


def classify_answer(answer):
    head = (answer or "").lstrip()[:40]
    if any(m in head for m in CASE_MARKERS):
        return "case"
    if any(m in head for m in AGGREGATE_MARKERS):
        return "aggregate"
    return "unknown"


def answer_subject(answer):
    """单案例答案里的井号或队号，用于在多条命中里区分是哪一口井。"""
    # 井号里有空格（Koulele CE-19），分隔符是 U+3000 全角空格，不能按普通空格截断
    m = re.search(r"【(?:井号|队号)】\s*([^【\u3000\r\n]+)", answer or "")
    return m.group(1).strip() if m else ""


def is_aggregate(item):
    return item.get("kind") == "aggregate" or "综合结论" in (item.get("label") or "")


def describe(item):
    """一行来源标识：聚合结论 / 单案例 · Koulele CE-19（有类别标注时附在后面）。"""
    parts = [KIND_CN.get(item.get("kind"), "未判定类型")]
    if item.get("subject"):
        parts.append(item["subject"])
    text = " · ".join(parts)
    label = item.get("label")
    if label and label not in text:
        text += f"（{label}）"
    return text


def qa_search(cfg: Config, question: str, threshold: float | None = None, k: int | None = None) -> dict:
    """问答对相似检索。返回统一结构，state ∈ hit/answer_null/below_threshold/empty。"""
    cfg.require_qa()
    threshold = cfg.qa_threshold if threshold is None else float(threshold)
    k = cfg.qa_top_k if k is None else int(k)

    payload = {"input_question": question, "k": k}
    if cfg.qa_type_id:
        payload["type_id"] = cfg.qa_type_id
        scope = f"单库 type_id={cfg.qa_type_id}"
    else:
        payload["qa_id_list"] = list(cfg.qa_ids)
        scope = f"多库 {len(cfg.qa_ids)} 个问答库"

    data = post_json(cfg, QA_PATH, payload)
    status = str(data.get("status", ""))
    raw_items = data.get("answer_id") or []

    # 同一主问答会通过多个扩展问被召回多次 —— 按答案正文去重，保留最高相似度。
    merged = {}
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        answer = item.get("answer")
        try:
            similarity = float(item.get("similarity") or 0.0)
        except (TypeError, ValueError):
            similarity = 0.0
        qa_id = item.get("qa_id") or cfg.qa_type_id or ""
        key = _norm_answer(answer) or f"__null__{item.get('id')}"
        hit = merged.get(key)
        if hit is None:
            merged[key] = {
                "id": item.get("id"),
                "similarity": similarity,
                "answer": answer,
                "qa_id": qa_id,
                "label": cfg.label_for(qa_id),
                "kind": classify_answer(answer),
                "subject": answer_subject(answer),
                "recall_count": 1,
            }
        else:
            hit["recall_count"] += 1
            if similarity > hit["similarity"]:
                hit.update({"id": item.get("id"), "similarity": similarity, "qa_id": qa_id, "label": cfg.label_for(qa_id)})

    items = sorted(merged.values(), key=lambda x: x["similarity"], reverse=True)
    above = [it for it in items if it["similarity"] >= threshold]
    hits = [it for it in above if (it["answer"] or "").strip()]
    nulls = [it for it in above if not (it["answer"] or "").strip()]

    if hits:
        state = "hit"
    elif nulls:
        state = "answer_null"
    elif items:
        state = "below_threshold"
    else:
        state = "empty"

    promoted = False
    if state == "hit" and cfg.prefer_aggregate and len(hits) > 1 and not _mentions_well(question):
        primary = hits[0]
        if not is_aggregate(primary):
            for candidate in hits[1:]:
                if is_aggregate(candidate) and candidate["similarity"] >= primary["similarity"] - cfg.aggregate_margin:
                    hits.remove(candidate)
                    hits.insert(0, candidate)
                    promoted = True
                    break

    return {
        "stage": "qa",
        "state": state,
        "question": question,
        "scope": scope,
        "threshold": threshold,
        "k": k,
        "platform_status": status,
        "top_similarity": items[0]["similarity"] if items else None,
        "hits": hits,
        "nulls": nulls,
        "all": items,
        "raw_count": len(raw_items),
        "promoted_aggregate": promoted,
    }


_WELL_PATTERNS = (
    re.compile(r"[A-Za-z][A-Za-z]*(?:\s+[A-Za-z]+)*\s*-\s*\d+"),  # Sokor-1 / Koulele CE-19
    re.compile(r"GW\s*\d{2,3}", re.IGNORECASE),                    # 队号 GW216
)


def _mentions_well(question: str) -> bool:
    return any(p.search(question or "") for p in _WELL_PATTERNS)


# ------------------------------------------------------------------- 图谱检索


def strip_br(text: str) -> str:
    return re.sub(r"<br\s*/?>", "\n", text or "")


# 图谱是生成式的：答不上来时它不会返回空，而是**用一段通顺的中文说自己答不了**
# （实测「差旅报销流程是什么」→「根据提供的知识库内容，无法回答关于…的问题」，还附 29 个实体）。
# 知识库那一级靠服务端阈值过滤，落空就是 chunks=0；图谱没有 score，只能认措辞。
# 不识别的话 recommend.py 会判 use_graph_answer，把「我答不了」当答案讲给用户。
# 这五条是拿 tools/fallback-cases.txt 的 20 条题实测标定的（2026-09-10）：
# 7 条该判拒答的全中（含「描述较少」那种先示弱、后拿邻近话题硬凑的），
# 13 条正常答案零误判。改这里要重跑 tools/compare_fallback.py 复核。
_GRAPH_REFUSAL_PATTERNS = (
    # 「无法回答」「无法直接提供」「无法准确给出」
    re.compile(r"无法(直接|准确|明确)?(回答|提供|给出|得出)"),
    re.compile(r"不足以回答"),
    # 先说「描述较少」再长篇讲别的 —— 实测「项目部的组织架构」就是这样
    # 拿《钻井事故与复杂问题》里的「井喷抢险指挥部」凑了一篇，是最危险的一种假命中
    re.compile(r"(描述|记载|信息|内容)较少"),
    # 中间要能夹副词：实测同一个问题 4 次里 3 次说的是「并未**直接**提及」
    re.compile(r"(并未|未|没有)[^。，]{0,4}(包含|提及|涉及|收录|记录|说明|描述|给出)"),
    re.compile(r"(知识库|文档|资料|提供的(上下文|内容|信息))[^。]{0,12}(并未|未|没有)"),
)

# 只看开头这么多字：拒答一定写在第一句，正文里偶尔出现「未提及」不该被误判成拒答
_REFUSAL_SCAN_CHARS = 200


def is_graph_refusal(answer: str) -> bool:
    """图谱那段话是不是在说「我答不了」。"""
    head = (answer or "").strip()[:_REFUSAL_SCAN_CHARS]
    return any(p.search(head) for p in _GRAPH_REFUSAL_PATTERNS)


def graph_search(cfg: Config, query: str, mode: str | None = None, timeout: float | None = None) -> dict:
    """LightRAG 图谱检索，解析 SSE 事件流。"""
    cfg.require_graph()
    mode = mode or cfg.graph_mode
    payload = {"query": query, "query_mode": mode, "kb_id": cfg.graph_kb_id}

    section = None
    answer_parts, json_parts, stray = [], [], []
    done = False
    for chunk in iter_sse(cfg, GRAPH_PATH, payload, timeout=timeout):
        if chunk == "[DONE]":
            done = True
            break
        if chunk == "[START-SSE]":
            section = "sse"
        elif chunk == "[END-SSE]":
            section = None
        elif chunk == "[START-JSON]":
            section = "json"
        elif chunk == "[END-JSON]":
            section = None
        elif section == "sse":
            answer_parts.append(chunk)
        elif section == "json":
            json_parts.append(chunk)
        elif chunk:
            stray.append(chunk)

    graph, entities, relationships, text_units = None, [], [], []
    if json_parts:
        try:
            graph = json.loads("".join(json_parts))
        except json.JSONDecodeError:
            stray.append("图谱 JSON 解析失败（已忽略，答案仍可用）")
        if isinstance(graph, dict):
            payload_data = graph.get("data") if isinstance(graph.get("data"), dict) else graph
            entities = payload_data.get("entities") or []
            relationships = payload_data.get("relationships") or []
            text_units = payload_data.get("text_units") or []

    answer = strip_br("".join(answer_parts)).strip()
    if not answer and stray:
        joined = " ".join(stray)
        # 网关的错误体（610/611 鉴权之类）是普通 JSON、不是 SSE —— 过一遍信封检查，
        # 这样图谱这一级也能拿到和 JSON 接口一样的排查提示，而不是干巴巴一句「没返回答案」
        try:
            _check_envelope(cfg, json.loads(joined))
        except json.JSONDecodeError:
            pass
        raise PlatformError(f"图谱接口没有返回答案，响应正文：{joined[:600]}")

    refused = is_graph_refusal(answer)
    if refused:
        stray = stray + ["图谱明确表示答不了（按拒答措辞判为落空，不当作命中）"]

    return {
        "stage": "graph",
        "state": "hit" if (answer and not refused) else "empty",
        "refused": refused,
        "raw_state": "hit" if answer else "empty",
        "question": query,
        "kb_id": cfg.graph_kb_id,
        "query_mode": mode,
        "answer": answer,
        "entities": entities,
        "relationships": relationships,
        "text_units": text_units,
        "done": done,
        "notes": stray,
    }


# ------------------------------------------------------------------- 知识库检索


FALLBACK_CN = {"kb": "知识库", "graph": "图谱库", "none": "关闭（问答对未命中直接 no_answer）"}

# 说明：《钻井事故与复杂问题》里的「例X」现场实例章节留在知识库里，不做剔除、也不单独打标 ——
# 风险由「来源标注」兜住：答案必须说清是尼日尔历史记录还是《钻井事故与复杂问题》（SKILL.md「统一回答结构」）。


def kb_search(cfg: Config, query: str, threshold: float | None = None,
              k: int | None = None, expand_step: int | None = None) -> dict:
    """知识库向量检索。返回的是**《钻井事故与复杂问题》的原文片段，不是成稿答案** —— 归纳交给 agent。

    契约见仓库 `docs/检索接口.md` ③。两个要点：
    `threshold` 是**服务端**过滤（低于它的片段根本不返回），`expand_step` 只加长片段不改分值。
    """
    cfg.require_kb()
    threshold = cfg.kb_threshold if threshold is None else float(threshold)
    k = cfg.kb_top_k if k is None else int(k)
    expand_step = cfg.kb_expand_step if expand_step is None else int(expand_step)

    payload = {
        "query": query,
        "kb_name": list(cfg.kb_ids),
        "top_k": k,
        "threshold": threshold,
        "expand_step": expand_step,
    }
    data = post_json(cfg, KB_PATH, payload)
    raw = data.get("query_result") if isinstance(data, dict) else None
    if raw is None:
        raise PlatformError(
            f"知识库响应里没有 query_result 字段（前 300 字）：{str(data)[:300]}"
        )

    seen, chunks = set(), []
    for item in raw:
        if not isinstance(item, dict):
            continue
        content = (item.get("content") or "").strip()
        if not content:
            continue
        key = _norm_answer(content)
        if key in seen:          # 同一段可能被多次召回
            continue
        seen.add(key)
        try:
            score = float(item.get("score") or 0.0)
        except (TypeError, ValueError):
            score = 0.0
        chunks.append({
            "content": content,
            "score": score,
            "source": item.get("source") or "",
            "page_no": item.get("page_no") or "",
            "file_id": item.get("file_id") or "",
        })
    chunks.sort(key=lambda c: c["score"], reverse=True)

    sources = []
    for chunk in chunks:
        if chunk["source"] and chunk["source"] not in sources:
            sources.append(chunk["source"])

    return {
        "stage": "kb",
        "state": "hit" if chunks else "empty",
        "question": query,
        "kb_ids": list(cfg.kb_ids),
        "threshold": threshold,
        "k": k,
        "expand_step": expand_step,
        "chunks": chunks,
        "sources": sources,
        "top_score": chunks[0]["score"] if chunks else None,
        "raw_count": len(raw),
    }


# ----------------------------------------------------------------------- 其他


def guard_hits(cfg: Config, question: str):
    return [kw for kw in cfg.guard_keywords if kw and kw in (question or "")]


# 「是什么问题」这类不算——倒划眼憋停那条征兆描述就是以「是什么问题？」结尾的
_DEFINITION_PATTERNS = (
    re.compile(r"^\s*(什么是|什么叫|何谓|何为|啥是|啥叫)"),
    re.compile(r"(是什么意思|的定义是|的定义\s*[?？]?\s*$|怎么定义)"),
)


def is_definition(question: str) -> bool:
    """定义题 = 问术语含义，不是问怎么处置。"""
    return any(p.search(question or "") for p in _DEFINITION_PATTERNS)


def fmt_sim(value):
    return "—" if value is None else f"{value:.4f}"


def run_cli(main):
    """统一错误出口：2=配置错，3=平台/网络错。结论行同时落在首行与末行。"""
    use_utf8()
    try:
        sys.exit(main())
    except ConfigError as exc:
        print(f"[配置错误] {exc}", file=sys.stderr)
        print("[RESULT] error=config", file=sys.stderr)
        sys.exit(2)
    except PlatformError as exc:
        print(f"[平台错误] {exc}", file=sys.stderr)
        print("[RESULT] error=platform", file=sys.stderr)
        sys.exit(3)
    except KeyboardInterrupt:
        sys.exit(130)
