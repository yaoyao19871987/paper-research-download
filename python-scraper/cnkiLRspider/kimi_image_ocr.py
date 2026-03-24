import argparse
import ast
import base64
import json
import mimetypes
import os
import re
import sys
import time
import urllib.request
from typing import Dict, List

PUBLIC_DIR = r"D:\Code\public"
if PUBLIC_DIR not in sys.path:
    sys.path.insert(0, PUBLIC_DIR)

from kimi_shared.vault import SharedSecureVault  # type: ignore


def _normalize_loose_json(text: str) -> str:
    normalized = text.strip()
    normalized = re.sub(r"^```(?:json)?\s*", "", normalized, flags=re.I)
    normalized = re.sub(r"\s*```$", "", normalized)
    normalized = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_\-]*)(\s*:)", r'\1"\2"\3', normalized)
    normalized = re.sub(r",(\s*[}\]])", r"\1", normalized)
    return normalized


def _extract_json_block(text: str) -> Dict[str, object]:
    text = (text or "").strip()
    if not text:
        raise ValueError("Model returned empty content.")

    candidates: List[str] = [text]
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        candidates.append(match.group(0))

    last_error: Exception | None = None
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as exc:
            last_error = exc

        normalized = _normalize_loose_json(candidate)
        if normalized != candidate:
            try:
                return json.loads(normalized)
            except json.JSONDecodeError as exc:
                last_error = exc

        python_like = re.sub(r"\btrue\b", "True", normalized, flags=re.I)
        python_like = re.sub(r"\bfalse\b", "False", python_like, flags=re.I)
        python_like = re.sub(r"\bnull\b", "None", python_like, flags=re.I)
        try:
            parsed = ast.literal_eval(python_like)
            if isinstance(parsed, dict):
                return parsed
        except (SyntaxError, ValueError):
            continue

    if last_error is not None:
        raise last_error
    raise ValueError("Could not extract JSON content.")


def _extract_alnum_candidate(text: str) -> str:
    text = text or ""
    patterns = [
        r'"captcha"\s*:\s*"([A-Za-z0-9]{4,8})"',
        r"'captcha'\s*:\s*'([A-Za-z0-9]{4,8})'",
        r"captcha\s*[:=]\s*([A-Za-z0-9]{4,8})",
        r'["\']([A-Za-z0-9]{4,6})["\']',
    ]
    for pattern in patterns:
        matches = re.findall(pattern, text, flags=re.I)
        if matches:
            return matches[-1]
    return ""


def _load_kimi_token() -> str:
    secrets_dir = os.path.join(PUBLIC_DIR, "secrets")
    keys_dir = os.path.join(PUBLIC_DIR, "keys")
    vault = SharedSecureVault("kimi", secrets_dir=secrets_dir, keys_dir=keys_dir)
    token = vault.load() or ""
    if not token:
        raise RuntimeError("Kimi credential is unavailable from the shared encrypted vault.")
    return token


def _image_to_data_url(image_path: str) -> str:
    mime_type = mimetypes.guess_type(image_path)[0] or "image/png"
    with open(image_path, "rb") as handle:
        raw = handle.read()
    encoded = base64.b64encode(raw).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _post_json(api_url: str, token: str, payload: Dict[str, object], timeout_seconds: int) -> Dict[str, object]:
    request = urllib.request.Request(
        url=api_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": os.getenv("KIMI_USER_AGENT", "claude-code/1.0"),
            "X-Client-Name": os.getenv("KIMI_CLIENT_NAME", "claude-code"),
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        return json.loads(response.read().decode("utf-8"))


def _extract_message_text(result: Dict[str, object]) -> str:
    choices = result.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("Kimi response does not contain choices.")
    message = choices[0].get("message", {})
    if not isinstance(message, dict):
        raise ValueError("Kimi response message is invalid.")
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        joined = "\n".join(
            item.get("text", "")
            for item in content
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        ).strip()
        if joined:
            return joined
    reasoning = message.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning
    raise ValueError("Kimi response content is empty.")


def solve_captcha(image_path: str) -> Dict[str, str]:
    token = _load_kimi_token()
    api_url = os.getenv("KIMI_VISION_OPENAI_URL", os.getenv("KIMI_OPENAI_URL", "https://api.kimi.com/coding/v1/chat/completions"))
    model = os.getenv("KIMI_VISION_MODEL", os.getenv("KIMI_MODEL", "kimi-for-coding"))
    timeout_seconds = int(os.getenv("KIMI_VISION_TIMEOUT_SECONDS", "120"))
    data_url = _image_to_data_url(image_path)

    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You read simple login captchas. "
                    "Return strict JSON only in the form {\"captcha\":\"...\"}. "
                    "Extract only the letters or digits the user must type. "
                    "Do not add explanation or extra fields."
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": data_url,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            "Read the captcha image and return the most likely letters or digits. "
                            "If uncertain, still return your best guess as JSON."
                        ),
                    },
                ],
            },
        ],
        "temperature": 0,
        "max_tokens": int(os.getenv("KIMI_VISION_MAX_TOKENS", "1200")),
        "stream": False,
    }

    retry_delays = [2, 4, 8]
    last_error: Exception | None = None
    for delay in retry_delays:
        try:
            result = _post_json(api_url, token, payload, timeout_seconds)
            text = _extract_message_text(result)
            captcha = ""
            try:
                parsed = _extract_json_block(text)
                captcha = str(parsed.get("captcha", "")).strip()
            except Exception:
                captcha = ""
            captcha = re.sub(r"\s+", "", captcha)
            captcha = re.sub(r"[^0-9A-Za-z]", "", captcha)
            if not captcha:
                captcha = _extract_alnum_candidate(text)
            if not captcha:
                raise ValueError("Captcha text is empty after normalization.")
            return {"captcha": captcha}
        except Exception as exc:
            last_error = exc
            time.sleep(delay)

    if last_error is None:
        raise RuntimeError("Kimi captcha OCR failed without a captured exception.")
    raise RuntimeError(f"Kimi captcha OCR failed after retries: {last_error}") from last_error


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Solve a simple image captcha with Kimi vision.")
    parser.add_argument("image_path", help="Path to captcha image")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = solve_captcha(args.image_path)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
