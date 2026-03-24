import os
import sys
import json

# Add current dir to path to import kimi_client
sys.path.append(os.path.join(os.getcwd(), "python-scraper", "cnkiLRspider"))

from kimi_client import KimiClient, SiliconFlowClient

def test_kimi():
    print("Testing Kimi...")
    try:
        client = KimiClient()
        # Ensure streaming is off for test
        os.environ["KIMI_STREAM"] = "false"
        result = client.call_json("You are a helpful assistant. Return JSON only.", "Say hello in JSON format: {\"message\": \"hello\"}")
        print("Kimi result:", json.dumps(result))
        return True
    except Exception as e:
        print("Kimi failed:", e)
        return False

def test_siliconflow():
    print("\nTesting SiliconFlow...")
    try:
        client = SiliconFlowClient()
        # Ensure streaming is on for test
        os.environ["SILICONFLOW_STREAM"] = "true"
        result = client.call_json("You are a helpful assistant. Return JSON only.", "Say hello in JSON format: {\"message\": \"hello\"}")
        print("SiliconFlow result:", json.dumps(result))
        return True
    except Exception as e:
        print("SiliconFlow failed:", e)
        return False

if __name__ == "__main__":
    k_ok = test_kimi()
    s_ok = test_siliconflow()
    if not k_ok or not s_ok:
        sys.exit(1)
