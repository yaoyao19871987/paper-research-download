import argparse
import json
import os
import sys
from datetime import datetime

from cnki_common import (
    build_driver,
    detect_waiting_state,
    extract_result_cards,
    fill_professional_query,
    open_advanced_search,
    save_snapshot_json,
    set_precision_toggles,
    submit_search,
    switch_search_mode,
)
from cnki_page_state import capture_page_artifacts, get_page_state
from kimi_client import ExpertDiscussionEngine
from research_pipeline import ensure_dir, slugify_topic


def parse_args():
    parser = argparse.ArgumentParser(description="Run expert discussion -> CNKI professional search smoke test.")
    parser.add_argument("topic", nargs="?", default="", help="Research topic")
    parser.add_argument("--topic-file", default="", help="Read UTF-8 topic text from a file")
    parser.add_argument("--strategy-file", default="", help="Reuse an existing strategy_round1.json and skip discussion")
    return parser.parse_args()


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    except Exception:
        pass

    args = parse_args()
    topic = args.topic.strip()
    if args.topic_file:
        with open(args.topic_file, "r", encoding="utf-8-sig") as handle:
            topic = handle.read().strip()
    topic = topic.lstrip("\ufeff")
    if not topic:
        raise SystemExit("Topic is required.")

    base_dir = os.path.dirname(os.path.abspath(__file__))
    output_root = os.path.join(base_dir, "outputs")
    ensure_dir(output_root)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = os.path.join(output_root, f"{slugify_topic(topic)}-smoke-{stamp}")
    ensure_dir(run_dir)

    print(f"Running discussion/search smoke test for topic: {topic}")
    if args.strategy_file:
        with open(args.strategy_file, "r", encoding="utf-8") as handle:
            consensus = json.load(handle)
        discussion = {"consensus": consensus, "transcript": {"reused_strategy_file": args.strategy_file}}
    else:
        experts = ExpertDiscussionEngine()
        discussion = experts.discuss_round1(topic)
        consensus = discussion.get("consensus", {}) if isinstance(discussion, dict) else {}
    core_query = consensus.get("core_query", {}) if isinstance(consensus, dict) else {}
    expression = str(core_query.get("expression", "")).strip()

    save_snapshot_json(os.path.join(run_dir, "expert_discussion_round1.json"), discussion)
    save_snapshot_json(os.path.join(run_dir, "strategy_round1.json"), consensus if isinstance(consensus, dict) else {})

    if not expression:
        raise RuntimeError("Expert discussion did not return a core query expression.")

    result_payload = {
        "topic": topic,
        "expression": expression,
        "run_dir": run_dir,
    }

    driver = build_driver()
    try:
        open_advanced_search(driver)
        switch_search_mode(driver, mode="professional")
        set_precision_toggles(driver)
        fill_professional_query(driver, expression)
        submit_search(driver)

        cards = extract_result_cards(driver)
        page_state = get_page_state(driver)
        waiting_state = detect_waiting_state(driver)
        artifacts = capture_page_artifacts(driver, "discussion-search-results", output_dir=run_dir)

        result_payload.update(
            {
                "page_state": page_state,
                "waiting_state": waiting_state,
                "result_count": len(cards),
                "first_titles": [row.get("title", "") for row in cards[:5]],
                "artifacts": artifacts,
            }
        )
        print(json.dumps(result_payload, ensure_ascii=False, indent=2))
        save_snapshot_json(os.path.join(run_dir, "smoke_result.json"), result_payload)
    except Exception as exc:
        artifacts = capture_page_artifacts(driver, "discussion-search-error", output_dir=run_dir)
        result_payload.update(
            {
                "error": f"{type(exc).__name__}: {exc}",
                "page_state": get_page_state(driver),
                "waiting_state": detect_waiting_state(driver),
                "artifacts": artifacts,
            }
        )
        save_snapshot_json(os.path.join(run_dir, "smoke_result.json"), result_payload)
        print(json.dumps(result_payload, ensure_ascii=False, indent=2))
        raise
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
