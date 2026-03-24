import sys
sys.path.insert(0, r'D:\Code\paper-download\Chinese paper search\cnkiLRspider')
from kimi_client import SiliconFlowClient
c = SiliconFlowClient()
print("Token loaded:", bool(c.token))
print("Model:", c.model)
try:
    res = c.call_json("You are a test agent. Return strict JSON only.", '{"test": 1}')
    print("Result:", res)
except Exception as e:
    print("Error:", e)
