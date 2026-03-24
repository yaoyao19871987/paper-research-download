import json
import os
import re
from typing import Dict, List, Tuple

DEFAULT_TIER_WEIGHTS = {
  "CSSCI": 1.00,
  "PKU_CORE": 0.88,
  "CSCD": 0.82,
  "FEATURED": 0.72,
  "UNKNOWN": 0.35,
}


def _normalize_journal_name(name: str) -> str:
  text = (name or "").strip()
  text = re.sub(r"\s+", "", text)
  text = text.replace("（中英文）", "")
  text = text.replace("(中英文)", "")
  return text


class JournalTierIndex:
  def __init__(self, base_dir: str):
    self.base_dir = base_dir
    self._tier_map = self._load_tier_map()

  def _load_tier_map(self) -> Dict[str, List[str]]:
    path = os.path.join(self.base_dir, "journal_tiers.json")
    if not os.path.exists(path):
      return {}
    with open(path, "r", encoding="utf-8") as handle:
      data = json.load(handle)
    return {
      tier: [_normalize_journal_name(item) for item in values]
      for tier, values in data.items()
      if isinstance(values, list)
    }

  def classify(self, journal_name: str) -> Tuple[str, str, float]:
    normalized = _normalize_journal_name(journal_name)
    if not normalized:
      return ("UNKNOWN", "missing_journal", DEFAULT_TIER_WEIGHTS["UNKNOWN"])

    for tier, names in self._tier_map.items():
      if normalized in names:
        return (tier, "journal_tiers.json", DEFAULT_TIER_WEIGHTS.get(tier, 0.35))

    return ("UNKNOWN", "no_match", DEFAULT_TIER_WEIGHTS["UNKNOWN"])
