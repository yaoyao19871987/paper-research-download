import argparse
import csv
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from typing import Dict, List


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(BASE_DIR))
OUTPUT_ROOT = os.path.abspath(os.getenv("CNKI_OUTPUT_ROOT", os.path.join(BASE_DIR, "outputs")))
LEGACY_SIXUE_DOWNLOADER = os.path.join(REPO_ROOT, "src", "legacy-sixue-download.js")


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def slugify_topic(topic: str) -> str:
    topic = re.sub(r"[<>:\"/\\|?*]", "_", topic.strip())
    topic = re.sub(r"\s+", "_", topic)
    return topic[:80] or "topic"


def write_text(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def run_command(command: List[str], cwd: str, env: Dict[str, str], log_path: str) -> None:
    with open(log_path, "a", encoding="utf-8") as log_handle:
        log_handle.write(f"\n$ {' '.join(command)}\n")
        log_handle.flush()
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        for line in process.stdout:
            sys.stdout.write(line)
            log_handle.write(line)
        return_code = process.wait()
        if return_code != 0:
            raise RuntimeError(f"Command failed with exit code {return_code}: {' '.join(command)}")


def auto_select_candidates(candidate_csv: str, limit: int) -> List[Dict[str, str]]:
    with open(candidate_csv, "r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    if not rows:
        return []

    selected: List[Dict[str, str]] = []
    picked = 0
    for row in rows:
        page_url = (row.get("page_url", "") or "").strip()
        if page_url and picked < limit:
            row["user_select"] = "yes"
            selected.append(row)
            picked += 1
        else:
            row["user_select"] = ""

    with open(candidate_csv, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    return selected


def read_queue(queue_csv: str) -> List[Dict[str, str]]:
    if not os.path.exists(queue_csv):
        return []
    with open(queue_csv, "r", encoding="utf-8-sig", newline="") as handle:
        return [row for row in csv.DictReader(handle)]


def build_legacy_download_command(row: Dict[str, str]) -> List[str]:
    title = (row.get("title", "") or "").strip()
    if not title:
        raise RuntimeError("Selected queue row is missing title, cannot dispatch legacy Sixue download.")

    # The fixed production route is:
    # Sixue library -> entry 1 -> proxy CNKI search -> matched title -> download page -> file save
    # We intentionally search by title inside the Sixue flow instead of opening CNKI page_url directly.
    return [
        "node",
        LEGACY_SIXUE_DOWNLOADER,
        title,
        title,
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run topic discussion -> candidate selection -> legacy Sixue download end-to-end."
    )
    parser.add_argument("topic", nargs="?", default="", help="Research topic")
    parser.add_argument("--topic-file", default="", help="Read UTF-8 topic from file")
    parser.add_argument("--download-limit", type=int, default=1, help="How many selected papers to actually download")
    parser.add_argument("--run-dir", default="", help="Explicit run directory")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    topic = args.topic.strip()
    if args.topic_file:
        with open(args.topic_file, "r", encoding="utf-8-sig") as handle:
            topic = handle.read().strip()
    if not topic:
        raise SystemExit("Topic is required.")

    ensure_dir(OUTPUT_ROOT)
    if args.run_dir:
        run_dir = args.run_dir
    else:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        run_dir = os.path.join(OUTPUT_ROOT, f"{slugify_topic(topic)}-full-{stamp}")
    ensure_dir(run_dir)

    topic_file = os.path.join(run_dir, "input_topic.txt")
    log_path = os.path.join(run_dir, "full_pipeline.log")
    summary_path = os.path.join(run_dir, "full_pipeline_result.json")
    candidate_csv = os.path.join(run_dir, "papers_for_download.csv")
    queue_csv = os.path.join(run_dir, "download_queue.csv")
    write_text(topic_file, topic)

    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env.setdefault("CNKI_MAX_PAGES_PER_VIEW", "1")
    env.setdefault("CNKI_DOWNLOAD_CANDIDATES", str(max(args.download_limit, 3)))
    env.setdefault("CNKI_MAP_BATCH_SIZE", "4")
    env.setdefault("KIMI_TIMEOUT_SECONDS", "300")
    env.setdefault("KIMI_VISION_TIMEOUT_SECONDS", "180")

    python_cmd = [
        sys.executable,
        os.path.join(BASE_DIR, "research_pipeline.py"),
        "--topic-file",
        topic_file,
        "--resume-dir",
        run_dir,
        "--approve-strategy",
    ]

    run_command(python_cmd, cwd=BASE_DIR, env=env, log_path=log_path)

    if not os.path.exists(candidate_csv):
        raise RuntimeError("Candidate review stage did not produce papers_for_download.csv.")

    selected_rows = auto_select_candidates(candidate_csv, args.download_limit)
    if not selected_rows:
        raise RuntimeError("No candidate with a page_url was available for auto-selection.")

    run_command(
        python_cmd + ["--approve-selection"],
        cwd=BASE_DIR,
        env=env,
        log_path=log_path,
    )

    queue_rows = read_queue(queue_csv)
    if not queue_rows:
        raise RuntimeError("Download queue is empty after auto-selection.")

    download_results = []
    for index, row in enumerate(queue_rows[: args.download_limit], start=1):
        download_log = os.path.join(run_dir, f"download_{index:02d}.log")
        node_command = build_legacy_download_command(row)
        try:
            run_command(node_command, cwd=REPO_ROOT, env=env, log_path=download_log)
            download_results.append(
                {
                    "index": index,
                    "title": row.get("title", ""),
                    "page_url": (row.get("page_url", "") or "").strip(),
                    "download_route": "legacy-sixue",
                    "legacy_query": row.get("title", ""),
                    "status": "downloaded",
                    "log_path": download_log,
                }
            )
        except Exception as exc:
            download_results.append(
                {
                    "index": index,
                    "title": row.get("title", ""),
                    "page_url": (row.get("page_url", "") or "").strip(),
                    "download_route": "legacy-sixue",
                    "legacy_query": row.get("title", ""),
                    "status": "failed",
                    "error": str(exc),
                    "log_path": download_log,
                }
            )
            break

    summary = {
        "topic": topic,
        "run_dir": run_dir,
        "candidate_csv": candidate_csv,
        "queue_csv": queue_csv,
        "selected_titles": [row.get("title", "") for row in selected_rows],
        "download_results": download_results,
    }
    with open(summary_path, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
