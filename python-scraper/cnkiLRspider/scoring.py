import math
from datetime import datetime
from typing import Dict, List

FINAL_SCORE_WEIGHTS = {
  "relevance": 0.55,
  "quality": 0.20,
  "impact": 0.15,
  "freshness": 0.10,
}


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
  return max(low, min(high, value))


def min_max_normalize(values: List[float]) -> List[float]:
  if not values:
    return []
  minimum = min(values)
  maximum = max(values)
  if math.isclose(minimum, maximum):
    return [1.0 if maximum > 0 else 0.0 for _ in values]
  return [(value - minimum) / (maximum - minimum) for value in values]


def compute_freshness_score(publish_year: str, current_year: int | None = None) -> float:
  if current_year is None:
    current_year = datetime.now().year
  try:
    year = int(publish_year)
  except (TypeError, ValueError):
    return 0.20

  age = current_year - year
  if age <= 2:
    return 1.00
  if age <= 4:
    return 0.80
  if age <= 7:
    return 0.60
  if age <= 12:
    return 0.40
  return 0.25


def compute_log_impact_score(cited_count: str, download_count: str, cite_weight: float = 0.6, download_weight: float = 0.4) -> float:
  cited = int(cited_count or 0)
  downloaded = int(download_count or 0)
  return (cite_weight * math.log10(cited + 1)) + (download_weight * math.log10(downloaded + 1))


def apply_scores(records: List[Dict[str, str]]) -> None:
  impact_values = [
    compute_log_impact_score(record.get("cited_count", "0"), record.get("download_count", "0"))
    for record in records
  ]
  impact_normalized = min_max_normalize(impact_values)

  for index, record in enumerate(records):
    relevance_score = clamp(float(record.get("relevance_score", 0.0)))
    quality_score = clamp(float(record.get("quality_score", 0.0)))
    freshness_score = clamp(compute_freshness_score(record.get("publish_year", "")))
    impact_score = clamp(impact_normalized[index] if index < len(impact_normalized) else 0.0)

    final_score = (
      FINAL_SCORE_WEIGHTS["relevance"] * relevance_score
      + FINAL_SCORE_WEIGHTS["quality"] * quality_score
      + FINAL_SCORE_WEIGHTS["impact"] * impact_score
      + FINAL_SCORE_WEIGHTS["freshness"] * freshness_score
    )

    record["impact_score"] = f"{impact_score:.4f}"
    record["freshness_score"] = f"{freshness_score:.4f}"
    record["final_score"] = f"{final_score:.4f}"
