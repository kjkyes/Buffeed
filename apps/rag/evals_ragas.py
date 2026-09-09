"""Run offline Ragas evaluations against the Buffeed RAG REST facade."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import httpx


DEFAULT_METRICS = (
    "context_precision",
    "context_recall",
    "faithfulness",
    "answer_relevancy",
)


class EvaluationRequestError(Exception):
    """保留请求失败前已构建的评估输入。"""

    def __init__(self, message: str, rows: list[dict[str, Any]]) -> None:
        super().__init__(message)
        self.rows = rows


def _non_empty_text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _extract_contexts(payload: dict[str, Any]) -> list[str]:
    contexts: list[str] = []
    evidence = payload.get("evidence")
    if isinstance(evidence, list):
        for item in evidence:
            if not isinstance(item, dict):
                continue
            for key in ("matched_chunk", "content", "parent_content"):
                text = _non_empty_text(item.get(key))
                if text:
                    contexts.append(text)
                    break

    if contexts:
        return contexts

    data = payload.get("data")
    chunks = data.get("chunks") if isinstance(data, dict) else None
    if not isinstance(chunks, list):
        return []
    for chunk in chunks:
        if isinstance(chunk, str) and chunk.strip():
            contexts.append(chunk.strip())
        elif isinstance(chunk, dict):
            for key in ("content", "text", "matched_chunk"):
                text = _non_empty_text(chunk.get(key))
                if text:
                    contexts.append(text)
                    break
    return contexts


def _extract_answer(payload: dict[str, Any]) -> str:
    for key in ("answer", "response", "content"):
        text = _non_empty_text(payload.get(key))
        if text:
            return text
    data = payload.get("data")
    if isinstance(data, str):
        return data.strip()
    if isinstance(data, dict):
        for key in ("answer", "response", "content"):
            text = _non_empty_text(data.get(key))
            if text:
                return text
    return ""


def _load_cases(path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        try:
            case = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_number} 不是有效 JSON: {exc}") from exc
        if not isinstance(case, dict):
            raise ValueError(f"{path}:{line_number} 必须是 JSON 对象")
        if not _non_empty_text(case.get("user_input")):
            raise ValueError(f"{path}:{line_number} 缺少 user_input")
        if not _non_empty_text(case.get("reference")):
            raise ValueError(f"{path}:{line_number} 缺少 reference")
        cases.append(case)
    if not cases:
        raise ValueError(f"{path} 没有可评估的样例")
    return cases


def _call_rag(client: httpx.Client, path: str, query: str, args: argparse.Namespace) -> dict[str, Any]:
    response = client.post(
        path,
        json={
            "query": query,
            "mode": args.mode,
            "top_k": args.top_k,
            "chunk_top_k": args.chunk_top_k,
            "max_total_tokens": args.max_total_tokens,
            "enable_rerank": not args.no_rerank,
        },
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError(f"{path} 返回的不是 JSON 对象")
    return payload


def _build_rows_legacy(cases: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with httpx.Client(
        base_url=args.base_url.rstrip("/"),
        timeout=args.timeout,
        headers={"Accept": "application/json"},
    ) as client:
        for index, case in enumerate(cases, 1):
            query = str(case["user_input"]).strip()
            retrieval = _call_rag(client, "/api/v1/rag/retrievals", query, args)
            answer = _call_rag(client, "/api/v1/rag/answers", query, args)
            contexts = _extract_contexts(retrieval)
            response = _extract_answer(answer)
            if not response:
                raise ValueError(f"第 {index} 条样例没有从 answer 响应提取到回答")
            row = {
                "user_input": query,
                "retrieved_contexts": contexts,
                "response": response,
                "reference": str(case["reference"]).strip(),
            }
            if isinstance(case.get("reference_contexts"), list):
                row["reference_contexts"] = case["reference_contexts"]
            if "metadata" in case:
                row["metadata"] = case["metadata"]
            rows.append(row)
            print(f"已完成 {index}/{len(cases)} 条", file=sys.stderr)
    return rows


def _build_rows(cases: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cache_path = getattr(args, "cache", None)
    cached_rows: list[dict[str, Any]] = []
    if cache_path is not None and cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if isinstance(cached, list):
                cached_rows = [item for item in cached if isinstance(item, dict)]
        except (OSError, json.JSONDecodeError):
            print(f"缓存文件无法读取，将重新请求: {cache_path}", file=sys.stderr)
    with httpx.Client(
        base_url=args.base_url.rstrip("/"),
        timeout=args.timeout,
        headers={"Accept": "application/json"},
    ) as client:
        for index, case in enumerate(cases, 1):
            try:
                query = str(case["user_input"]).strip()
                reference = str(case["reference"]).strip()
                if index <= len(cached_rows):
                    cached_row = cached_rows[index - 1]
                    if (
                        cached_row.get("user_input") == query
                        and isinstance(cached_row.get("retrieved_contexts"), list)
                        and isinstance(cached_row.get("response"), str)
                    ):
                        cached_row = dict(cached_row)
                        cached_row["reference"] = reference
                        if isinstance(case.get("reference_contexts"), list):
                            cached_row["reference_contexts"] = case["reference_contexts"]
                        else:
                            cached_row.pop("reference_contexts", None)
                        if "metadata" in case:
                            cached_row["metadata"] = case["metadata"]
                        else:
                            cached_row.pop("metadata", None)
                        rows.append(cached_row)
                        print(f"已从缓存恢复 {index}/{len(cases)} 条", file=sys.stderr)
                        continue
                retrieval = _call_rag(client, "/api/v1/rag/retrievals", query, args)
                answer = _call_rag(client, "/api/v1/rag/answers", query, args)
                response = _extract_answer(answer)
                if not response:
                    raise ValueError(f"第 {index} 条样例没有提取到回答")
                row = {
                    "user_input": query,
                    "retrieved_contexts": _extract_contexts(retrieval),
                    "response": response,
                    "reference": reference,
                }
                if isinstance(case.get("reference_contexts"), list):
                    row["reference_contexts"] = case["reference_contexts"]
                if "metadata" in case:
                    row["metadata"] = case["metadata"]
                rows.append(row)
                print(f"已完成 {index}/{len(cases)} 条", file=sys.stderr)
                if cache_path is not None:
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    cache_path.write_text(
                        json.dumps(rows, ensure_ascii=False, indent=2, default=str) + "\n",
                        encoding="utf-8",
                    )
            except (httpx.HTTPError, ValueError) as exc:
                raise EvaluationRequestError(
                    f"第 {index} 条样例请求失败: {exc}", rows
                ) from exc
    return rows


def _evaluation_clients(args: argparse.Namespace) -> tuple[Any, Any]:
    try:
        from langchain_openai import ChatOpenAI
        from langchain_community.embeddings import DashScopeEmbeddings
        from ragas.embeddings import LangchainEmbeddingsWrapper
        from ragas.llms.base import LangchainLLMWrapper
        from ragas.run_config import RunConfig
    except ImportError as exc:
        raise RuntimeError(
            "缺少 Ragas 评估依赖，请在当前虚拟环境执行："
            "uv pip install ragas datasets openai"
        ) from exc

    class DashScopeChatOpenAI(ChatOpenAI):
        def _get_request_payload(self, input_: Any, *, stop: list[str] | None = None, **kwargs: Any) -> dict[str, Any]:
            payload = super()._get_request_payload(input_, stop=stop, **kwargs)
            for message in payload.get("messages", []):
                content = message.get("content")
                if not isinstance(content, list):
                    continue
                normalized: list[str] = []
                for part in content:
                    if isinstance(part, str):
                        normalized.append(part)
                    elif isinstance(part, dict):
                        text = part.get("text")
                        if isinstance(text, str):
                            normalized.append(text)
                message["content"] = normalized
            return payload

    class DashScopeRagasLLM(LangchainLLMWrapper):
        """Normalize valid JSON before Ragas parses the model response."""

        @staticmethod
        def _first_input_statement(prompt_text: str) -> str:
            matches = list(re.finditer(
                r'"statements"\s*:\s*\[\s*"((?:\\.|[^"\\])*)"',
                prompt_text,
            ))
            match = matches[-1] if matches else None
            if match is not None:
                try:
                    return json.loads('"' + match.group(1) + '"')
                except json.JSONDecodeError:
                    return match.group(1)
            answers = list(re.finditer(r'"answer"\s*:\s*"((?:\\.|[^"\\])*)"', prompt_text))
            if answers:
                try:
                    return json.loads('"' + answers[-1].group(1) + '"')
                except json.JSONDecodeError:
                    return answers[-1].group(1)
            return ""

        @classmethod
        def _repair_shape(cls, value: Any, raw: str, prompt_text: str) -> Any:
            if not isinstance(value, dict):
                return value

            # Some models return one verdict object even when the schema requires
            # a collection. Wrap that object using the statement from the prompt.
            if "NLIStatementOutput" in prompt_text or "StatementFaithfulnessAnswer" in prompt_text:
                if "verdict" in value and "reason" in value and "statements" not in value:
                    return {
                        "statements": [{
                            "statement": str(value.get("statement") or cls._first_input_statement(prompt_text)),
                            "reason": str(value.get("reason", raw)),
                            "verdict": int(value.get("verdict", 0)),
                        }]
                    }
                if isinstance(value.get("statements"), str):
                    value["statements"] = [value["statements"]]
            elif "ContextRecallClassifications" in prompt_text:
                if ("attributed" in value and "reason" in value
                        and "classifications" not in value):
                    return {
                        "classifications": [{
                            "statement": str(value.get("statement") or cls._first_input_statement(prompt_text)),
                            "reason": str(value.get("reason", raw)),
                            "attributed": int(value.get("attributed", 0)),
                        }]
                    }
                if isinstance(value.get("classifications"), dict):
                    value["classifications"] = [value["classifications"]]
            return value

        @classmethod
        def _parse_response(cls, raw: str, prompt_text: str) -> str | None:
            decoder = json.JSONDecoder()
            for offset, char in enumerate(raw):
                if char not in "[{":
                    continue
                try:
                    parsed, _ = decoder.raw_decode(raw[offset:])
                except json.JSONDecodeError:
                    continue
                parsed = cls._repair_shape(parsed, raw, prompt_text)
                return json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))

            # Recover the common malformed-but-unambiguous verdict shape. The
            # extracted text is re-encoded by json.dumps, so quotes/newlines are safe.
            verdict_match = re.search(r'"(verdict|attributed)"\s*:\s*(-?\d+)', raw)
            reason_match = re.search(
                r'"reason"\s*:\s*"(.*?)(?="\s*,\s*"(?:verdict|attributed)"\s*:)',
                raw,
                flags=re.DOTALL,
            )
            if not verdict_match:
                return None
            reason = reason_match.group(1) if reason_match else raw
            key = verdict_match.group(1)
            value = {"reason": reason, key: int(verdict_match.group(2))}
            value = cls._repair_shape(value, raw, prompt_text)
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

        @classmethod
        def _normalize_result(cls, result: Any, prompt: Any) -> Any:
            prompt_text = prompt.to_string() if hasattr(prompt, "to_string") else str(prompt)
            for generations in getattr(result, "generations", []) or []:
                for generation in generations or []:
                    raw = getattr(generation, "text", None)
                    if not isinstance(raw, str):
                        continue
                    normalized = cls._parse_response(raw, prompt_text)
                    if normalized is not None:
                        generation.text = normalized
            return result

        def generate_text(self, *args: Any, **kwargs: Any) -> Any:
            prompt = kwargs.get("prompt") or (args[0] if args else "")
            return self._normalize_result(super().generate_text(*args, **kwargs), prompt)

        async def agenerate_text(self, *args: Any, **kwargs: Any) -> Any:
            result = await super().agenerate_text(*args, **kwargs)
            prompt = kwargs.get("prompt") or (args[0] if args else "")
            return self._normalize_result(result, prompt)

    api_key = (
        args.eval_api_key
        or os.getenv("OPENAI_API_KEY")
        or os.getenv("LLM_BINDING_API_KEY")
    )
    if not api_key:
        raise RuntimeError(
            "未配置评估模型 API Key，请设置 OPENAI_API_KEY，或使用 --eval-api-key"
        )
    base_url = (
        args.eval_base_url
        or os.getenv("OPENAI_BASE_URL")
        or os.getenv("LLM_BINDING_HOST")
    )
    if not base_url:
        raise RuntimeError(
            "未配置评估模型 API 地址，请设置 OPENAI_BASE_URL 或 --eval-base-url"
        )

    llm = DashScopeRagasLLM(
        DashScopeChatOpenAI(
            model=args.eval_model,
            api_key=api_key,
            base_url=base_url.rstrip("/"),
            temperature=0,
            max_tokens=args.eval_max_tokens,
            max_retries=args.eval_llm_retries,
            extra_body={"enable_thinking": False},
        ),
        bypass_n=True,
    )
    embeddings = LangchainEmbeddingsWrapper(
        DashScopeEmbeddings(
            model=args.eval_embedding_model,
            dashscope_api_key=api_key,
        )
    )
    return llm, embeddings


def _evaluate(rows: list[dict[str, Any]], metric_names: list[str], args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        from datasets import Dataset
        from ragas import evaluate
        from ragas import metrics as ragas_metrics
        from ragas.run_config import RunConfig
    except ImportError as exc:
        raise RuntimeError(
            "缺少 Ragas 评估依赖，请在独立评估环境安装：uv pip install ragas datasets"
        ) from exc

    missing = [name for name in metric_names if not hasattr(ragas_metrics, name)]
    if missing:
        raise RuntimeError(f"当前 Ragas 版本不支持指标: {', '.join(missing)}")
    metrics = [getattr(ragas_metrics, name) for name in metric_names]
    for metric in metrics:
        if hasattr(metric, "max_retries"):
            metric.max_retries = args.eval_metric_retries
    llm, embeddings = _evaluation_clients(args)
    result = evaluate(
        Dataset.from_list(rows),
        metrics=metrics,
        llm=llm,
        embeddings=embeddings,
        run_config=RunConfig(
            timeout=args.eval_timeout,
            max_retries=args.eval_max_retries,
            max_workers=args.eval_max_workers,
        ),
    )
    if hasattr(result, "to_pandas"):
        detail = result.to_pandas().to_dict(orient="records")
        summary = {name: value for name, value in result.to_pandas().mean(numeric_only=True).items()}
    else:
        detail = []
        summary = dict(result)
    return summary, detail


def _parse_thresholds(values: list[str]) -> dict[str, float]:
    thresholds: dict[str, float] = {}
    for value in values:
        name, separator, minimum = value.partition("=")
        if not separator:
            raise ValueError(f"阈值应使用 metric=value 格式: {value}")
        thresholds[name] = float(minimum)
    return thresholds


def _write_template(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    template = {
        "user_input": "如何配置本地知识库？",
        "reference": "填写人工审核后的标准答案。",
        "reference_contexts": ["填写答案对应的文档原文段落。"],
        "metadata": {"document_id": "setup.md", "expected_sources": ["setup.md"]},
    }
    path.write_text(json.dumps(template, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="评估 Buffeed RAG 服务")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--output", type=Path, default=Path("reports/ragas.json"))
    parser.add_argument("--init", type=Path, metavar="PATH", help="生成一条 JSONL 样例模板")
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument(
        "--cache",
        type=Path,
        help="逐条缓存 RAG 结果；默认使用 <output>.inputs.json",
    )
    parser.add_argument("--mode", default="mix", choices=("local", "global", "hybrid", "naive", "mix"))
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--chunk-top-k", type=int, default=10)
    parser.add_argument("--max-total-tokens", type=int, default=8000)
    parser.add_argument(
        "--eval-model",
        default=os.getenv("RAG_EVAL_LLM_MODEL", "qwen3.8-flash"),
        help="Ragas 评估用聊天模型，默认读取 RAG_EVAL_LLM_MODEL",
    )
    parser.add_argument(
        "--eval-embedding-model",
        default=os.getenv("RAG_EVAL_EMBEDDING_MODEL", "text-embedding-v4"),
        help="Ragas 评估用嵌入模型，默认读取 RAG_EVAL_EMBEDDING_MODEL",
    )
    parser.add_argument(
        "--eval-base-url",
        default=None,
        help="评估模型 OpenAI 兼容地址，默认读取 OPENAI_BASE_URL 或 LLM_BINDING_HOST",
    )
    parser.add_argument(
        "--eval-api-key",
        default=None,
        help="评估模型 API Key；更推荐通过 OPENAI_API_KEY 环境变量传入",
    )
    parser.add_argument(
        "--eval-timeout",
        type=int,
        default=int(os.getenv("RAG_EVAL_TIMEOUT", "600")),
        help="单个 Ragas 评估任务超时时间（秒）",
    )
    parser.add_argument(
        "--eval-max-retries",
        type=int,
        default=int(os.getenv("RAG_EVAL_MAX_RETRIES", "3")),
        help="Ragas 评估任务最大重试次数",
    )
    parser.add_argument(
        "--eval-max-workers",
        type=int,
        default=int(os.getenv("RAG_EVAL_MAX_WORKERS", "4")),
        help="Ragas 评估并发数，DashScope 建议从 4 开始",
    )
    parser.add_argument(
        "--eval-llm-retries",
        type=int,
        default=int(os.getenv("RAG_EVAL_LLM_RETRIES", "2")),
        help="单次评估模型 HTTP 调用的重试次数",
    )
    parser.add_argument(
        "--eval-metric-retries",
        type=int,
        default=int(os.getenv("RAG_EVAL_METRIC_RETRIES", "3")),
        help="单个指标 JSON 输出解析失败后的重试次数",
    )
    parser.add_argument(
        "--eval-max-tokens",
        type=int,
        default=int(os.getenv("RAG_EVAL_MAX_TOKENS", "8192")),
        help="评估模型单次响应的最大 token 数",
    )
    parser.add_argument("--no-rerank", action="store_true")
    parser.add_argument("--metric", action="append", dest="metrics", default=[])
    parser.add_argument("--min-score", action="append", default=[], metavar="METRIC=VALUE")
    args = parser.parse_args()

    if args.init:
        _write_template(args.init)
        print(f"已生成样例模板: {args.init}")
        if not args.dataset:
            return 0
    if not args.dataset:
        parser.error("必须提供 --dataset，或单独使用 --init")

    if args.cache is None:
        args.cache = Path(str(args.output) + ".inputs.json")

    rows: list[dict[str, Any]] = []
    metric_names = args.metrics or list(DEFAULT_METRICS)

    try:
        cases = _load_cases(args.dataset)
        _evaluation_clients(args)
        rows = _build_rows(cases, args)
        summary, detail = _evaluate(rows, metric_names, args)
        thresholds = _parse_thresholds(args.min_score)
        report = {"summary": summary, "metrics": metric_names, "cases": detail, "inputs": rows}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        failed = [name for name, minimum in thresholds.items() if float(summary.get(name, -1)) < minimum]
        if failed:
            print(f"未达到阈值: {', '.join(failed)}", file=sys.stderr)
            return 1
        return 0
    except EvaluationRequestError as exc:
        partial_report = {
            "partial": True,
            "completed_cases": len(exc.rows),
            "total_cases": len(cases) if "cases" in locals() else None,
            "error": str(exc),
            "summary": {},
            "metrics": metric_names,
            "cases": [],
            "inputs": exc.rows,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(partial_report, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )
        print(f"已写入部分评估结果: {args.output}", file=sys.stderr)
        print(f"已完成 {len(exc.rows)} 条，失败原因: {exc}", file=sys.stderr)
        return 2
    except (OSError, ValueError, RuntimeError, httpx.HTTPError) as exc:
        if rows:
            partial_report = {
                "partial": True,
                "completed_cases": len(rows),
                "total_cases": len(cases) if "cases" in locals() else None,
                "error": str(exc),
                "summary": {},
                "metrics": metric_names,
                "cases": [],
                "inputs": rows,
            }
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(partial_report, ensure_ascii=False, indent=2, default=str) + "\n",
                encoding="utf-8",
            )
            print(f"已写入部分评估结果: {args.output}", file=sys.stderr)
        print(f"评估失败: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
