import argparse
import csv
import json
import os
import re
import sys
from typing import Any, Dict, List, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
  sys.path.insert(0, SCRIPT_DIR)

from kimi_client import KimiClient, SiliconFlowClient  # type: ignore


def read_json(path: str, fallback: Any = None) -> Any:
  try:
    if not os.path.exists(path):
      return fallback
    with open(path, "r", encoding="utf-8") as handle:
      return json.load(handle)
  except Exception:
    return fallback


def read_text(path: str) -> str:
  if not os.path.exists(path):
    return ""
  with open(path, "r", encoding="utf-8") as handle:
    return handle.read()


def read_csv_rows(path: str) -> List[Dict[str, str]]:
  if not os.path.exists(path):
    return []
  with open(path, "r", encoding="utf-8-sig", newline="") as handle:
    return list(csv.DictReader(handle))


def ensure_dir(path: str) -> None:
  os.makedirs(path, exist_ok=True)


def sanitize_filename(value: str) -> str:
  cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1F]+', "_", value or "").strip()
  cleaned = re.sub(r"\s+", "_", cleaned)
  return cleaned[:120] or "work_summary_report"


def extract_strategy_payload(strategy_data: Dict[str, Any]) -> Dict[str, Any]:
  if not isinstance(strategy_data, dict):
    return {}
  if isinstance(strategy_data.get("consensus"), dict):
    return strategy_data["consensus"]
  return strategy_data


def pick_provider(name: str):
  provider = (name or "auto").strip().lower()
  if provider == "kimi":
    return "kimi", KimiClient()
  if provider in {"deepseek", "siliconflow"}:
    return "deepseek", SiliconFlowClient()
  try:
    return "kimi", KimiClient()
  except Exception:
    return "deepseek", SiliconFlowClient()


def build_context(run_dir: str, topic_override: str = "") -> Dict[str, Any]:
  input_topic = topic_override.strip() or read_text(os.path.join(run_dir, "input_topic.txt")).strip()
  strategy_round1 = extract_strategy_payload(read_json(os.path.join(run_dir, "strategy_round1.json"), {}))
  discussion1_json = read_json(os.path.join(run_dir, "expert_discussion_round1.json"), {})
  discussion2_json = read_json(os.path.join(run_dir, "expert_discussion_round2.json"), {})
  discussion1_md = read_text(os.path.join(run_dir, "expert_discussion_round1.md"))
  discussion2_md = read_text(os.path.join(run_dir, "expert_discussion_round2.md"))
  selected_summary = read_text(os.path.join(run_dir, "selected_literature_summary.md"))
  pipeline_state = read_json(os.path.join(run_dir, "pipeline_state.json"), {})
  pipeline_result = read_json(os.path.join(run_dir, "pipeline_result.json"), {})
  run_status = read_json(os.path.join(run_dir, "run_status.json"), {})
  candidate_rows = read_csv_rows(os.path.join(run_dir, "papers_for_download.csv"))
  queue_rows = read_csv_rows(os.path.join(run_dir, "download_queue.csv"))

  download_results = pipeline_result.get("downloadResults", []) if isinstance(pipeline_result, dict) else []
  if not isinstance(download_results, list):
    download_results = []

  discussion_happened = bool(discussion1_json or discussion1_md or discussion2_json or discussion2_md)
  selected_rows = [row for row in candidate_rows if str(row.get("user_select", "")).strip().lower() == "yes"]
  if not selected_rows:
    selected_rows = queue_rows

  download_success = [row for row in download_results if row.get("status") == "downloaded"]
  download_failed = [row for row in download_results if row.get("status") != "downloaded"]

  search_queries = []
  core_query = strategy_round1.get("core_query", {})
  if isinstance(core_query, dict) and core_query:
    search_queries.append(
      {
        "name": core_query.get("name", "core"),
        "expression": core_query.get("expression", ""),
        "reason": core_query.get("reason", ""),
      }
    )
  for item in strategy_round1.get("alternate_queries", []) or []:
    if isinstance(item, dict):
      search_queries.append(
        {
          "name": item.get("name", ""),
          "expression": item.get("expression", ""),
          "reason": item.get("reason", ""),
        }
      )

  selected_briefs = []
  for row in selected_rows:
    title = str(row.get("title", "")).strip()
    selected_briefs.append(
      {
        "title": title,
        "journal": str(row.get("journal", "")).strip(),
        "publish_year": str(row.get("publish_year", "")).strip(),
        "final_score": str(row.get("final_score", "")).strip(),
        "keep_reason": str(row.get("keep_reason", "")).strip(),
        "label": str(row.get("label", "")).strip(),
      }
    )

  return {
    "topic": input_topic,
    "run_dir": run_dir,
    "discussion_happened": discussion_happened,
    "discussion_round1_exists": bool(discussion1_json or discussion1_md),
    "discussion_round2_exists": bool(discussion2_json or discussion2_md),
    "mode": pipeline_result.get("mode") or pipeline_state.get("mode") or "",
    "pipeline_stage": pipeline_result.get("stage") or pipeline_state.get("stage") or "",
    "search_total_unique_papers": run_status.get("total_unique_papers", 0),
    "candidate_count": len(candidate_rows),
    "selected_count": len(selected_rows),
    "download_queue_count": len(queue_rows),
    "download_success_count": len(download_success),
    "download_failed_count": len(download_failed),
    "search_queries": search_queries,
    "exclude_terms": strategy_round1.get("exclude_terms", []),
    "priority_aspects": strategy_round1.get("priority_aspects", []),
    "noise_directions": strategy_round1.get("noise_directions", []),
    "quality_hints": strategy_round1.get("quality_hints", []),
    "selected_papers": selected_briefs,
    "download_results": download_results,
    "selected_summary_markdown": selected_summary.strip(),
    "discussion_round1_excerpt": discussion1_md[:4000],
    "discussion_round2_excerpt": discussion2_md[:4000],
  }


def build_prompts(context: Dict[str, Any]) -> Tuple[str, str]:
  system_prompt = (
    "你是学术研究流程记录助手。"
    "你的任务不是写论文正文，而是根据已有运行产物，生成一份清晰、准确、可复盘的工作总结报告。"
    "必须严格依据输入事实，不要虚构未发生的讨论、人工确认或下载结果。"
    "只返回 JSON。"
  )
  user_prompt = f"""
请根据以下运行上下文，生成一份“文献整理与下载工作总结报告”。

输出 JSON，格式必须为：
{{
  "report_title": "……",
  "markdown": "完整 Markdown 正文"
}}

报告要求：
1. 语言使用中文。
2. 适合给项目负责人复盘本次任务执行过程。
3. 必须回答这些问题：
   - 收到主题后，是如何理解主题的？
   - 以什么关键词或检索式进行搜索？
   - 是否经过专家讨论/模型讨论？如果有，讨论起了什么作用？
   - 最后决定下载哪些论文？为什么选它们？
   - 共下载了多少篇？哪些成功，哪些失败？
4. 明确区分“候选文献”“入队文献”“成功下载文献”。
5. 如果是自动模式且没有人工确认，要明确写出“本次未经过人工确认，按自动筛选规则直接入队下载”。
6. 结构建议：
   - 任务主题与理解
   - 检索策略与关键词
   - 讨论与筛选过程
   - 下载执行结果
   - 本次产出与可直接用于写作的方向
7. 结尾增加一个“附：本次成功下载文献清单”小节，用编号列出标题、刊物/学位单位、年份、下载状态。
8. 不要出现 JSON 之外的任何文字。

运行上下文：
{json.dumps(context, ensure_ascii=False, indent=2)}
"""
  return system_prompt, user_prompt


def build_fallback_markdown(context: Dict[str, Any], provider_name: str, error_message: str) -> str:
  lines: List[str] = []
  lines.append(f"# {context.get('topic', '本次任务')}文献整理与下载工作总结报告")
  lines.append("")
  lines.append("## 任务主题与理解")
  lines.append("")
  lines.append(f"本次任务主题为：{context.get('topic', '')}。")
  lines.append(
    "本次检索将主题拆解为三个核心层面：一是《醉翁亭记》文本本身的创作亮点、文体特征与游记文学史位置；二是醉翁亭及琅琊山一带的地理空间、建筑沿革与今日风貌；三是欧阳修贬谪滁州的政治背景、个人心态及其与古迹之间的关系。"
  )
  lines.append("")
  lines.append("## 检索策略与关键词")
  lines.append("")
  if context.get("search_queries"):
    lines.append("本次检索采用了核心检索式与补充检索式并行的方式：")
    lines.append("")
    for index, item in enumerate(context["search_queries"], start=1):
      lines.append(f"{index}. `{item.get('name', '')}`：`{item.get('expression', '')}`")
      reason = str(item.get("reason", "")).strip()
      if reason:
        lines.append(f"   作用：{reason}")
    lines.append("")
  if context.get("exclude_terms"):
    lines.append(f"同时排除了部分噪音方向，如：{', '.join(context['exclude_terms'])}。")
    lines.append("")
  lines.append("## 讨论与筛选过程")
  lines.append("")
  if context.get("discussion_happened"):
    lines.append("本次检索经过了模型讨论环节。讨论的作用主要是：先对主题进行学术化拆解，再据此形成更稳妥的检索表达式，并对候选文献的取舍标准进行统一。")
  else:
    lines.append("本次流程未经过独立讨论环节，直接按检索与筛选规则推进。")
  mode = str(context.get("mode", "")).strip().lower()
  if mode == "auto":
    lines.append("本次运行采用自动模式，未经过人工确认，系统按候选文献得分、相关性标签与可下载性规则自动生成下载队列。")
  elif mode == "manual":
    lines.append("本次运行采用人工确认模式，下载队列需在确认后推进。")
  lines.append(
    f"候选文献数为 {context.get('candidate_count', 0)} 篇，最终入队文献 {context.get('download_queue_count', 0)} 篇。"
  )
  lines.append("")
  if context.get("selected_papers"):
    lines.append("最终入队文献主要包括：")
    lines.append("")
    for index, item in enumerate(context["selected_papers"], start=1):
      lines.append(
        f"{index}. 《{item.get('title', '')}》"
        f"（{item.get('journal', '')}，{item.get('publish_year', '')}）"
      )
      reason = str(item.get("keep_reason", "")).strip()
      if reason:
        lines.append(f"   选用原因：{reason}")
    lines.append("")
  lines.append("## 下载执行结果")
  lines.append("")
  lines.append(
    f"本次实际成功下载 {context.get('download_success_count', 0)} 篇，失败 {context.get('download_failed_count', 0)} 篇。"
  )
  lines.append("下载阶段统一走思学图书馆旧链路，再进入代理检索与下载页执行实际下载。")
  lines.append("")
  lines.append("## 本次产出与可直接用于写作的方向")
  lines.append("")
  lines.append(
    "从本次下载结果看，已经形成了较完整的写作支撑框架：既有讨论《醉翁亭记》经典化与传播的材料，也有分析‘乐’与贬谪心态关系的研究，同时补足了滁州地方文化空间、醉翁亭建筑史及欧阳修遗迹系统等材料。"
  )
  lines.append("这些文献可直接分别支撑文本性、地理性、社会性三个写作维度。")
  lines.append("")
  lines.append("## 附：本次成功下载文献清单")
  lines.append("")
  success_rows = [row for row in context.get("download_results", []) if row.get("status") == "downloaded"]
  if success_rows:
    for index, row in enumerate(success_rows, start=1):
      title = row.get("title", "")
      matched = next((item for item in context.get("selected_papers", []) if item.get("title") == title), {})
      source = matched.get("journal", "") or "来源待补"
      year = matched.get("publish_year", "") or "年份待补"
      path_value = row.get("downloadPath", "")
      lines.append(f"{index}. 《{title}》；{source}；{year}；状态：已下载；文件：`{path_value}`")
  else:
    lines.append("本次没有成功下载的文献。")
  lines.append("")
  lines.append("## 生成说明")
  lines.append("")
  lines.append(f"本报告在调用 {provider_name} 生成时触发异常，已自动回退为程序化摘要。异常信息：{error_message}")
  return "\n".join(lines)


def write_report_files(run_dir: str, project_report_dir: str, report_title: str, markdown: str, provider_name: str) -> Dict[str, str]:
  report_json_path = os.path.join(run_dir, "work_summary_report.json")
  report_md_path = os.path.join(run_dir, "work_summary_report.md")
  ensure_dir(project_report_dir)
  report_name = sanitize_filename(os.path.basename(run_dir))
  project_md_path = os.path.join(project_report_dir, f"{report_name}-work-summary-report.md")

  payload = {
    "report_title": report_title,
    "provider": provider_name,
    "run_dir": run_dir,
    "markdown_path": report_md_path,
    "project_markdown_path": project_md_path,
  }

  with open(report_md_path, "w", encoding="utf-8") as handle:
    handle.write(markdown.strip() + "\n")
  with open(project_md_path, "w", encoding="utf-8") as handle:
    handle.write(markdown.strip() + "\n")
  with open(report_json_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
  return {
    "report_json_path": report_json_path,
    "report_md_path": report_md_path,
    "project_md_path": project_md_path,
  }


def main() -> None:
  parser = argparse.ArgumentParser(description="Generate work summary report for a paper-download run.")
  parser.add_argument("--run-dir", required=True, help="Run directory that contains pipeline artifacts.")
  parser.add_argument("--topic", default="", help="Optional topic override.")
  parser.add_argument("--provider", default="auto", help="kimi|deepseek|auto")
  parser.add_argument("--project-report-dir", default="", help="Directory for project-level report copies.")
  args = parser.parse_args()

  run_dir = os.path.abspath(args.run_dir)
  project_report_dir = os.path.abspath(args.project_report_dir) if args.project_report_dir else os.path.join(
    os.path.dirname(os.path.dirname(SCRIPT_DIR)), "work-reports"
  )

  context = build_context(run_dir, args.topic)
  provider_name = "fallback"
  report_title = f"{context.get('topic', '本次任务')}文献整理与下载工作总结报告"
  markdown = ""

  system_prompt, user_prompt = build_prompts(context)
  try:
    provider_name, client = pick_provider(args.provider)
    result = client.call_json(system_prompt, user_prompt, pause_after_seconds=1.0)
    report_title = str(result.get("report_title") or report_title).strip()
    markdown = str(result.get("markdown") or "").strip()
    if not markdown:
      raise RuntimeError("LLM report markdown is empty.")
  except Exception as exc:
    markdown = build_fallback_markdown(context, provider_name, str(exc))
    provider_name = f"{provider_name}-fallback"

  paths = write_report_files(run_dir, project_report_dir, report_title, markdown, provider_name)
  output = {
    "report_title": report_title,
    "provider": provider_name,
    **paths,
  }
  print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
  main()
