const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { parse } = require("csv-parse/sync");
const { ensureDir, timestampString } = require("./common");

const ROOT_DIR = path.resolve(__dirname, "..");
const PIPELINE_RUNNER = path.join(__dirname, "pipeline-runner.js");
const WORK_REPORT_ROOT = path.join(ROOT_DIR, "work-reports");
const PIPELINE_RUN_MARKER = "__PIPELINE_RUN__";
const PIPELINE_STAGE_MARKER = "__PIPELINE_STAGE__";
const PIPELINE_EVENT_MARKER = "__PIPELINE_EVENT__";

function resolveSearchDir() {
  const envDir = process.env.CNKI_SEARCH_DIR ? path.resolve(process.env.CNKI_SEARCH_DIR) : "";
  const candidates = [
    envDir,
    path.join(ROOT_DIR, "Chinese paper search", "cnkiLRspider"),
    path.join(ROOT_DIR, "python-scraper", "cnkiLRspider")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "research_pipeline.py"))) {
      return candidate;
    }
  }

  throw new Error("Could not locate cnkiLRspider for observed run.");
}

const SEARCH_DIR = resolveSearchDir();

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readCsvRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parse(fs.readFileSync(filePath, "utf8"), {
    bom: true,
    columns: true,
    skip_empty_lines: true
  });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, "utf8");
}

function slugifyTopic(topic) {
  return String(topic || "")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "topic";
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes || hours) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function parseArgs(argv) {
  const options = {
    topic: "",
    topicFile: "",
    downloadLimit: 8,
    searchRetries: 3,
    downloadRetries: 3,
    stallThresholdMs: 120000,
    resumeRun: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--topic") {
      options.topic = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--topic-file") {
      options.topicFile = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--download-limit") {
      options.downloadLimit = Number(argv[index + 1] || options.downloadLimit);
      index += 1;
      continue;
    }
    if (token === "--search-retries") {
      options.searchRetries = Number(argv[index + 1] || options.searchRetries);
      index += 1;
      continue;
    }
    if (token === "--download-retries") {
      options.downloadRetries = Number(argv[index + 1] || options.downloadRetries);
      index += 1;
      continue;
    }
    if (token === "--stall-threshold-ms") {
      options.stallThresholdMs = Number(argv[index + 1] || options.stallThresholdMs);
      index += 1;
      continue;
    }
    if (token === "--resume-run") {
      options.resumeRun = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (!token.startsWith("--") && !options.topic) {
      options.topic = token;
    }
  }

  if (!Number.isFinite(options.downloadLimit) || options.downloadLimit <= 0) {
    options.downloadLimit = 8;
  }
  if (!Number.isFinite(options.searchRetries) || options.searchRetries <= 0) {
    options.searchRetries = 3;
  }
  if (!Number.isFinite(options.downloadRetries) || options.downloadRetries <= 0) {
    options.downloadRetries = 3;
  }
  if (!Number.isFinite(options.stallThresholdMs) || options.stallThresholdMs < 30000) {
    options.stallThresholdMs = 120000;
  }
  return options;
}

function streamLines(stream, callback) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      callback(line);
    }
  });
  stream.on("end", () => {
    if (buffer) {
      callback(buffer);
      buffer = "";
    }
  });
}

function closeTimedEntry(entry, endMs, extra = {}) {
  if (!entry || entry.endAtMs) {
    return;
  }
  entry.endAtMs = endMs;
  entry.endAt = new Date(endMs).toISOString();
  entry.durationMs = Math.max(0, endMs - entry.startAtMs);
  Object.assign(entry, extra);
}

function buildOptimizationSuggestions(summary) {
  const suggestions = [];
  if (summary.authPauseCount > 0) {
    suggestions.push("预热并复用图书馆登录态，定期刷新 `state/auth.json`，避免下载中途进入认证恢复。");
  }
  if (summary.stallCount > 0) {
    suggestions.push("对长时间无输出的阶段保留浏览器快照与 DOM 导出，便于直接定位是验证码、页面跳转还是结果页渲染变慢。");
  }
  if (summary.betweenDownloadDelayTotalMs > 0) {
    suggestions.push("当前下载间隔含 15-30 秒人工化等待；若以纯效率优先，可改为更短的动态退避。");
  }
  if (summary.workReportSkipped) {
    suggestions.push("工作总结可以放到主下载完成后异步生成，避免把非关键步骤放在关键路径上。");
  }
  if (summary.downloadFailureCount > 0) {
    suggestions.push("将认证恢复与真实下载失败拆分计数，避免一次认证波动直接消耗论文下载重试次数。");
  }
  if (!suggestions.length) {
    suggestions.push("本轮没有明显结构性阻塞，后续优先优化搜索页和下载页的人为等待时长。");
  }
  return suggestions;
}

function buildMarkdownReport(summary) {
  const lines = [];
  lines.push(`# ${summary.topic} 自动化运行报告`);
  lines.push("");
  lines.push(`- 启动时间：${summary.startedAt}`);
  lines.push(`- 结束时间：${summary.endedAt}`);
  lines.push(`- 总耗时：${summary.totalDurationText}`);
  lines.push(`- Pipeline 结果：${summary.finalStage}`);
  lines.push(`- Pipeline 运行目录：${summary.runDir || "未识别"}`);
  lines.push(`- 观察报告目录：${summary.reportDir}`);
  lines.push("");
  lines.push("## 结果概览");
  lines.push("");
  lines.push(`- 候选文献：${summary.candidateCount} 篇`);
  lines.push(`- 入队文献：${summary.queueCount} 篇`);
  lines.push(`- 下载成功：${summary.downloadSuccessCount} 篇`);
  lines.push(`- 下载失败：${summary.downloadFailureCount} 篇`);
  if (summary.lastError) {
    lines.push(`- 最终错误：${summary.lastError}`);
  }
  lines.push("");
  lines.push("## 阶段耗时");
  lines.push("");
  for (const stage of summary.stageEntries) {
    lines.push(`- ${stage.stage}：${formatDuration(stage.durationMs || 0)}`);
  }
  lines.push("");
  lines.push("## 关键步骤耗时");
  lines.push("");
  for (const step of summary.stepEntries) {
    const status = step.status ? `，状态=${step.status}` : "";
    const title = step.title ? `，标题=${step.title}` : "";
    lines.push(`- ${step.name}：${formatDuration(step.durationMs || 0)}${status}${title}`);
  }
  lines.push("");
  lines.push("## 卡顿记录");
  lines.push("");
  if (summary.stallEntries.length) {
    for (const stall of summary.stallEntries) {
      const checkpoint = stall.checkpoint ? `，checkpoint=${stall.checkpoint}` : "";
      lines.push(`- ${stall.stage || "UNKNOWN"}：${formatDuration(stall.durationMs || 0)}${checkpoint}`);
    }
  } else {
    lines.push("- 本轮未观测到超过阈值的静默卡顿。");
  }
  lines.push("");
  lines.push("## 成功下载");
  lines.push("");
  if (summary.downloadedTitles.length) {
    for (const item of summary.downloadedTitles) {
      lines.push(`- ${item.title}：${item.downloadPath}`);
    }
  } else {
    lines.push("- 本轮没有成功下载的文献。");
  }
  lines.push("");
  lines.push("## 优化建议");
  lines.push("");
  for (const suggestion of summary.optimizationSuggestions) {
    lines.push(`- ${suggestion}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.topic && !options.topicFile && !options.resumeRun) {
    throw new Error("Provide --topic, --topic-file, or --resume-run.");
  }

  const reportDir = path.join(
    WORK_REPORT_ROOT,
    `${slugifyTopic(options.topic || path.basename(options.resumeRun || "topic"))}-observed-run-${timestampString().replace(/[ :]/g, "-")}`
  );
  ensureDir(reportDir);
  const rawLogPath = path.join(reportDir, "observed-run.log");

  const startedAtMs = Date.now();
  const startedAt = nowIso();
  let lastActivityAtMs = startedAtMs;
  let runInfo = {
    topic: options.topic,
    runDir: options.resumeRun ? path.resolve(options.resumeRun) : "",
    reportDir
  };

  const timeline = [];
  const stageEntries = [];
  const stepEntries = [];
  const stallEntries = [];
  const activeSteps = new Map();
  let activeStage = null;
  let activeStall = null;
  let latestState = {};
  let childExitCode = null;

  function appendRaw(kind, line) {
    fs.appendFileSync(rawLogPath, `[${nowIso()}] [${kind}] ${line}\n`, "utf8");
  }

  function markActivity() {
    const nowMs = Date.now();
    lastActivityAtMs = nowMs;
    if (activeStall) {
      closeTimedEntry(activeStall, nowMs);
      stallEntries.push(activeStall);
      activeStall = null;
    }
  }

  function recordTimeline(type, payload) {
    timeline.push({
      at: nowIso(),
      type,
      ...payload
    });
  }

  function openStep(key, payload) {
    const nowMs = Date.now();
    const entry = {
      key,
      name: payload.name,
      startAt: new Date(nowMs).toISOString(),
      startAtMs: nowMs,
      ...payload
    };
    activeSteps.set(key, entry);
    stepEntries.push(entry);
  }

  function finishStep(key, payload = {}) {
    const entry = activeSteps.get(key);
    if (!entry) {
      const nowMs = Date.now();
      stepEntries.push({
        key,
        name: payload.name || key,
        startAt: new Date(nowMs).toISOString(),
        startAtMs: nowMs,
        endAt: new Date(nowMs).toISOString(),
        endAtMs: nowMs,
        durationMs: 0,
        ...payload
      });
      return;
    }
    closeTimedEntry(entry, Date.now(), payload);
    activeSteps.delete(key);
  }

  function transitionStage(payload) {
    const nowMs = Date.now();
    if (activeStage) {
      closeTimedEntry(activeStage, nowMs);
    }
    activeStage = {
      stage: payload.stage,
      previousStage: payload.previousStage || "",
      startAt: new Date(nowMs).toISOString(),
      startAtMs: nowMs,
      currentDownloadIndex: payload.currentDownloadIndex || 0,
      currentDownloadTitle: payload.currentDownloadTitle || ""
    };
    stageEntries.push(activeStage);
  }

  function handleMarker(marker, payload) {
    if (marker === PIPELINE_RUN_MARKER) {
      runInfo = {
        ...runInfo,
        topic: payload.topic || runInfo.topic,
        runDir: payload.runDir || runInfo.runDir
      };
      recordTimeline("run", payload);
      return;
    }

    if (marker === PIPELINE_STAGE_MARKER) {
      transitionStage(payload);
      recordTimeline("stage", payload);
      return;
    }

    if (marker !== PIPELINE_EVENT_MARKER) {
      return;
    }

    recordTimeline("event", payload);
    if (payload.type === "research_search_start") {
      openStep(`research-search-${payload.attempt}`, {
        name: `research_search_attempt_${payload.attempt}`,
        attempt: payload.attempt,
        logPath: payload.logPath
      });
      return;
    }
    if (payload.type === "research_search_finish") {
      finishStep(`research-search-${payload.attempt}`, {
        name: `research_search_attempt_${payload.attempt}`,
        status: payload.exitCode === 0 ? "ok" : "failed",
        exitCode: payload.exitCode
      });
      return;
    }
    if (payload.type === "queue_build_start") {
      openStep("queue-build", {
        name: "queue_build",
        candidateCount: payload.candidateCount,
        downloadLimit: payload.downloadLimit
      });
      return;
    }
    if (payload.type === "queue_build_finish") {
      finishStep("queue-build", {
        name: "queue_build",
        status: "ok",
        selectedCount: payload.selectedCount
      });
      return;
    }
    if (payload.type === "download_item_start") {
      openStep(`download-${payload.index}-${payload.attempt}`, {
        name: `download_item_${payload.index}_attempt_${payload.attempt}`,
        index: payload.index,
        attempt: payload.attempt,
        title: payload.title
      });
      return;
    }
    if (payload.type === "download_item_finish") {
      finishStep(`download-${payload.index}-${payload.attempt}`, {
        name: `download_item_${payload.index}_attempt_${payload.attempt}`,
        status: payload.status,
        title: payload.title,
        downloadPath: payload.downloadPath || "",
        error: payload.error || ""
      });
      return;
    }
    if (payload.type === "between_download_delay") {
      stepEntries.push({
        key: `between-delay-${payload.index}-${payload.delayMs}-${stepEntries.length}`,
        name: `between_download_delay_${payload.index}`,
        startAt: nowIso(),
        startAtMs: Date.now(),
        endAt: nowIso(),
        endAtMs: Date.now(),
        durationMs: Number(payload.delayMs || 0),
        title: payload.title || "",
        status: "wait"
      });
      return;
    }
    if (payload.type === "verify_downloads_start") {
      openStep("verify-downloads", {
        name: "verify_downloads"
      });
      return;
    }
    if (payload.type === "verify_downloads_finish") {
      finishStep("verify-downloads", {
        name: "verify_downloads",
        status: "ok"
      });
      return;
    }
    if (payload.type === "work_report_start") {
      openStep("work-report", {
        name: "work_report"
      });
      return;
    }
    if (payload.type === "work_report_finish") {
      finishStep("work-report", {
        name: "work_report",
        status: "ok"
      });
      return;
    }
    if (payload.type === "work_report_skipped") {
      stepEntries.push({
        key: "work-report-skipped",
        name: "work_report",
        startAt: nowIso(),
        startAtMs: Date.now(),
        endAt: nowIso(),
        endAtMs: Date.now(),
        durationMs: 0,
        status: "skipped"
      });
      return;
    }
    if (payload.type === "auth_auto_retry_wait") {
      openStep(`auth-retry-${payload.retryCount}`, {
        name: `auth_auto_retry_${payload.retryCount}`,
        retryCount: payload.retryCount,
        status: "waiting"
      });
      return;
    }
    if (payload.type === "auth_auto_retry_resume") {
      finishStep(`auth-retry-${payload.retryCount}`, {
        name: `auth_auto_retry_${payload.retryCount}`,
        status: "resumed"
      });
    }
  }

  function processLine(kind, line) {
    appendRaw(kind, line);
    markActivity();

    const text = String(line || "");
    for (const marker of [PIPELINE_RUN_MARKER, PIPELINE_STAGE_MARKER, PIPELINE_EVENT_MARKER]) {
      if (text.startsWith(marker)) {
        try {
          handleMarker(marker, JSON.parse(text.slice(marker.length)));
        } catch (error) {
          recordTimeline("marker_parse_error", {
            marker,
            line: text,
            error: error?.message || String(error || "")
          });
        }
        return;
      }
    }
  }

  function refreshStateSnapshot() {
    if (!runInfo.runDir) {
      return;
    }
    const pipelineStatePath = path.join(runInfo.runDir, "pipeline_state.json");
    const runStatusPath = path.join(runInfo.runDir, "run_status.json");
    const pipelineState = readJson(pipelineStatePath, null);
    const runStatus = readJson(runStatusPath, null);
    if (pipelineState) {
      latestState = {
        ...latestState,
        pipelineStage: pipelineState.stage || "",
        currentDownloadTitle: pipelineState.currentDownloadTitle || "",
        lastError: pipelineState.lastError || "",
        metadata: pipelineState.metadata || {}
      };
    }
    if (runStatus) {
      latestState = {
        ...latestState,
        researchStage: runStatus.stage || "",
        checkpoint: runStatus.last_checkpoint || "",
        runStatusError: runStatus.error || ""
      };
    }
  }

  const pollHandle = setInterval(() => {
    refreshStateSnapshot();
    const nowMs = Date.now();
    const stallStartMs = lastActivityAtMs + options.stallThresholdMs;
    if (!activeStall && nowMs >= stallStartMs) {
      activeStall = {
        stage: latestState.pipelineStage || latestState.researchStage || activeStage?.stage || "UNKNOWN",
        checkpoint: latestState.checkpoint || latestState.metadata?.researchLastCheckpoint || "",
        startAt: new Date(stallStartMs).toISOString(),
        startAtMs: stallStartMs
      };
    }
  }, 5000);

  const args = [PIPELINE_RUNNER];
  if (options.topic) {
    args.push("--topic", options.topic);
  }
  if (options.topicFile) {
    args.push("--topic-file", path.resolve(options.topicFile));
  }
  if (options.resumeRun) {
    args.push("--resume-run", path.resolve(options.resumeRun));
  }
  args.push("--download-limit", String(options.downloadLimit));
  args.push("--search-retries", String(options.searchRetries));
  args.push("--download-retries", String(options.downloadRetries));

  const child = spawn("node", args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PIPELINE_SKIP_WORK_REPORT: process.env.PIPELINE_SKIP_WORK_REPORT || "1",
      PIPELINE_CONTINUE_ON_WORK_REPORT_FAILURE: process.env.PIPELINE_CONTINUE_ON_WORK_REPORT_FAILURE || "1",
      PIPELINE_AUTH_AUTO_RETRY_MAX: process.env.PIPELINE_AUTH_AUTO_RETRY_MAX || "8",
      PIPELINE_AUTH_AUTO_RETRY_DELAY_MS: process.env.PIPELINE_AUTH_AUTO_RETRY_DELAY_MS || "20000",
      PIPELINE_AUTH_PROMPT_ON_EXHAUSTED: process.env.PIPELINE_AUTH_PROMPT_ON_EXHAUSTED || "0"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  streamLines(child.stdout, (line) => processLine("stdout", line));
  streamLines(child.stderr, (line) => processLine("stderr", line));

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  childExitCode = Number(exitCode || 0);

  clearInterval(pollHandle);
  refreshStateSnapshot();

  const endedAtMs = Date.now();
  const endedAt = nowIso();
  if (activeStage) {
    closeTimedEntry(activeStage, endedAtMs);
  }
  for (const entry of activeSteps.values()) {
    closeTimedEntry(entry, endedAtMs, {
      status: entry.status || "unfinished"
    });
  }
  if (activeStall) {
    closeTimedEntry(activeStall, endedAtMs);
    stallEntries.push(activeStall);
  }

  const pipelineState = runInfo.runDir ? readJson(path.join(runInfo.runDir, "pipeline_state.json"), {}) : {};
  const pipelineResult = runInfo.runDir ? readJson(path.join(runInfo.runDir, "pipeline_result.json"), {}) : {};
  const runStatus = runInfo.runDir ? readJson(path.join(runInfo.runDir, "run_status.json"), {}) : {};
  const candidateRows = runInfo.runDir ? readCsvRows(path.join(runInfo.runDir, "papers_for_download.csv")) : [];
  const queueRows = runInfo.runDir ? readCsvRows(path.join(runInfo.runDir, "download_queue.csv")) : [];
  const downloadResults = Array.isArray(pipelineResult.downloadResults) ? pipelineResult.downloadResults : [];
  const downloadedTitles = downloadResults
    .filter((item) => item.status === "downloaded")
    .map((item) => ({
      title: item.title,
      downloadPath: item.downloadPath
    }));

  const betweenDownloadDelayTotalMs = stepEntries
    .filter((entry) => String(entry.name || "").startsWith("between_download_delay_"))
    .reduce((sum, entry) => sum + Number(entry.durationMs || 0), 0);

  const summary = {
    topic: runInfo.topic || pipelineState.topic || options.topic || "",
    startedAt,
    endedAt,
    totalDurationMs: endedAtMs - startedAtMs,
    totalDurationText: formatDuration(endedAtMs - startedAtMs),
    childExitCode,
    reportDir,
    runDir: runInfo.runDir || pipelineState.runDir || pipelineResult.runDir || "",
    finalStage: pipelineState.stage || pipelineResult.stage || (childExitCode === 0 ? "DONE" : "FAILED"),
    lastError: pipelineState.lastError || runStatus.error || "",
    candidateCount: candidateRows.length,
    queueCount: queueRows.length,
    downloadSuccessCount: downloadResults.filter((item) => item.status === "downloaded").length,
    downloadFailureCount: downloadResults.filter((item) => item.status !== "downloaded").length,
    authPauseCount: timeline.filter((item) => item.type === "auth_pause").length,
    workReportSkipped: Boolean(pipelineState.metadata?.workReportSkipped),
    betweenDownloadDelayTotalMs,
    stallCount: stallEntries.length,
    stageEntries: stageEntries.map((entry) => ({
      stage: entry.stage,
      durationMs: entry.durationMs || 0,
      startAt: entry.startAt,
      endAt: entry.endAt
    })),
    stepEntries: stepEntries.map((entry) => ({
      name: entry.name,
      title: entry.title || "",
      status: entry.status || "",
      durationMs: entry.durationMs || 0,
      startAt: entry.startAt,
      endAt: entry.endAt,
      error: entry.error || "",
      downloadPath: entry.downloadPath || ""
    })),
    stallEntries: stallEntries.map((entry) => ({
      stage: entry.stage || "",
      checkpoint: entry.checkpoint || "",
      durationMs: entry.durationMs || 0,
      startAt: entry.startAt,
      endAt: entry.endAt
    })),
    downloadedTitles,
    pipelineState,
    pipelineResult,
    runStatus,
    optimizationSuggestions: []
  };
  summary.optimizationSuggestions = buildOptimizationSuggestions(summary);

  writeJson(path.join(reportDir, "timeline.json"), timeline);
  writeJson(path.join(reportDir, "summary.json"), summary);
  writeText(path.join(reportDir, "summary.md"), buildMarkdownReport(summary));

  process.stdout.write(`${JSON.stringify({ reportDir, runDir: summary.runDir, finalStage: summary.finalStage, totalDurationMs: summary.totalDurationMs })}\n`);
  if (childExitCode !== 0) {
    process.exitCode = childExitCode;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error || ""));
  process.exit(1);
});
