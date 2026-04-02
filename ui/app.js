const state = {
  activeRunId: "",
  focusRunId: "",
  focusRunDir: "",
  logCursor: null,
  pollingHandle: null
};

const elements = {
  serviceStatus: document.getElementById("serviceStatus"),
  activeRunText: document.getElementById("activeRunText"),
  topicInput: document.getElementById("topicInput"),
  downloadLimitInput: document.getElementById("downloadLimitInput"),
  modeSelect: document.getElementById("modeSelect"),
  resumeRunDirInput: document.getElementById("resumeRunDirInput"),
  preflightBtn: document.getElementById("preflightBtn"),
  startRunBtn: document.getElementById("startRunBtn"),
  resumeLatestBtn: document.getElementById("resumeLatestBtn"),
  resumeCustomBtn: document.getElementById("resumeCustomBtn"),
  continueBtn: document.getElementById("continueBtn"),
  stopBtn: document.getElementById("stopBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  actionMessage: document.getElementById("actionMessage"),
  stageText: document.getElementById("stageText"),
  stageHint: document.getElementById("stageHint"),
  runDirName: document.getElementById("runDirName"),
  updatedAtText: document.getElementById("updatedAtText"),
  processText: document.getElementById("processText"),
  processHint: document.getElementById("processHint"),
  preflightSummary: document.getElementById("preflightSummary"),
  preflightList: document.getElementById("preflightList"),
  fileList: document.getElementById("fileList"),
  previewTitle: document.getElementById("previewTitle"),
  previewBox: document.getElementById("previewBox"),
  logMeta: document.getElementById("logMeta"),
  logBox: document.getElementById("logBox")
};

function setMessage(message, isError = false) {
  elements.actionMessage.textContent = message;
  elements.actionMessage.classList.toggle("error", Boolean(isError));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload && payload.error ? payload.error : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function formatDate(value) {
  if (!value) return "未知";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatPathTail(value) {
  const text = String(value || "").trim();
  if (!text) return "暂无";
  const parts = text.split(/[\\/]/g).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

function appendLog(text) {
  if (!text) return;
  if (elements.logBox.textContent === "暂无日志。") {
    elements.logBox.textContent = "";
  }
  elements.logBox.textContent += text;
  if (!text.endsWith("\n")) {
    elements.logBox.textContent += "\n";
  }
  elements.logBox.scrollTop = elements.logBox.scrollHeight;
}

function replacePreview(title, content) {
  elements.previewTitle.textContent = title || "暂无预览";
  elements.previewBox.textContent = content || "暂无内容。";
}

function renderHealth(payload) {
  elements.serviceStatus.textContent = payload.ok ? "在线" : "异常";
  const activeRun = payload.activeRun || null;
  state.activeRunId = activeRun && activeRun.runId ? activeRun.runId : "";
  if (state.activeRunId && !state.focusRunId) {
    state.focusRunId = state.activeRunId;
    state.logCursor = null;
  }
  elements.activeRunText.textContent = activeRun && activeRun.runId ? activeRun.runId : "无";
}

function renderPreflight(payload) {
  elements.preflightSummary.textContent = payload.ready ? "通过" : "未通过";
  elements.preflightSummary.className = `badge ${payload.ready ? "badge-good" : "badge-bad"}`;
  elements.preflightList.innerHTML = "";

  for (const check of payload.checks || []) {
    const item = document.createElement("div");
    item.className = `check-item ${check.ok ? "check-good" : check.required ? "check-bad" : "check-warn"}`;
    const title = document.createElement("strong");
    title.textContent = `${check.key}${check.required ? "" : "（可选）"}`;
    const message = document.createElement("p");
    message.textContent = check.message || "";
    item.appendChild(title);
    item.appendChild(message);
    elements.preflightList.appendChild(item);
  }
}

function statusSnapshot(payload) {
  if (!payload) return null;
  const manager = payload.manager || null;
  const runStatus = payload.runStatus || {};
  const pipelineState = payload.pipelineState || {};
  const pipelineResult = payload.pipelineResult || {};
  const stage = runStatus.stage || pipelineState.stage || manager?.stage || "未开始";
  const runDir = payload.runDir || manager?.runDir || manager?.requestedRunDir || "";
  const processState = manager
    ? `${manager.processState || "unknown"}${manager.processRunning ? " / running" : ""}`
    : "无活动进程";
  const selectedCount = Array.isArray(pipelineState.selectedTitles)
    ? pipelineState.selectedTitles.length
    : Array.isArray(pipelineResult.selectedTitles)
      ? pipelineResult.selectedTitles.length
      : 0;

  return {
    stage,
    runDir,
    processState,
    updatedAt: runStatus.updated_at || pipelineState.updatedAt || manager?.updatedAt || "",
    hint:
      runStatus.error ||
      pipelineState.lastError ||
      (selectedCount ? `已选 ${selectedCount} 篇候选论文。` : "等待下一步推进。")
  };
}

function renderFiles(payload) {
  elements.fileList.innerHTML = "";
  for (const entry of payload.keyFiles || []) {
    const item = document.createElement("div");
    item.className = "file-item";

    const textWrap = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = entry.label;
    const meta = document.createElement("p");
    meta.textContent = `${entry.exists ? "存在" : "缺失"} | ${entry.path || ""}`;
    textWrap.appendChild(label);
    textWrap.appendChild(meta);

    item.appendChild(textWrap);

    if (entry.exists && entry.kind !== "directory") {
      const previewBtn = document.createElement("button");
      previewBtn.className = "btn btn-small btn-secondary";
      previewBtn.textContent = "预览";
      previewBtn.addEventListener("click", async () => {
        try {
          const payload = await api(`/api/file?path=${encodeURIComponent(entry.path)}`);
          replacePreview(entry.label, payload.content || "");
          setMessage(`已加载文件：${entry.label}`);
        } catch (error) {
          setMessage(error.message || String(error || "预览失败"), true);
        }
      });
      item.appendChild(previewBtn);
    }

    elements.fileList.appendChild(item);
  }
}

function renderSnapshot(payload) {
  const snapshot = statusSnapshot(payload);
  if (!snapshot) {
    return;
  }
  elements.stageText.textContent = snapshot.stage;
  elements.stageHint.textContent = snapshot.hint || "等待下一步推进。";
  elements.runDirName.textContent = snapshot.runDir ? formatPathTail(snapshot.runDir) : "暂无";
  elements.updatedAtText.textContent = snapshot.runDir
    ? `${snapshot.runDir}\n最近更新时间：${formatDate(snapshot.updatedAt)}`
    : "等待首次运行";
  elements.processText.textContent = snapshot.processState;
  elements.processHint.textContent = payload.manager && payload.manager.command
    ? payload.manager.command
    : "当前没有活动子进程。";

  if (payload.reportPreview && payload.reportPreview.content) {
    replacePreview(
      payload.reportPreview.path ? formatPathTail(payload.reportPreview.path) : "运行摘要",
      payload.reportPreview.content
    );
  }

  renderFiles(payload);
}

async function refreshLog() {
  if (!state.focusRunId) {
    elements.logMeta.textContent = "没有选中的运行";
    return;
  }

  const query = state.logCursor === null ? "" : `?cursor=${state.logCursor}`;
  const payload = await api(`/api/runs/${encodeURIComponent(state.focusRunId)}/logs${query}`);
  state.logCursor = payload.cursor;
  elements.logMeta.textContent = payload.logPath ? formatPathTail(payload.logPath) : "暂无日志文件";
  appendLog(payload.text || "");
}

async function refreshStatus() {
  const health = await api("/api/health");
  renderHealth(health);

  let snapshot = null;
  if (state.activeRunId) {
    state.focusRunId = state.activeRunId;
    snapshot = await api(`/api/runs/${encodeURIComponent(state.activeRunId)}/status`);
  } else if (state.focusRunId) {
    snapshot = await api(`/api/runs/${encodeURIComponent(state.focusRunId)}/status`);
  } else {
    snapshot = await api("/api/runs/latest");
    if (snapshot && snapshot.runId) {
      state.focusRunId = snapshot.runId;
    } else if (snapshot && snapshot.runDir) {
      state.focusRunDir = snapshot.runDir;
    }
  }

  if (snapshot) {
    renderSnapshot(snapshot);
    if (snapshot.manager && snapshot.manager.runId && snapshot.manager.runId !== state.focusRunId) {
      state.focusRunId = snapshot.manager.runId;
      state.logCursor = null;
      elements.logBox.textContent = "暂无日志。";
    }
  }

  if (state.focusRunId) {
    await refreshLog();
  }
}

async function runPreflight() {
  const payload = await api("/api/preflight");
  renderPreflight(payload);
  setMessage(payload.ready ? "预检通过，可以启动任务。" : "预检未通过，请先修复红色项。", !payload.ready);
}

async function startFreshRun() {
  const topic = elements.topicInput.value.trim();
  if (!topic) {
    throw new Error("请先输入研究主题。");
  }
  const payload = await api("/api/runs/new", {
    method: "POST",
    body: JSON.stringify({
      topic,
      downloadLimit: Number(elements.downloadLimitInput.value || 20),
      mode: elements.modeSelect.value
    })
  });
  state.focusRunId = payload.runId || payload.manager?.runId || "";
  state.logCursor = null;
  elements.logBox.textContent = "暂无日志。";
  setMessage("已启动全新任务。");
  await refreshStatus();
}

async function resumeLatestRun() {
  const latest = await api("/api/runs/latest");
  const runDir = latest.runDir || "";
  if (!runDir) {
    throw new Error("没有找到可恢复的历史运行目录。");
  }
  const payload = await api("/api/runs/resume", {
    method: "POST",
    body: JSON.stringify({
      runDir,
      downloadLimit: Number(elements.downloadLimitInput.value || 20),
      mode: elements.modeSelect.value
    })
  });
  state.focusRunId = payload.runId || payload.manager?.runId || "";
  state.logCursor = null;
  elements.logBox.textContent = "暂无日志。";
  setMessage(`已恢复最近一次运行：${runDir}`);
  await refreshStatus();
}

async function resumeCustomRun() {
  const runDir = elements.resumeRunDirInput.value.trim();
  if (!runDir) {
    throw new Error("请先填写要恢复的运行目录。");
  }
  const payload = await api("/api/runs/resume", {
    method: "POST",
    body: JSON.stringify({
      runDir,
      downloadLimit: Number(elements.downloadLimitInput.value || 20),
      mode: elements.modeSelect.value
    })
  });
  state.focusRunId = payload.runId || payload.manager?.runId || "";
  state.logCursor = null;
  elements.logBox.textContent = "暂无日志。";
  setMessage(`已恢复指定目录：${runDir}`);
  await refreshStatus();
}

async function continueRun() {
  await api("/api/runs/active/continue", { method: "POST" });
  setMessage("已向活动任务发送 continue。");
  await refreshStatus();
}

async function stopRun() {
  await api("/api/runs/active/stop", { method: "POST" });
  setMessage("已停止活动任务。");
  await refreshStatus();
}

function withAction(fn) {
  return async () => {
    try {
      await fn();
    } catch (error) {
      setMessage(error.message || String(error || "操作失败"), true);
    }
  };
}

function bindEvents() {
  elements.preflightBtn.addEventListener("click", withAction(runPreflight));
  elements.startRunBtn.addEventListener("click", withAction(startFreshRun));
  elements.resumeLatestBtn.addEventListener("click", withAction(resumeLatestRun));
  elements.resumeCustomBtn.addEventListener("click", withAction(resumeCustomRun));
  elements.continueBtn.addEventListener("click", withAction(continueRun));
  elements.stopBtn.addEventListener("click", withAction(stopRun));
  elements.refreshBtn.addEventListener("click", withAction(refreshStatus));
}

async function boot() {
  bindEvents();
  try {
    await refreshStatus();
    await runPreflight();
  } catch (error) {
    setMessage(error.message || String(error || "初始化失败"), true);
  }

  state.pollingHandle = window.setInterval(async () => {
    try {
      await refreshStatus();
    } catch (error) {
      setMessage(error.message || String(error || "刷新失败"), true);
    }
  }, 2500);
}

boot();
