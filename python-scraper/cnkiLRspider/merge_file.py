import csv
import os
from typing import Dict, List, Sequence

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(BASE_DIR, "LR.csv")

INPUT_CANDIDATES = {
  "basic": ["basic_info.csv", "\u57fa\u672c\u4fe1\u606f.csv"],
  "detail": ["page_elements.csv", "\u9875\u9762\u5143\u7d20.csv"],
}

DEFAULT_COLUMNS = {
  "basic": ["title", "authors", "journal", "publish_date", "cited_count", "download_count"],
  "detail": ["title", "authors", "institution", "journal", "abstract"],
}


def _resolve_existing_file(candidates: Sequence[str]) -> str:
  for name in candidates:
    path = os.path.join(BASE_DIR, name)
    if os.path.exists(path):
      return path
  raise FileNotFoundError(f"Missing input files, tried: {', '.join(candidates)}")


def _read_raw_rows(path: str) -> List[List[str]]:
  last_error = None
  for encoding in ["utf-8-sig", "utf-8", "gbk"]:
    try:
      with open(path, "r", newline="", encoding=encoding) as handle:
        return list(csv.reader(handle))
    except UnicodeDecodeError as exc:
      last_error = exc
  raise UnicodeDecodeError(str(last_error), b"", 0, 1, "could not decode file")


def _load_rows(path: str, expected_columns: Sequence[str]) -> List[Dict[str, str]]:
  raw_rows = _read_raw_rows(path)
  if not raw_rows:
    return []

  first = [item.strip().lower() for item in raw_rows[0]]
  has_header = "title" in first
  if has_header:
    header = first
    data_rows = raw_rows[1:]
  else:
    header = list(expected_columns)
    data_rows = raw_rows

  rows: List[Dict[str, str]] = []
  for row in data_rows:
    padded = row + [""] * (len(header) - len(row))
    rows.append({header[idx]: padded[idx].strip() for idx in range(len(header))})
  return rows


def _normalize_title(title: str) -> str:
  return " ".join(title.strip().split()).lower()


def merge_csv() -> str:
  basic_file = _resolve_existing_file(INPUT_CANDIDATES["basic"])
  detail_file = _resolve_existing_file(INPUT_CANDIDATES["detail"])

  basic_rows = _load_rows(basic_file, DEFAULT_COLUMNS["basic"])
  detail_rows = _load_rows(detail_file, DEFAULT_COLUMNS["detail"])

  basic_map = {}
  for row in basic_rows:
    key = _normalize_title(row.get("title", ""))
    if key:
      basic_map[key] = row

  merged_rows = []
  for row in detail_rows:
    title = row.get("title", "")
    key = _normalize_title(title)
    basic = basic_map.get(key, {})
    merged_rows.append(
      {
        "title": title,
        "authors": basic.get("authors", row.get("authors", "")),
        "journal": basic.get("journal", row.get("journal", "")),
        "publish_date": basic.get("publish_date", ""),
        "cited_count": basic.get("cited_count", ""),
        "download_count": basic.get("download_count", ""),
        "institution": row.get("institution", ""),
        "abstract": row.get("abstract", ""),
      }
    )

  fieldnames = [
    "title",
    "authors",
    "journal",
    "publish_date",
    "cited_count",
    "download_count",
    "institution",
    "abstract",
  ]
  with open(OUTPUT_FILE, "w", newline="", encoding="utf-8-sig") as handle:
    writer = csv.DictWriter(handle, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(merged_rows)

  print(
    f"Merge completed. basic={len(basic_rows)} detail={len(detail_rows)} "
    f"merged={len(merged_rows)} output={OUTPUT_FILE}"
  )
  return OUTPUT_FILE


if __name__ == "__main__":
  merge_csv()
