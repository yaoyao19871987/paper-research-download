import argparse
import csv
import json
import os
import re
import traceback
from datetime import datetime
from typing import Dict, List, Tuple

from selenium.common.exceptions import TimeoutException, WebDriverException, StaleElementReferenceException

from cnki_common import (
  build_driver,
  detect_waiting_state,
  dump_debug_html,
  extract_result_cards,
  fetch_detail_metadata,
  navigate_to_search,
  next_page,
  save_snapshot_json,
  set_page_size,
  set_precision_toggles,
  set_result_sort,
  submit_search,
  switch_to_detail_view,
  fill_professional_query,
)
from journal_tiers import JournalTierIndex
from kimi_client import (
  ExpertDiscussionEngine,
  KimiClient,
  build_batch_map_prompts,
)
from scoring import apply_scores

MASTER_FIELDS = [
  "paper_id",
  "topic",
  "round",
  "query",
  "query_type",
  "field_mode",
  "title",
  "authors",
  "journal",
  "journal_tier",
  "tier_source",
  "publish_year",
  "cited_count",
  "download_count",
  "institution",
  "abstract",
  "page_url",
  "db_code",
  "file_name",
  "detected_rounds",
  "detected_views",
  "detected_queries",
  "first_seen_order",
  "best_rank_snapshot",
  "relevance_score",
  "quality_score",
  "impact_score",
  "freshness_score",
  "final_score",
  "label",
  "keep_reason",
  "is_worth_keeping",
  "research_object",
  "research_perspective",
  "core_claim",
  "material_type",
]

CANDIDATE_FIELDS = [
  "paper_id",
  "title",
  "authors",
  "journal",
  "publish_year",
  "cited_count",
  "download_count",
  "final_score",
  "label",
  "keep_reason",
  "abstract",
  "page_url",
  "db_code",
  "file_name",
  "user_select",
]


def ensure_dir(path: str) -> None:
  os.makedirs(path, exist_ok=True)


def slugify_topic(topic: str) -> str:
  topic = re.sub(r"[<>:\"/\\\\|?*]", "_", topic.strip())
  topic = re.sub(r"\s+", "_", topic)
  return topic[:80] or "topic"


def _safe_int(value: str) -> int:
  """Safely parse an integer from a string that may contain commas, spaces, or non-numeric text."""
  if not value:
    return 0
  digits = re.findall(r"\d+", str(value).replace(",", ""))
  return int(digits[0]) if digits else 0


def unique_join(existing: str, new_value: str) -> str:
  values = []
  for item in (existing or "").split("|"):
    item = item.strip()
    if item:
      values.append(item)
  if new_value and new_value not in values:
    values.append(new_value)
  return "|".join(values)


def load_snapshot_json(path: str) -> Dict[str, object]:
  with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)
  if not isinstance(data, dict):
    raise RuntimeError(f"Expected JSON object in {path}")
  return data


class ResearchPipeline:
  def __init__(
    self,
    topic: str,
    resume_dir: str | None = None,
    approve_strategy: bool = False,
    approve_selection: bool = False,
  ) -> None:
    self.topic = topic
    self.base_dir = os.path.dirname(os.path.abspath(__file__))
    self.output_root = os.path.abspath(os.getenv("CNKI_OUTPUT_ROOT", os.path.join(self.base_dir, "outputs")))
    ensure_dir(self.output_root)

    if resume_dir:
      self.run_dir = resume_dir
      ensure_dir(self.run_dir)
    else:
      stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
      self.run_dir = os.path.join(self.output_root, f"{slugify_topic(topic)}-{stamp}")
      ensure_dir(self.run_dir)

    self.master_raw_path = os.path.join(self.run_dir, "papers_master_raw.csv")
    self.master_path = os.path.join(self.run_dir, "papers_master.csv")
    self.selected_path = os.path.join(self.run_dir, "papers_selected.csv")
    self.download_candidates_path = os.path.join(self.run_dir, "papers_for_download.csv")
    self.discussion1_md_path = os.path.join(self.run_dir, "expert_discussion_round1.md")
    self.discussion2_md_path = os.path.join(self.run_dir, "expert_discussion_round2.md")
    self.candidate_review_md_path = os.path.join(self.run_dir, "candidate_review.md")
    self.map_batches_path = os.path.join(self.run_dir, "kimi_map_batches.jsonl")
    self.strategy1_path = os.path.join(self.run_dir, "strategy_round1.json")
    self.strategy2_path = os.path.join(self.run_dir, "strategy_round2.json")
    self.discussion1_path = os.path.join(self.run_dir, "expert_discussion_round1.json")
    self.discussion2_path = os.path.join(self.run_dir, "expert_discussion_round2.json")
    self.summary_path = os.path.join(self.run_dir, "analysis_summary.md")
    self.status_path = os.path.join(self.run_dir, "run_status.json")
    self.debug_html_path = os.path.join(self.run_dir, "last_debug_page.html")

    self.max_pages_per_view = self._env_int("CNKI_MAX_PAGES_PER_VIEW", 2)
    self.batch_size = self._env_int("CNKI_MAP_BATCH_SIZE", 12)
    self.download_candidate_count = self._env_int("CNKI_DOWNLOAD_CANDIDATES", 15)
    self.early_stop_enabled = self._env_flag("CNKI_EARLY_STOP_ENABLED", True)
    self.early_stop_min_selected = self._env_int(
      "CNKI_EARLY_STOP_MIN_SELECTED",
      max(self.download_candidate_count * 3, 30),
    )
    self.skip_round2_crawl_when_enough = self._env_flag("CNKI_SKIP_ROUND2_CRAWL_WHEN_ENOUGH", True)
    self.sort_views = ["default", "cited", "download"]
    self.approve_strategy = approve_strategy
    self.approve_selection = approve_selection
    self.records: Dict[str, Dict[str, str]] = {}
    self.map_batches: List[Dict[str, object]] = []
    self.unmapped_ids: List[str] = []
    self.global_seen_counter = 0
    self.tier_index = JournalTierIndex(self.base_dir)
    self.kimi = KimiClient()
    self.experts = ExpertDiscussionEngine()
    self.crawl_checkpoint_path = os.path.join(self.run_dir, "crawl_checkpoint.json")
    self._completed_crawls: set[str] = set()
    self._detail_cache: Dict[str, Dict[str, str]] = {}

    self._load_resume_state()
    self._write_status("initialized")

  def _env_int(self, name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
      return default
    try:
      return int(value)
    except ValueError:
      return default

  def _env_flag(self, name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
      return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}

  def _load_resume_state(self) -> None:
    if os.path.exists(self.master_raw_path):
      with open(self.master_raw_path, "r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
          if not row.get("paper_id"):
            continue
          self.records[row["paper_id"]] = row
      self.global_seen_counter = len(self.records)

    if os.path.exists(self.map_batches_path):
      with open(self.map_batches_path, "r", encoding="utf-8") as handle:
        for line in handle:
          line = line.strip()
          if line:
            self.map_batches.append(json.loads(line))

    mapped_ids: set[str] = set()
    for batch in self.map_batches:
      mapped = batch.get("mapped", [])
      if not isinstance(mapped, list):
        continue
      for item in mapped:
        if isinstance(item, dict):
          paper_id = str(item.get("paper_id", "")).strip()
          if paper_id:
            mapped_ids.add(paper_id)

    for paper_id, row in self.records.items():
      has_mapping = bool(
        (row.get("label", "") and row.get("label", "") != "unknown")
        or row.get("keep_reason")
        or row.get("research_object")
        or row.get("research_perspective")
        or row.get("core_claim")
      )
      if paper_id not in mapped_ids and not has_mapping and paper_id not in self.unmapped_ids:
        self.unmapped_ids.append(paper_id)

    if os.path.exists(self.crawl_checkpoint_path):
      with open(self.crawl_checkpoint_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
      self._completed_crawls = set(data.get("completed", []))

  def _write_status(self, stage: str, **extra: object) -> None:
    payload = {
      "topic": self.topic,
      "stage": stage,
      "run_dir": self.run_dir,
      "updated_at": datetime.now().isoformat(timespec="seconds"),
      "last_checkpoint": extra.get("last_checkpoint", stage),
      "error": extra.get("error", ""),
      "waiting_for_verification": bool(extra.get("waiting_for_verification", False)),
      "waiting_for_kimi": bool(extra.get("waiting_for_kimi", False)),
      "total_unique_papers": len(self.records),
      "output_files": {
        "papers_master_raw.csv": self.master_raw_path,
        "papers_master.csv": self.master_path,
        "papers_selected.csv": self.selected_path,
        "papers_for_download.csv": self.download_candidates_path,
        "candidate_review.md": self.candidate_review_md_path,
        "kimi_map_batches.jsonl": self.map_batches_path,
        "strategy_round1.json": self.strategy1_path,
        "strategy_round2.json": self.strategy2_path,
        "expert_discussion_round1.json": self.discussion1_path,
        "expert_discussion_round2.json": self.discussion2_path,
        "expert_discussion_round1.md": self.discussion1_md_path,
        "expert_discussion_round2.md": self.discussion2_md_path,
        "analysis_summary.md": self.summary_path,
      },
    }
    payload.update(extra)
    save_snapshot_json(self.status_path, payload)

  def _write_csv(self, path: str, rows: List[Dict[str, str]]) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
      writer = csv.DictWriter(handle, fieldnames=MASTER_FIELDS)
      writer.writeheader()
      for row in rows:
        writer.writerow({field: row.get(field, "") for field in MASTER_FIELDS})

  def _append_jsonl(self, payload: Dict[str, object]) -> None:
    with open(self.map_batches_path, "a", encoding="utf-8") as handle:
      handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

  def _write_candidate_csv(self, rows: List[Dict[str, str]]) -> None:
    with open(self.download_candidates_path, "w", encoding="utf-8-sig", newline="") as handle:
      writer = csv.DictWriter(handle, fieldnames=CANDIDATE_FIELDS)
      writer.writeheader()
      for row in rows:
        writer.writerow({field: row.get(field, "") for field in CANDIDATE_FIELDS})

  def _write_discussion_markdown(self, path: str, title: str, discussion: Dict[str, object]) -> None:
    transcript = discussion.get("transcript", {})
    consensus = discussion.get("consensus", {})
    consensus_source = str(transcript.get("consensus_source", "")).strip()
    critique_error = str(transcript.get("deepseek_critique_error", "")).strip()
    revision_error = str(transcript.get("kimi_revision_error", "")).strip()
    lines = [
      f"# {title}",
      "",
      "## Kimi Initial",
      "",
      "```json",
      json.dumps(transcript.get("kimi_initial", {}), ensure_ascii=False, indent=2),
      "```",
      "",
      "## DeepSeek Critique",
      "",
      "```json",
      json.dumps(transcript.get("deepseek_critique", {}), ensure_ascii=False, indent=2),
      "```",
      "",
      "## Consensus Source",
      "",
      consensus_source or "unknown",
      "",
      "## Kimi Final Consensus",
      "",
      "```json",
      json.dumps(consensus, ensure_ascii=False, indent=2),
      "```",
      "",
    ]
    if critique_error:
      lines.extend([
        "## DeepSeek Critique Error",
        "",
        critique_error,
        "",
      ])
    if revision_error:
      lines.extend([
        "## Kimi Revision Error",
        "",
        revision_error,
        "",
      ])
    with open(path, "w", encoding="utf-8") as handle:
      handle.write("\n".join(lines))

  def _write_candidate_review(self) -> List[Dict[str, str]]:
    rows = sorted(
      self.records.values(),
      key=lambda row: float(row.get("final_score", 0.0)),
      reverse=True,
    )
    candidates = [
      {
        "paper_id": row.get("paper_id", ""),
        "title": row.get("title", ""),
        "authors": row.get("authors", ""),
        "journal": row.get("journal", ""),
        "publish_year": row.get("publish_year", ""),
        "cited_count": row.get("cited_count", ""),
        "download_count": row.get("download_count", ""),
        "final_score": row.get("final_score", ""),
        "label": row.get("label", ""),
        "keep_reason": row.get("keep_reason", ""),
        "abstract": row.get("abstract", ""),
        "page_url": row.get("page_url", ""),
        "db_code": row.get("db_code", ""),
        "file_name": row.get("file_name", ""),
        "user_select": row.get("user_select", ""),
      }
      for row in rows
      if row.get("is_worth_keeping", "").lower() == "true"
      and row.get("label", "") != "teaching"
    ][: self.download_candidate_count]
    self._write_candidate_csv(candidates)

    lines = [
      f"# Candidate Review: {self.topic}",
      "",
      "Below is the shortlist for manual approval before download.",
      "Mark `user_select` in `papers_for_download.csv` with `yes` for papers you want.",
      "",
    ]
    for index, row in enumerate(candidates, start=1):
      abstract = (row.get("abstract", "") or "").replace("\n", " ").strip()
      if len(abstract) > 260:
        abstract = abstract[:260] + "..."
      lines.extend(
        [
          f"## {index}. {row.get('title', '')}",
          f"- authors: {row.get('authors', '')}",
          f"- journal: {row.get('journal', '')}",
          f"- year: {row.get('publish_year', '')}",
          f"- cited/download: {row.get('cited_count', '')}/{row.get('download_count', '')}",
          f"- score: {row.get('final_score', '')}",
          f"- label: {row.get('label', '')}",
          f"- keep_reason: {row.get('keep_reason', '')}",
          f"- abstract: {abstract}",
          f"- page_url: {row.get('page_url', '')}",
          "",
        ]
      )
    with open(self.candidate_review_md_path, "w", encoding="utf-8") as handle:
      handle.write("\n".join(lines))
    return candidates

  def _selected_candidate_rows(self) -> List[Dict[str, str]]:
    return [
      row for row in self.records.values()
      if row.get("is_worth_keeping", "").lower() == "true"
      and row.get("label", "") != "teaching"
    ]

  def _selected_candidate_count(self) -> int:
    return len(self._selected_candidate_rows())

  def _should_early_stop_after_round1(self) -> bool:
    return self.early_stop_enabled and self._selected_candidate_count() >= self.early_stop_min_selected

  def _load_user_selected_candidates(self) -> List[Dict[str, str]]:
    if not os.path.exists(self.download_candidates_path):
      return []
    selected = []
    with open(self.download_candidates_path, "r", encoding="utf-8-sig", newline="") as handle:
      for row in csv.DictReader(handle):
        decision = (row.get("user_select", "") or "").strip().lower()
        if decision in {"yes", "y", "1", "true", "download"}:
          selected.append(row)
    return selected

  def _write_download_queue(self, selected_rows: List[Dict[str, str]]) -> str:
    queue_path = os.path.join(self.run_dir, "download_queue.csv")
    with open(queue_path, "w", encoding="utf-8-sig", newline="") as handle:
      writer = csv.DictWriter(handle, fieldnames=CANDIDATE_FIELDS)
      writer.writeheader()
      for row in selected_rows:
        writer.writerow({field: row.get(field, "") for field in CANDIDATE_FIELDS})
    return queue_path

  def _dump_master_files(self) -> None:
    rows = list(self.records.values())
    apply_scores(rows)
    rows.sort(key=lambda row: float(row.get("final_score", 0.0)), reverse=True)
    self._write_csv(self.master_raw_path, rows)
    self._write_csv(self.master_path, rows)

    selected_rows = [
      row for row in rows
      if row.get("is_worth_keeping", "").lower() == "true"
      and row.get("label", "") != "teaching"
    ]
    self._write_csv(self.selected_path, selected_rows)

  def _enrich_rows_with_details(self, driver, rows: List[Dict[str, str]]) -> None:
    max_fetch_per_page = self._env_int("CNKI_DETAIL_FETCH_PER_PAGE", 0)
    if max_fetch_per_page == 0:
      return

    fetched = 0
    for row in rows:
      page_url = (row.get("page_url", "") or "").strip()
      if not page_url:
        continue

      needs_detail = (
        not row.get("abstract")
        or not row.get("authors")
        or not row.get("institution")
      )
      if not needs_detail:
        continue

      metadata = self._detail_cache.get(page_url)
      if metadata is None:
        if fetched >= max_fetch_per_page:
          continue
        print(f"Fetching detail metadata for '{row.get('title', '')[:40]}'...")
        try:
          metadata = fetch_detail_metadata(driver, page_url)
        except Exception as exc:
          print(f"Detail metadata fetch failed for '{row.get('title', '')[:40]}': {exc}")
          metadata = {}
        self._detail_cache[page_url] = metadata or {}
        fetched += 1

      if not metadata:
        continue

      for field in ("title", "authors", "journal", "publish_year", "institution", "db_code", "file_name"):
        if not row.get(field) and metadata.get(field):
          row[field] = metadata[field]
      if metadata.get("page_url") and len(metadata["page_url"]) > len(row.get("page_url", "")):
        row["page_url"] = metadata["page_url"]
      if metadata.get("abstract") and len(metadata["abstract"]) > len(row.get("abstract", "")):
        row["abstract"] = metadata["abstract"]

  def _merge_record(self, row: Dict[str, str], round_no: int, view: str, query_name: str, query_type: str, field_mode: str, page_no: int, rank: int) -> None:
    paper_id = row["paper_id"]
    best_rank_value = ((page_no - 1) * 50) + rank
    quality_tier, tier_source, quality_score = self.tier_index.classify(row.get("journal", ""))

    if paper_id not in self.records:
      self.global_seen_counter += 1
      self.records[paper_id] = {
        "paper_id": paper_id,
        "topic": self.topic,
        "round": str(round_no),
        "query": query_name,
        "query_type": query_type,
        "field_mode": field_mode,
        "title": row.get("title", ""),
        "authors": row.get("authors", ""),
        "journal": row.get("journal", ""),
        "journal_tier": quality_tier,
        "tier_source": tier_source,
        "publish_year": row.get("publish_year", ""),
        "cited_count": row.get("cited_count", "0") or "0",
        "download_count": row.get("download_count", "0") or "0",
        "institution": row.get("institution", ""),
        "abstract": row.get("abstract", ""),
        "page_url": row.get("page_url", ""),
        "db_code": row.get("db_code", ""),
        "file_name": row.get("file_name", ""),
        "detected_rounds": str(round_no),
        "detected_views": view,
        "detected_queries": query_name,
        "first_seen_order": str(self.global_seen_counter),
        "best_rank_snapshot": f"r{round_no}:{view}:p{page_no}#{rank}",
        "relevance_score": "0.0000",
        "quality_score": f"{quality_score:.4f}",
        "impact_score": "0.0000",
        "freshness_score": "0.0000",
        "final_score": "0.0000",
        "label": "unknown",
        "keep_reason": "",
        "is_worth_keeping": "false",
        "research_object": "",
        "research_perspective": "",
        "core_claim": "",
        "material_type": "",
        "_best_rank_value": str(best_rank_value),
      }
      self.unmapped_ids.append(paper_id)
      return

    existing = self.records[paper_id]
    existing["detected_rounds"] = unique_join(existing.get("detected_rounds", ""), str(round_no))
    existing["detected_views"] = unique_join(existing.get("detected_views", ""), view)
    existing["detected_queries"] = unique_join(existing.get("detected_queries", ""), query_name)
    existing["round"] = str(round_no)
    existing["query"] = query_name
    existing["query_type"] = query_type
    existing["field_mode"] = field_mode
    existing["journal_tier"] = quality_tier if quality_tier != "UNKNOWN" else existing.get("journal_tier", "UNKNOWN")
    existing["tier_source"] = tier_source if quality_tier != "UNKNOWN" else existing.get("tier_source", "no_match")
    existing["quality_score"] = f"{quality_score:.4f}" if quality_tier != "UNKNOWN" else existing.get("quality_score", "0.3500")

    if not existing.get("abstract") and row.get("abstract"):
      existing["abstract"] = row["abstract"]
      if paper_id not in self.unmapped_ids:
        self.unmapped_ids.append(paper_id)
    if not existing.get("institution") and row.get("institution"):
      existing["institution"] = row["institution"]
    if row.get("page_url") and len(row.get("page_url", "")) > len(existing.get("page_url", "")):
      existing["page_url"] = row["page_url"]
    if not existing.get("db_code") and row.get("db_code"):
      existing["db_code"] = row["db_code"]
    if not existing.get("file_name") and row.get("file_name"):
      existing["file_name"] = row["file_name"]
    if _safe_int(row.get("cited_count", "0")) > _safe_int(existing.get("cited_count", "0")):
      existing["cited_count"] = row["cited_count"]
    if _safe_int(row.get("download_count", "0")) > _safe_int(existing.get("download_count", "0")):
      existing["download_count"] = row["download_count"]

    current_best = int(existing.get("_best_rank_value", "999999"))
    if best_rank_value < current_best:
      existing["_best_rank_value"] = str(best_rank_value)
      existing["best_rank_snapshot"] = f"r{round_no}:{view}:p{page_no}#{rank}"

  def _map_pending_batches(self) -> None:
    while len(self.unmapped_ids) >= self.batch_size:
      batch_ids = self.unmapped_ids[: self.batch_size]
      self.unmapped_ids = self.unmapped_ids[self.batch_size :]
      self._map_batch(batch_ids)

  def _flush_remaining_batches(self) -> None:
    while self.unmapped_ids:
      batch_ids = self.unmapped_ids[: self.batch_size]
      self.unmapped_ids = self.unmapped_ids[self.batch_size :]
      self._map_batch(batch_ids)

  def _map_batch(self, batch_ids: List[str]) -> None:
    batch_rows = []
    for paper_id in batch_ids:
      record = self.records[paper_id]
      batch_rows.append(
        {
          "paper_id": paper_id,
          "title": record.get("title", ""),
          "journal": record.get("journal", ""),
          "publish_year": record.get("publish_year", ""),
          "cited_count": record.get("cited_count", "0"),
          "download_count": record.get("download_count", "0"),
          "abstract": record.get("abstract", ""),
        }
      )

    self._write_status("kimi_map_batch", waiting_for_kimi=True, batch_size=len(batch_rows))
    system_prompt, user_prompt = build_batch_map_prompts(self.topic, batch_rows)
    batch_label = f"batch_map:{batch_ids[0]}..{batch_ids[-1]}" if batch_ids else "batch_map"
    result = self.kimi.call_json(system_prompt, user_prompt, request_label=batch_label)
    papers = result.get("papers", [])
    if not isinstance(papers, list):
      raise RuntimeError("Kimi batch map response is missing the papers list.")

    mapped = []
    for item in papers:
      if not isinstance(item, dict):
        continue
      paper_id = str(item.get("paper_id", "")).strip()
      if paper_id not in self.records:
        continue
      record = self.records[paper_id]
      record["research_object"] = str(item.get("research_object", ""))
      record["research_perspective"] = str(item.get("research_perspective", ""))
      record["core_claim"] = str(item.get("core_claim", ""))
      record["material_type"] = str(item.get("material_type", ""))
      record["label"] = str(item.get("label", "unknown"))
      record["is_worth_keeping"] = "true" if bool(item.get("is_worth_keeping", False)) else "false"
      record["keep_reason"] = str(item.get("keep_reason", ""))
      try:
        relevance = max(0.0, min(1.0, float(item.get("relevance_score", 0.0))))
      except (TypeError, ValueError):
        relevance = 0.0
      record["relevance_score"] = f"{relevance:.4f}"
      mapped.append(
        {
          "paper_id": paper_id,
          "label": record["label"],
          "is_worth_keeping": record["is_worth_keeping"] == "true",
          "keep_reason": record["keep_reason"],
          "relevance_score": relevance,
          "research_object": record["research_object"],
          "research_perspective": record["research_perspective"],
          "core_claim": record["core_claim"],
          "material_type": record["material_type"],
        }
      )

    batch_payload = {
      "batch_id": f"batch_{len(self.map_batches) + 1:04d}",
      "generated_at": datetime.now().isoformat(timespec="seconds"),
      "topic": self.topic,
      "paper_ids": batch_ids,
      "mapped": mapped,
    }
    self.map_batches.append(batch_payload)
    self._append_jsonl(batch_payload)
    self._dump_master_files()
    self._write_status("kimi_map_batch_done", waiting_for_kimi=False, last_checkpoint="kimi_map_batch_done")

  def _reduce_round2_strategy(self, strategy_round1: Dict[str, object]) -> Dict[str, object]:
    self._write_status("kimi_reduce_round2", waiting_for_kimi=True)
    discussion = self.experts.discuss_round2(self.topic, strategy_round1, self.map_batches)
    save_snapshot_json(self.discussion2_path, discussion)
    self._write_discussion_markdown(self.discussion2_md_path, f"Expert Discussion Round 2: {self.topic}", discussion)
    result = discussion["consensus"]
    save_snapshot_json(self.strategy2_path, result)
    self._write_status("kimi_reduce_round2_done", waiting_for_kimi=False, last_checkpoint="strategy_round2.json")
    return result

  def _write_summary(self, final_reduce: Dict[str, object]) -> None:
    top_rows = sorted(
      self.records.values(),
      key=lambda row: float(row.get("final_score", 0.0)),
      reverse=True,
    )[:15]
    lines = [
      f"# {self.topic}",
      "",
      str(final_reduce.get("analysis_summary_markdown", "")).strip(),
      "",
      "## Top Selected Papers",
      "",
    ]
    for row in top_rows:
      lines.append(
        f"- {row.get('title', '')} | {row.get('journal', '')} | "
        f"score={row.get('final_score', '0')} | label={row.get('label', 'unknown')}"
      )

    with open(self.summary_path, "w", encoding="utf-8") as handle:
      handle.write("\n".join(lines).strip() + "\n")

  def _save_crawl_checkpoint(self) -> None:
    payload = {"completed": sorted(self._completed_crawls)}
    with open(self.crawl_checkpoint_path, "w", encoding="utf-8") as handle:
      json.dump(payload, handle, ensure_ascii=False, indent=2)

  def _mark_crawl_completed(self, key: str) -> None:
    self._completed_crawls.add(key)
    self._save_crawl_checkpoint()

  def _is_crawl_completed(self, key: str) -> bool:
    return key in self._completed_crawls

  def _crawl_query(
    self,
    driver,
    query_spec: Dict[str, object],
    round_no: int,
    is_first_query: bool = True,
  ) -> None:
    query_name = str(query_spec.get("name", f"round{round_no}_query"))
    expression = str(query_spec.get("expression", "")).strip()
    query_type = str(query_spec.get("query_type", "professional"))
    field_mode = str(query_spec.get("field_mode", "篇关摘"))

    if not expression:
      return

    pending_views: List[Tuple[str, str]] = []
    for view in self.sort_views:
      crawl_key = f"r{round_no}:{query_name}:{view}"
      if self._is_crawl_completed(crawl_key):
        print(f"Skipping already-completed crawl: {crawl_key}")
        continue
      pending_views.append((view, crawl_key))

    if not pending_views:
      return

    print(
      f"Submitting CNKI search once for round {round_no} query '{query_name}' "
      f"and reusing the results page for {len(pending_views)} view(s)."
    )
    if not is_first_query:
      print(f"Pausing before next query '{query_name}'...")
    needs_full_setup = navigate_to_search(driver, is_first_query=is_first_query)
    print(f"Search page ready for query '{query_name}'.")
    set_precision_toggles(driver)
    fill_professional_query(driver, expression)
    submit_search(driver)
    if needs_full_setup:
      switch_to_detail_view(driver)
      set_page_size(driver, page_size=50)

    for view, crawl_key in pending_views:
      self._write_status(
        "searching",
        last_checkpoint=f"round{round_no}:{query_name}:{view}",
        current_query=query_name,
        current_view=view,
      )
      if not set_result_sort(driver, view):
        raise RuntimeError(f"Could not switch CNKI results sort to '{view}'.")

      page_no = 1
      while True:
        rows = extract_result_cards(driver)
        if not rows:
          break
        self._enrich_rows_with_details(driver, rows)

        for rank, row in enumerate(rows, start=1):
          self._merge_record(
            row=row,
            round_no=round_no,
            view=view,
            query_name=query_name,
            query_type=query_type,
            field_mode=field_mode,
            page_no=page_no,
            rank=rank,
          )

        self._dump_master_files()
        self._map_pending_batches()

        if self.max_pages_per_view > 0 and page_no >= self.max_pages_per_view:
          break
        if not next_page(driver):
          break
        page_no += 1

      self._mark_crawl_completed(crawl_key)

  def _crawl_queries(self, query_specs: List[Dict[str, object]], round_no: int) -> bool:
    driver = build_driver()
    stopped_early = False
    try:
      for query_index, query_spec in enumerate(query_specs):
        query_name = str(query_spec.get("name", f"round{round_no}_query"))
        last_error: Exception | None = None
        for attempt in range(3):
          try:
            self._crawl_query(
              driver,
              query_spec=query_spec,
              round_no=round_no,
              is_first_query=(query_index == 0),
            )
            last_error = None
            break
          except (TimeoutException, StaleElementReferenceException) as e:
            last_error = e
            if attempt >= 2:
              dump_debug_html(driver, self.debug_html_path)
              raise
            print(f"Page interaction failed ({type(e).__name__}). Rebuilding driver and retrying query ({attempt + 2}/3)...")
            try:
              driver.quit()
            except Exception:
              pass
            driver = build_driver()
          except Exception as wde:
            last_error = wde
            if attempt >= 2:
              try: dump_debug_html(driver, self.debug_html_path)
              except: pass
              raise
            
            err_msg = str(wde).lower()
            needs_rebuild = any(x in err_msg for x in ["disconnected", "unreachable", "session deleted", "no such window", "connection refused"])
            
            if needs_rebuild:
              print(f"WebDriver disconnected: {wde}. Rebuilding driver and retrying ({attempt + 2}/3)...")
              try:
                driver.quit()
              except Exception:
                pass
              driver = build_driver()
          else:
              print(f"Page interaction failed ({type(wde).__name__}): {wde}. Retrying query in same browser ({attempt + 2}/3)...")
        if last_error is not None:
          raise last_error

        self._flush_remaining_batches()
        if round_no == 1 and self._should_early_stop_after_round1():
          selected_count = self._selected_candidate_count()
          print(
            f"Early stopping remaining round 1 queries after '{query_name}' "
            f"because {selected_count} selected papers already exceed the threshold "
            f"{self.early_stop_min_selected}."
          )
          self._write_status(
            "search_early_stop",
            waiting_for_kimi=False,
            last_checkpoint=f"round{round_no}:{query_name}:early_stop",
            selected_candidate_count=selected_count,
            early_stop_threshold=self.early_stop_min_selected,
          )
          stopped_early = True
          break
    except TimeoutException:
      waiting = detect_waiting_state(driver)
      dump_debug_html(driver, self.debug_html_path)
      self._write_status(
        "paused",
        error="Timeout while waiting for CNKI page state.",
        waiting_for_verification=waiting.get("waiting_for_verification", False),
        last_checkpoint=f"round_{round_no}_timeout",
      )
      raise
    finally:
      driver.quit()
    return stopped_early

  def _build_round1_queries(self, strategy: Dict[str, object]) -> List[Dict[str, object]]:
    queries: List[Dict[str, object]] = []
    core_query = strategy.get("core_query", {})
    if isinstance(core_query, dict):
      queries.append(
        {
          "name": str(core_query.get("name", "core")),
          "expression": str(core_query.get("expression", "")),
          "query_type": str(strategy.get("query_type", "professional")),
          "field_mode": str(core_query.get("field_mode", "篇关摘")),
        }
      )

    for item in strategy.get("alternate_queries", []):
      if not isinstance(item, dict):
        continue
      queries.append(
        {
          "name": str(item.get("name", "alternate")),
          "expression": str(item.get("expression", "")),
          "query_type": str(strategy.get("query_type", "professional")),
          "field_mode": str(item.get("field_mode", "篇关摘")),
        }
      )
    return [query for query in queries if query.get("expression")]

  def _build_round2_queries(self, reduce_result: Dict[str, object]) -> List[Dict[str, object]]:
    queries = []
    for item in reduce_result.get("recommended_queries", []):
      if not isinstance(item, dict):
        continue
      queries.append(
        {
          "name": str(item.get("name", "round2")),
          "expression": str(item.get("expression", "")),
          "query_type": "professional",
          "field_mode": str(item.get("field_mode", "篇关摘")),
        }
      )
    return [query for query in queries if query.get("expression")]

  def run(self) -> None:
    try:
      if os.path.exists(self.discussion1_path) and os.path.exists(self.strategy1_path):
        round1_discussion = load_snapshot_json(self.discussion1_path)
        strategy_round1 = load_snapshot_json(self.strategy1_path)
      else:
        self._write_status("strategy_round1", waiting_for_kimi=True)
        round1_discussion = self.experts.discuss_round1(self.topic)
        save_snapshot_json(self.discussion1_path, round1_discussion)
        self._write_discussion_markdown(self.discussion1_md_path, f"Expert Discussion Round 1: {self.topic}", round1_discussion)
        strategy_round1 = round1_discussion["consensus"]
        save_snapshot_json(self.strategy1_path, strategy_round1)
        self._write_status("strategy_round1_done", waiting_for_kimi=False, last_checkpoint="strategy_round1.json")

      if not os.path.exists(self.discussion1_md_path):
        self._write_discussion_markdown(self.discussion1_md_path, f"Expert Discussion Round 1: {self.topic}", round1_discussion)

      if not self.approve_strategy:
        self._write_status(
          "awaiting_strategy_approval",
          waiting_for_kimi=False,
          last_checkpoint="expert_discussion_round1.md",
          approval_message=(
            "Review expert_discussion_round1.md and strategy_round1.json. "
            "If approved, rerun with --approve-strategy."
          ),
        )
        return

      round1_queries = self._build_round1_queries(strategy_round1)
      if round1_queries:
        self._crawl_queries(round1_queries, round_no=1)

      if os.path.exists(self.strategy2_path) and os.path.exists(self.discussion2_path):
        strategy_round2 = load_snapshot_json(self.strategy2_path)
        round2_discussion = load_snapshot_json(self.discussion2_path)
        if not os.path.exists(self.discussion2_md_path):
          self._write_discussion_markdown(self.discussion2_md_path, f"Expert Discussion Round 2: {self.topic}", round2_discussion)
      else:
        strategy_round2 = self._reduce_round2_strategy(strategy_round1)
      round2_queries = self._build_round2_queries(strategy_round2)
      if round2_queries:
        if self.skip_round2_crawl_when_enough and self._should_early_stop_after_round1():
          selected_count = self._selected_candidate_count()
          print(
            f"Skipping round 2 crawl because {selected_count} selected papers already exceed "
            f"the threshold {self.early_stop_min_selected}."
          )
          self._write_status(
            "round2_crawl_skipped",
            waiting_for_kimi=False,
            last_checkpoint="round2_crawl_skipped",
            selected_candidate_count=selected_count,
            early_stop_threshold=self.early_stop_min_selected,
          )
        else:
          self._crawl_queries(round2_queries, round_no=2)

      self._flush_remaining_batches()
      self._dump_master_files()
      candidates = self._write_candidate_review()

      if not self.approve_selection:
        self._write_status(
          "awaiting_download_selection",
          waiting_for_kimi=False,
          last_checkpoint="candidate_review.md",
          candidate_count=len(candidates),
          approval_message=(
            "Review candidate_review.md and papers_for_download.csv, mark user_select=yes, "
            "then rerun with --approve-strategy --approve-selection."
          ),
        )
        return

      selected_candidates = self._load_user_selected_candidates()
      queue_path = self._write_download_queue(selected_candidates)

      self._write_status("final_reduce", waiting_for_kimi=True)
      if os.path.exists(self.summary_path):
        final_reduce = {"analysis_summary_markdown": ""}
      else:
        final_reduce_discussion = self.experts.discuss_round2(self.topic, strategy_round1, self.map_batches)
        final_reduce = final_reduce_discussion["consensus"]
        self._write_summary(final_reduce)

      self._dump_master_files()
      self._write_status(
        "ready_for_download",
        waiting_for_kimi=False,
        last_checkpoint="download_queue.csv",
        selected_for_download=len(selected_candidates),
        download_queue=queue_path,
      )
    except Exception as exc:
      self._dump_master_files()
      self._write_status(
        "failed",
        error=f"{type(exc).__name__}: {exc}",
        trace=traceback.format_exc(),
        last_checkpoint="failed",
      )
      raise


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="CNKI high-quality research search pipeline")
  parser.add_argument("topic", nargs="?", default=os.getenv("CNKI_TOPIC", "").strip(), help="Research topic")
  parser.add_argument("--resume-dir", default="", help="Resume an existing run directory")
  parser.add_argument("--topic-file", default="", help="Read UTF-8 topic text from a file")
  parser.add_argument("--approve-strategy", action="store_true", help="Continue after expert strategy review")
  parser.add_argument("--approve-selection", action="store_true", help="Continue after manual download candidate selection")
  return parser.parse_args()


def main() -> None:
  args = parse_args()
  topic = args.topic
  if args.topic_file:
    with open(args.topic_file, "r", encoding="utf-8") as handle:
      topic = handle.read().strip()
  if not topic:
    raise SystemExit("Please provide a topic argument or set CNKI_TOPIC.")

  pipeline = ResearchPipeline(
    topic=topic,
    resume_dir=args.resume_dir or None,
    approve_strategy=args.approve_strategy,
    approve_selection=args.approve_selection,
  )
  pipeline.run()


if __name__ == "__main__":
  main()
