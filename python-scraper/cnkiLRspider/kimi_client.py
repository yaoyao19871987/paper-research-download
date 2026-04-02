import ast
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Dict, List, Tuple

PUBLIC_DIR = r"D:\Code\public"
if PUBLIC_DIR not in sys.path:
  sys.path.insert(0, PUBLIC_DIR)

from kimi_shared.vault import SharedSecureVault  # type: ignore
from siliconflow_shared import SILICONFLOW_CHAT_COMPLETIONS_URL, load_siliconflow_token  # type: ignore


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


def _normalize_loose_json(text: str) -> str:
  normalized = text.strip()
  normalized = re.sub(r"^```(?:json)?\s*", "", normalized, flags=re.I)
  normalized = re.sub(r"\s*```$", "", normalized)
  normalized = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_\-]*)(\s*:)", r'\1"\2"\3', normalized)
  normalized = re.sub(r",(\s*[}\]])", r"\1", normalized)
  return normalized


def _extract_json_from_message(message: Dict[str, object]) -> Dict[str, object]:
  content = message.get("content")
  if isinstance(content, list):
    joined = "\n".join(
      item.get("text", "")
      for item in content
      if isinstance(item, dict) and isinstance(item.get("text"), str)
    )
    if joined.strip():
      return _extract_json_block(joined)
  if isinstance(content, str) and content.strip():
    return _extract_json_block(content)

  reasoning = message.get("reasoning_content")
  if isinstance(reasoning, str) and reasoning.strip():
    match = re.search(r"\{.*\}", reasoning, re.S)
    if match:
      return json.loads(match.group(0))

  raise ValueError("Model returned empty content.")


def _env_bool(name: str, default: bool) -> bool:
  value = str(os.getenv(name, "") or "").strip().lower()
  if not value:
    return default
  return value in {"1", "true", "yes", "on"}


class OpenAICompatibleJsonClient:
  def __init__(
    self,
    *,
    name: str,
    token: str,
    api_url: str,
    model: str,
    timeout_seconds: int = 120,
    retry_delays: List[int] | None = None,
    extra_headers: Dict[str, str] | None = None,
  ) -> None:
    if not token:
      raise RuntimeError(f"{name} credential is unavailable from the shared encrypted vault.")
    self.name = name
    self.token = token
    self.api_url = api_url
    self.model = model
    self.timeout_seconds = timeout_seconds
    self.retry_delays = retry_delays or [2, 4, 8]
    self.extra_headers = extra_headers or {}
    self.debug_dir = os.getenv(
      "KIMI_DEBUG_DIR",
      os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs", "_llm_debug"),
    )

  def _stream_preview(self, text: str, limit: int = 120) -> str:
    compact = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(compact) <= limit:
      return compact
    return compact[-limit:]

  def _log_stream_event(self, request_label: str, message: str) -> None:
    label = request_label or self.name
    print(f"[{self.name} stream][{label}] {message}", flush=True)

  def build_payload(self, system_prompt: str, user_prompt: str) -> Dict[str, object]:
    return {
      "model": self.model,
      "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
      ],
      "temperature": 0.1,
      "max_tokens": 2200,
      "stream": False,
      "response_format": {"type": "json_object"},
    }

  def _post_json(self, payload: Dict[str, object], request_label: str = "") -> Dict[str, object]:
    if payload.get("stream"):
      return self._stream_json(payload, request_label=request_label)

    request = urllib.request.Request(
      url=self.api_url,
      data=json.dumps(payload).encode("utf-8"),
      headers={
        "Authorization": f"Bearer {self.token}",
        "Content-Type": "application/json",
        **self.extra_headers,
      },
      method="POST",
    )
    with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
      return json.loads(response.read().decode("utf-8"))

  def _stream_json(self, payload: Dict[str, object], request_label: str = "") -> Dict[str, object]:
    request = urllib.request.Request(
      url=self.api_url,
      data=json.dumps(payload).encode("utf-8"),
      headers={
        "Authorization": f"Bearer {self.token}",
        "Content-Type": "application/json",
        **self.extra_headers,
      },
      method="POST",
    )
    full_content = []
    full_reasoning = []
    system_fingerprint = ""
    finish_reason = "stop"
    started_at = time.time()
    last_report_at = started_at
    last_reported_chars = 0
    report_every_seconds = float(os.getenv("LLM_STREAM_LOG_INTERVAL_SECONDS", "1.0"))
    report_every_chars = int(os.getenv("LLM_STREAM_LOG_INTERVAL_CHARS", "160"))
    saw_any_delta = False

    self._log_stream_event(
      request_label,
      f"started model={payload.get('model', self.model)} stream=true",
    )

    with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
      for line in response:
        line_str = line.decode("utf-8").strip()
        if not line_str.startswith("data:"):
          continue
        data_body = line_str[len("data:") :].strip()
        if data_body == "[DONE]":
          break
        try:
          chunk = json.loads(data_body)
          if "system_fingerprint" in chunk:
            system_fingerprint = chunk["system_fingerprint"]
          choices = chunk.get("choices", [])
          if choices:
            delta = choices[0].get("delta", {})
            if "content" in delta and delta["content"]:
              full_content.append(delta["content"])
              saw_any_delta = True
            if "reasoning_content" in delta and delta["reasoning_content"]:
              full_reasoning.append(delta["reasoning_content"])
              saw_any_delta = True
            if choices[0].get("finish_reason"):
              finish_reason = choices[0]["finish_reason"]
        except json.JSONDecodeError:
          continue

        total_chars = sum(len(part) for part in full_content) + sum(len(part) for part in full_reasoning)
        now = time.time()
        should_report = False
        if saw_any_delta and last_reported_chars == 0:
          should_report = True
        elif total_chars - last_reported_chars >= report_every_chars:
          should_report = True
        elif now - last_report_at >= report_every_seconds and total_chars > last_reported_chars:
          should_report = True

        if should_report:
          content_preview = self._stream_preview("".join(full_content))
          reasoning_preview = self._stream_preview("".join(full_reasoning))
          parts = [
            f"content_chars={sum(len(part) for part in full_content)}",
            f"reasoning_chars={sum(len(part) for part in full_reasoning)}",
          ]
          if content_preview:
            parts.append(f"content_tail={content_preview}")
          elif reasoning_preview:
            parts.append(f"reasoning_tail={reasoning_preview}")
          self._log_stream_event(request_label, " | ".join(parts))
          last_report_at = now
          last_reported_chars = total_chars

    # Synthesize a response that matches the non-stream format
    self._log_stream_event(
      request_label,
      (
        f"completed finish_reason={finish_reason} "
        f"content_chars={sum(len(part) for part in full_content)} "
        f"reasoning_chars={sum(len(part) for part in full_reasoning)} "
        f"elapsed={time.time() - started_at:.1f}s"
      ),
    )
    return {
      "choices": [
        {
          "message": {
            "role": "assistant",
            "content": "".join(full_content),
            "reasoning_content": "".join(full_reasoning),
          },
          "finish_reason": finish_reason,
        }
      ],
      "system_fingerprint": system_fingerprint,
    }

  def _write_debug_response(self, result: Dict[str, object]) -> None:
    os.makedirs(self.debug_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(self.debug_dir, f"{self.name.lower()}-{stamp}.json")
    with open(path, "w", encoding="utf-8") as handle:
      json.dump(result, handle, ensure_ascii=False, indent=2)

  def call_json(
    self,
    system_prompt: str,
    user_prompt: str,
    pause_after_seconds: float = 0.0,
    request_label: str = "",
  ) -> Dict[str, object]:
    payload = self.build_payload(system_prompt, user_prompt)

    last_error: Exception | None = None
    max_tokens_cap = int(os.getenv("KIMI_MAX_TOKENS_CAP", "12000"))
    for delay in self.retry_delays:
      result = None
      try:
        result = self._post_json(payload, request_label=request_label)
        self._write_debug_response(result)
        parsed = _extract_json_from_message(result["choices"][0]["message"])
        if pause_after_seconds > 0:
          time.sleep(pause_after_seconds)
        return parsed
      except urllib.error.HTTPError as exc:
        last_error = exc
        # If 4xx, likely streaming or JSON mode not supported by this specific model/endpoint
        if 400 <= exc.code < 500 and payload.get("stream"):
          self._log_stream_event(
            request_label,
            f"stream rejected by endpoint with HTTP {exc.code}, retrying with stream=false",
          )
          payload["stream"] = False
        time.sleep(delay)
      except Exception as exc:
        last_error = exc
        self._log_stream_event(request_label, f"request attempt failed: {exc}")
        finish_reason = ""
        try:
          if isinstance(result, dict) and "choices" in result:
            finish_reason = str(result["choices"][0].get("finish_reason", "")).lower()
        except Exception:
          pass
        if finish_reason == "length":
          current_max = int(payload.get("max_tokens", 0) or 0)
          if current_max and current_max < max_tokens_cap:
            payload["max_tokens"] = min(current_max * 2, max_tokens_cap)
        time.sleep(delay)

    if last_error is None:
      raise RuntimeError(f"{self.name} request failed without a captured exception.")
    raise RuntimeError(f"{self.name} request failed after retries: {last_error}") from last_error


class KimiClient(OpenAICompatibleJsonClient):
  def __init__(self) -> None:
    secrets_dir = os.path.join(PUBLIC_DIR, "secrets")
    keys_dir = os.path.join(PUBLIC_DIR, "keys")
    vault = SharedSecureVault("kimi", secrets_dir=secrets_dir, keys_dir=keys_dir)
    token = vault.load()
    super().__init__(
      name="Kimi",
      token=token or "",
      api_url=os.getenv("KIMI_OPENAI_URL", "https://api.kimi.com/coding/v1/chat/completions"),
      model=os.getenv("KIMI_MODEL", "kimi-for-coding"),
      timeout_seconds=int(os.getenv("KIMI_TIMEOUT_SECONDS", "120")),
      extra_headers={
        "User-Agent": os.getenv("KIMI_USER_AGENT", "claude-code/1.0"),
        "X-Client-Name": os.getenv("KIMI_CLIENT_NAME", "claude-code"),
      },
    )

  def build_payload(self, system_prompt: str, user_prompt: str) -> Dict[str, object]:
    return {
      "model": self.model,
      "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
      ],
      "temperature": 0.1,
      "max_tokens": int(os.getenv("KIMI_MAX_TOKENS", "8192")),
      "stream": _env_bool("KIMI_STREAM", True),
    }


class SiliconFlowClient(OpenAICompatibleJsonClient):
  def __init__(self) -> None:
    token = load_siliconflow_token()
    super().__init__(
      name="SiliconFlow",
      token=token or "",
      api_url=os.getenv("SILICONFLOW_OPENAI_URL", SILICONFLOW_CHAT_COMPLETIONS_URL),
      model=os.getenv("SILICONFLOW_MODEL", "deepseek-ai/DeepSeek-V3.2"),
      timeout_seconds=int(os.getenv("SILICONFLOW_TIMEOUT_SECONDS", "120")),
    )

  def build_payload(self, system_prompt: str, user_prompt: str) -> Dict[str, object]:
    return {
      "model": self.model,
      "messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
      ],
      "temperature": 0.1,
      "max_tokens": 2200,
      "stream": _env_bool("SILICONFLOW_STREAM", True),
      "response_format": {"type": "json_object"},
    }


def build_round1_strategy_prompts(topic: str) -> Tuple[str, str]:
  system_prompt = (
    "You are a CNKI historical-research strategist. Return strict JSON only. "
    "Design precise CNKI professional-search formulas for high-quality literature retrieval."
  )
  user_prompt = f"""
Topic: {topic}

Return JSON with this exact shape:
{{
  "topic": "{topic}",
  "query_type": "professional",
  "core_query": {{
    "name": "core",
    "expression": "TKA=('A' * 'B') * ('C' + 'D') - ('noise1' + 'noise2')",
    "field_mode": "篇关摘",
    "reason": "..."
  }},
  "alternate_queries": [
    {{
      "name": "subtopic_name",
      "expression": "TKA=('...') * ('...') - ('...')",
      "field_mode": "篇关摘",
      "reason": "..."
    }}
  ],
  "exclude_terms": ["..."],
  "priority_aspects": ["..."],
  "noise_directions": ["..."],
  "quality_hints": ["Prefer CSSCI/core/high-value journals when relevant."],
  "notes": "..."
}}

Rules:
- Use CNKI professional-search syntax.
- Default to TKA for 篇关摘.
- Focus on historical, political, social, institutional, regional, textual transmission, and reception dimensions when relevant.
- Explicitly exclude classroom-teaching, lesson-plan, pedagogy-only, and pure language-analysis noise unless tightly tied to historical research.
- Keep formulas precise and not overly long.
- Keep output concise: 1 core query, at most 6 alternate queries, short reasons, short notes.
"""
  return system_prompt, user_prompt


def build_batch_map_prompts(topic: str, batch_rows: List[Dict[str, str]]) -> Tuple[str, str]:
  system_prompt = (
    "You classify CNKI paper abstracts for serious research support. "
    "Return strict JSON only."
  )
  user_prompt = json.dumps(
    {
      "topic": topic,
      "task": (
        "For each paper, decide whether it helps the user's historical or research-oriented writing. "
        "Label as history, teaching, mixed, or unknown. Give a relevance_score between 0 and 1."
      ),
      "schema": {
        "papers": [
          {
            "paper_id": "string",
            "research_object": "string",
            "research_perspective": "string",
            "core_claim": "string",
            "material_type": "string",
            "label": "history|teaching|mixed|unknown",
            "is_worth_keeping": True,
            "keep_reason": "string",
            "relevance_score": 0.0,
          }
        ]
      },
      "papers": batch_rows,
    },
    ensure_ascii=False,
  )
  return system_prompt, user_prompt


def build_reduce_prompts(topic: str, strategy_round1: Dict[str, object], map_batches: List[Dict[str, object]]) -> Tuple[str, str]:
  system_prompt = (
    "You synthesize batch-level CNKI abstract labels into a second-round search strategy and research summary. "
    "Return strict JSON only."
  )
  user_prompt = json.dumps(
    {
      "topic": topic,
      "round1_strategy": strategy_round1,
      "batch_summaries": map_batches,
      "schema": {
        "hotspots": ["..."],
        "overrepresented_directions": ["..."],
        "underexplored_directions": ["..."],
        "recommended_queries": [
          {
            "name": "string",
            "expression": "TKA=('...') * ('...') - ('...')",
            "field_mode": "篇关摘",
            "reason": "string",
          }
        ],
        "writing_value": "string",
        "analysis_summary_markdown": "markdown string",
      },
    },
    ensure_ascii=False,
  )
  return system_prompt, user_prompt


def build_consensus_prompts(kind: str, topic: str, kimi_output: Dict[str, object], silicon_output: Dict[str, object]) -> Tuple[str, str]:
  system_prompt = (
    "You are chairing a research expert meeting between Kimi and SiliconFlow. "
    "Merge the strongest parts of both proposals into one strict-JSON consensus."
  )
  user_prompt = json.dumps(
    {
      "kind": kind,
      "topic": topic,
      "kimi_proposal": kimi_output,
      "siliconflow_proposal": silicon_output,
      "task": (
        "Produce one final consensus JSON. Prefer precise CNKI formulas, stronger exclusion of noise, "
        "clearer historical sub-directions, and actionable next-step search advice. "
        "Keep the final JSON concise."
      ),
    },
    ensure_ascii=False,
  )
  return system_prompt, user_prompt


def build_critique_prompts(kind: str, topic: str, primary_output: Dict[str, object]) -> Tuple[str, str]:
  system_prompt = (
    "You are a critical research reviewer. Read the main expert's CNKI strategy and critique it. "
    "Return strict JSON only."
  )
  user_prompt = json.dumps(
    {
      "kind": kind,
      "topic": topic,
      "primary_output": primary_output,
      "schema": {
        "strengths": ["..."],
        "weaknesses": ["..."],
        "missing_directions": ["..."],
        "noise_risks": ["..."],
        "quality_risks": ["..."],
        "revision_suggestions": ["..."],
      },
      "task": (
        "Critique the strategy. Focus on missing historical sub-directions, overly broad formulas, "
        "poor exclusion rules, and whether the search may miss high-quality core journals."
      ),
    },
    ensure_ascii=False,
  )
  return system_prompt, user_prompt


def build_revision_prompts(kind: str, topic: str, primary_output: Dict[str, object], critique_output: Dict[str, object]) -> Tuple[str, str]:
  system_prompt = (
    "You are the lead research strategist revising your CNKI plan after critique. "
    "Return strict JSON only."
  )
  user_prompt = json.dumps(
    {
      "kind": kind,
      "topic": topic,
      "original_output": primary_output,
      "critique": critique_output,
      "task": (
        "Revise the original strategy using the critique. Produce one final consensus JSON only. "
        "Keep the same output schema as the original strategy type. "
        "Be concise: at most 6 alternate_queries, each reason under 40 Chinese characters, notes under 180 Chinese characters."
      ),
    },
    ensure_ascii=False,
  )
  return system_prompt, user_prompt


class ExpertDiscussionEngine:
  def __init__(self) -> None:
    self.kimi = KimiClient()
    self.silicon = SiliconFlowClient()
    self.meeting_pause_seconds = float(os.getenv("EXPERT_MEETING_PAUSE_SECONDS", "1.5"))

  def _run_discussion_round(self, *, round_no: int, kind: str, topic: str, kimi_initial: Dict[str, object]) -> Dict[str, object]:
    transcript: Dict[str, object] = {
      "kimi_initial": kimi_initial,
      "deepseek_critique": {},
      "kimi_final": kimi_initial,
      "consensus_source": "kimi_initial",
    }

    critique_system, critique_user = build_critique_prompts(
      kind=kind,
      topic=topic,
      primary_output=kimi_initial,
    )
    try:
      silicon_critique = self.silicon.call_json(
        critique_system,
        critique_user,
        pause_after_seconds=self.meeting_pause_seconds,
        request_label=f"{kind}:silicon_critique",
      )
      transcript["deepseek_critique"] = silicon_critique
    except Exception as exc:
      critique_error = f"SiliconFlow critique failed: {exc}"
      print(
        f"[ExpertDiscussion] SiliconFlow critique failed for round {round_no} ({exc}). "
        "Falling back to Kimi's initial strategy."
      )
      transcript["deepseek_critique"] = {"error": critique_error}
      transcript["deepseek_critique_error"] = critique_error
      transcript["consensus_source"] = "kimi_initial_fallback_after_siliconflow_failure"
      return {
        "consensus": kimi_initial,
        "transcript": transcript,
      }

    revision_system, revision_user = build_revision_prompts(
      kind=kind,
      topic=topic,
      primary_output=kimi_initial,
      critique_output=silicon_critique,
    )
    try:
      kimi_final = self.kimi.call_json(
        revision_system,
        revision_user,
        pause_after_seconds=self.meeting_pause_seconds,
        request_label=f"{kind}:kimi_revision",
      )
      transcript["kimi_final"] = kimi_final
      transcript["consensus_source"] = "kimi_revision"
      return {
        "consensus": kimi_final,
        "transcript": transcript,
      }
    except Exception as exc:
      revision_error = f"Kimi revision failed: {exc}"
      print(
        f"[ExpertDiscussion] Kimi final revision failed for round {round_no} ({exc}). "
        "Keeping Kimi's initial strategy and preserving SiliconFlow critique."
      )
      transcript["kimi_revision_error"] = revision_error
      transcript["consensus_source"] = "kimi_initial_fallback_after_kimi_revision_failure"
      return {
        "consensus": kimi_initial,
        "transcript": transcript,
      }

  def discuss_round1(self, topic: str) -> Dict[str, object]:
    system_prompt, user_prompt = build_round1_strategy_prompts(topic)
    kimi_initial = self.kimi.call_json(
      system_prompt,
      user_prompt,
      pause_after_seconds=self.meeting_pause_seconds,
      request_label="round1:kimi_initial",
    )
    return self._run_discussion_round(
      round_no=1,
      kind="round1_strategy",
      topic=topic,
      kimi_initial=kimi_initial,
    )

  def discuss_round2(self, topic: str, strategy_round1: Dict[str, object], map_batches: List[Dict[str, object]]) -> Dict[str, object]:
    system_prompt, user_prompt = build_reduce_prompts(topic, strategy_round1, map_batches)
    kimi_initial = self.kimi.call_json(
      system_prompt,
      user_prompt,
      pause_after_seconds=self.meeting_pause_seconds,
      request_label="round2:kimi_initial",
    )
    return self._run_discussion_round(
      round_no=2,
      kind="round2_strategy",
      topic=topic,
      kimi_initial=kimi_initial,
    )
