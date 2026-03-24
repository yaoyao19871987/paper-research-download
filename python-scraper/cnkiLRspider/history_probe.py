import os
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TOPIC = "欧阳修 醉翁亭记 历史研究"


def main() -> None:
  topic = os.getenv("CNKI_TOPIC", DEFAULT_TOPIC)
  script_path = os.path.join(BASE_DIR, "research_pipeline.py")
  subprocess.run([sys.executable, script_path, topic], check=True, cwd=BASE_DIR)


if __name__ == "__main__":
  main()
