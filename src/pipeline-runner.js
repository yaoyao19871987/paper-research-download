const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { ensureDir, askLine, timestampString, getBoolEnv, getNumEnv } = require("./common");
const {
  openLegacySixueSession,
  closeLegacySixueSession,
  downloadOneFromLegacySixueSession,
  classifyAuthPauseReason
} = require("./legacy-sixue-download");

const ROOT_DIR = path.resolve(__dirname, "..");
function resolveSearchDir() {
  const envDir = process.env.CNKI_SEARCH_DIR ? path.resolve(process.env.CNKI_SEARCH_DIR) : "";
  const candidates = [envDir, path.join(ROOT_DIR, "python-scraper", "cnkiLRspider")].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "research_pipeline.py"))) {
      return candidate;
    }
  }

  throw new Error(
    "Could not locate cnkiLRspider. Set CNKI_SEARCH_DIR or place the scraper in python-scraper/cnkiLRspider."
  );
}

const SEARCH_DIR = resolveSearchDir();
const OUTPUT_ROOT = path.resolve(process.env.CNKI_OUTPUT_ROOT || path.join(SEARCH_DIR, "outputs"));
const RESEARCH_SCRIPT = path.join(SEARCH_DIR, "research_pipeline.py");
const WORK_REPORT_SCRIPT = path.join(SEARCH_DIR, "generate_work_summary_report.py");
const PROJECT_WORK_REPORT_DIR = path.resolve(process.env.WORK_REPORT_DIR || path.join(ROOT_DIR, "work-reports"));
const PIPELINE_STATE_FILE = "pipeline_state.json";
const PIPELINE_RESULT_FILE = "pipeline_result.json";
const LEGACY_RUN_STATUS_FILE = "run_status.json";
const TOPIC_FILE_NAME = "input_topic.txt";
const CANDIDATE_FILE_NAME = "papers_for_download.csv";
const QUEUE_FILE_NAME = "download_queue.csv";
const PIPELINE_RUN_MARKER = "__PIPELINE_RUN__";
const PIPELINE_STAGE_MARKER = "__PIPELINE_STAGE__";
const PIPELINE_EVENT_MARKER = "__PIPELINE_EVENT__";

const PIPELINE_STAGES = {
  INIT: "INIT",
  SEARCH_STRATEGY: "SEARCH_STRATEGY",
  SEARCH_CRAWL: "SEARCH_CRAWL",
  CANDIDATE_READY: "CANDIDATE_READY",
  WAIT_USER_CONFIRM: "WAIT_USER_CONFIRM",
  QUEUE_READY: "QUEUE_READY",
  DOWNLOADING: "DOWNLOADING",
  PAUSED_FOR_AUTH: "PAUSED_FOR_AUTH",
  VERIFY_DOWNLOADS: "VERIFY_DOWNLOADS",
  WRITE_WORK_REPORT: "WRITE_WORK_REPORT",
  DONE: "DONE",
  FAILED: "FAILED"
};

const LEGACY_RUN_STAGE_MAP = {
  [PIPELINE_STAGES.WAIT_USER_CONFIRM]: "awaiting_download_selection",
  [PIPELINE_STAGES.QUEUE_READY]: "ready_for_download",
  [PIPELINE_STAGES.DOWNLOADING]: "downloading",
  [PIPELINE_STAGES.PAUSED_FOR_AUTH]: "paused_for_auth",
  [PIPELINE_STAGES.VERIFY_DOWNLOADS]: "verifying_downloads",
  [PIPELINE_STAGES.WRITE_WORK_REPORT]: "writing_work_report",
  [PIPELINE_STAGES.DONE]: "done",
  [PIPELINE_STAGES.FAILED]: "failed"
};

const SEARCH_RETRY_LIMIT = 3;
const DOWNLOAD_RETRY_LIMIT = 2;
const BETWEEN_DOWNLOAD_DELAY_MIN_MS = 15000;
const BETWEEN_DOWNLOAD_DELAY_MAX_MS = 30000;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugifyTopic(topic) {
  return String(topic || "")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "topic";
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, "utf8");
}

function getRunFile(runDir, name) {
  return path.join(runDir, name);
}

function nowIso() {
  return new Date().toISOString();
}

function nowIsoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "");
}

function emitMarker(marker, payload) {
  console.log(`${marker}${JSON.stringify(payload)}`);
}

function emitRunMarker(state) {
  emitMarker(PIPELINE_RUN_MARKER, {
    topic: state.topic,
    mode: state.mode,
    runDir: state.runDir,
    timestamp: nowIso()
  });
}

function emitStageMarker(payload) {
  emitMarker(PIPELINE_STAGE_MARKER, {
    timestamp: nowIso(),
    ...payload
  });
}

function emitEvent(type, payload = {}) {
  emitMarker(PIPELINE_EVENT_MARKER, {
    type,
    timestamp: nowIso(),
    ...payload
  });
}

function createInitialState({ topic, mode, runDir, topicFile, downloadLimit }) {
  return {
    topic,
    mode,
    runDir,
    topicFile,
    candidateCsv: getRunFile(runDir, CANDIDATE_FILE_NAME),
    queueCsv: getRunFile(runDir, QUEUE_FILE_NAME),
    stage: PIPELINE_STAGES.INIT,
    downloadLimit,
    selectedTitles: [],
    downloadResults: [],
    searchAttempts: 0,
    downloadRoute: "legacy-sixue",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastError: "",
    currentDownloadIndex: 0,
    currentDownloadTitle: "",
    waitingForUser: false,
    logFiles: [],
    metadata: {}
  };
}

function savePipelineArtifacts(state) {
  state.updatedAt = nowIso();
  writeJson(getRunFile(state.runDir, PIPELINE_STATE_FILE), state);

  const resultPayload = {
    topic: state.topic,
    mode: state.mode,
    runDir: state.runDir,
    stage: state.stage,
    candidateCsv: state.candidateCsv,
    queueCsv: state.queueCsv,
    selectedTitles: state.selectedTitles,
    downloadResults: state.downloadResults,
    lastError: state.lastError,
    updatedAt: state.updatedAt
  };
  writeJson(getRunFile(state.runDir, PIPELINE_RESULT_FILE), resultPayload);
  syncLegacyRunStatus(state);
}

function countDownloadResults(results, status) {
  return results.filter((item) => item.status === status).length;
}

function getLegacyRunStage(stage) {
  return LEGACY_RUN_STAGE_MAP[stage] || "";
}

function getLegacyLastCheckpoint(state, legacyStage, currentStatus) {
  if (legacyStage === "ready_for_download") {
    return path.basename(state.queueCsv || QUEUE_FILE_NAME);
  }
  if (legacyStage === "downloading") {
    return `download_${String(state.currentDownloadIndex || 0).padStart(2, "0")}`;
  }
  if (legacyStage === "writing_work_report") {
    return "pipeline_work_summary.log";
  }
  if (legacyStage === "done") {
    return PIPELINE_RESULT_FILE;
  }
  if (legacyStage === "failed") {
    return currentStatus?.last_checkpoint || "pipeline_failed";
  }
  return currentStatus?.last_checkpoint || legacyStage;
}

function syncLegacyRunStatus(state) {
  const legacyStage = getLegacyRunStage(state.stage);
  if (!legacyStage) {
    return;
  }

  const statusPath = getRunFile(state.runDir, LEGACY_RUN_STATUS_FILE);
  const currentStatus = readJson(statusPath, {}) || {};
  const outputFiles =
    currentStatus.output_files && typeof currentStatus.output_files === "object"
      ? { ...currentStatus.output_files }
      : {};

  outputFiles["download_queue.csv"] = state.queueCsv;
  outputFiles[PIPELINE_STATE_FILE] = getRunFile(state.runDir, PIPELINE_STATE_FILE);
  outputFiles[PIPELINE_RESULT_FILE] = getRunFile(state.runDir, PIPELINE_RESULT_FILE);

  if (state.metadata?.workReportPath) {
    outputFiles["work_summary_report.md"] = state.metadata.workReportPath;
  }
  if (state.metadata?.projectWorkReportPath) {
    outputFiles["project_work_summary_report.md"] = state.metadata.projectWorkReportPath;
  }

  const nextStatus = {
    ...currentStatus,
    topic: state.topic,
    stage: legacyStage,
    run_dir: state.runDir,
    updated_at: nowIsoSeconds(),
    last_checkpoint: getLegacyLastCheckpoint(state, legacyStage, currentStatus),
    error: state.lastError || "",
    waiting_for_verification: false,
    waiting_for_kimi: legacyStage === "writing_work_report",
    approval_message: legacyStage === "awaiting_download_selection" ? currentStatus.approval_message || "" : "",
    selected_count: state.selectedTitles.length,
    downloaded_count: countDownloadResults(state.downloadResults, "downloaded"),
    failed_count: countDownloadResults(state.downloadResults, "failed"),
    current_download_index: state.currentDownloadIndex || 0,
    current_download_title: state.currentDownloadTitle || "",
    output_files: outputFiles
  };

  writeJson(statusPath, nextStatus);
}

function updateState(state, patch) {
  const previousStage = state.stage;
  Object.assign(state, patch, { updatedAt: nowIso() });
  savePipelineArtifacts(state);
  if (patch.stage && patch.stage !== previousStage) {
    emitStageMarker({
      previousStage,
      stage: state.stage,
      runDir: state.runDir,
      currentDownloadIndex: state.currentDownloadIndex || 0,
      currentDownloadTitle: state.currentDownloadTitle || "",
      lastError: state.lastError || ""
    });
  }
}

function parseArgs(argv) {
  const options = {
    topic: "",
    topicFile: "",
    mode: "auto",
    downloadLimit: 3,
    resumeRun: "",
    searchRetries: SEARCH_RETRY_LIMIT,
    downloadRetries: DOWNLOAD_RETRY_LIMIT
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
    if (token === "--mode") {
      options.mode = (argv[index + 1] || "auto").trim().toLowerCase();
      index += 1;
      continue;
    }
    if (token === "--download-limit") {
      options.downloadLimit = Number(argv[index + 1] || options.downloadLimit);
      index += 1;
      continue;
    }
    if (token === "--resume-run") {
      options.resumeRun = argv[index + 1] || "";
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
    if (!token.startsWith("--") && !options.topic) {
      options.topic = token;
    }
  }

  options.mode = options.mode === "manual" ? "manual" : "auto";
  if (!Number.isFinite(options.downloadLimit) || options.downloadLimit <= 0) {
    options.downloadLimit = 3;
  }
  if (!Number.isFinite(options.searchRetries) || options.searchRetries <= 0) {
    options.searchRetries = SEARCH_RETRY_LIMIT;
  }
  if (!Number.isFinite(options.downloadRetries) || options.downloadRetries <= 0) {
    options.downloadRetries = DOWNLOAD_RETRY_LIMIT;
  }
  return options;
}

function resolveTopicFromOptions(options, runDir) {
  if (options.topicFile) {
    return readText(path.resolve(options.topicFile)).trim();
  }
  if (options.topic) {
    return String(options.topic).trim();
  }
  const state = readJson(getRunFile(runDir, PIPELINE_STATE_FILE), null);
  if (state?.topic) {
    return String(state.topic).trim();
  }
  const runStatus = readJson(getRunFile(runDir, "run_status.json"), null);
  if (runStatus?.topic) {
    return String(runStatus.topic).trim();
  }
  return readText(getRunFile(runDir, TOPIC_FILE_NAME)).trim();
}

function initializeRun(options) {
  let runDir = "";
  if (options.resumeRun) {
    runDir = path.resolve(options.resumeRun);
    ensureDir(runDir);
  }

  const topic = resolveTopicFromOptions(options, runDir || OUTPUT_ROOT);
  if (!topic) {
    throw new Error("Topic is required. Use --topic, --topic-file, or --resume-run.");
  }

  if (!runDir) {
    ensureDir(OUTPUT_ROOT);
    runDir = path.join(OUTPUT_ROOT, `${slugifyTopic(topic)}-pipeline-${timestampString().replace(/[ :]/g, "-")}`);
    ensureDir(runDir);
  }

  const topicFile = getRunFile(runDir, TOPIC_FILE_NAME);
  if (!fs.existsSync(topicFile)) {
    writeText(topicFile, `${topic}\n`);
  }

  const statePath = getRunFile(runDir, PIPELINE_STATE_FILE);
  const existingState = readJson(statePath, null);
  if (existingState) {
    existingState.topic = existingState.topic || topic;
    existingState.mode = options.mode || existingState.mode || "auto";
    existingState.topicFile = topicFile;
    existingState.runDir = runDir;
    existingState.candidateCsv = existingState.candidateCsv || getRunFile(runDir, CANDIDATE_FILE_NAME);
    existingState.queueCsv = existingState.queueCsv || getRunFile(runDir, QUEUE_FILE_NAME);
    existingState.downloadLimit = options.downloadLimit || existingState.downloadLimit || 3;
    return existingState;
  }

  const state = createInitialState({
    topic,
    mode: options.mode,
    runDir,
    topicFile,
    downloadLimit: options.downloadLimit
  });
  savePipelineArtifacts(state);
  return state;
}

function mapResearchStage(runStatus) {
  const statusStage = String(runStatus?.stage || "");
  if (
    ["initialized", "strategy_round1", "strategy_round1_done", "awaiting_strategy_approval"].includes(statusStage)
  ) {
    return PIPELINE_STAGES.SEARCH_STRATEGY;
  }
  if (["awaiting_download_selection", "ready_for_download"].includes(statusStage)) {
    return PIPELINE_STAGES.CANDIDATE_READY;
  }
  if (statusStage === "failed") {
    return PIPELINE_STAGES.FAILED;
  }
  return PIPELINE_STAGES.SEARCH_CRAWL;
}

function readCsvRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parse(fs.readFileSync(filePath, "utf8"), {
    bom: true,
    columns: true,
    skip_empty_lines: true
  });
}

function writeCsvRows(filePath, rows, columns) {
  const output = stringify(rows, {
    header: true,
    columns,
    bom: true
  });
  fs.writeFileSync(filePath, output, "utf8");
}

function parseScore(value) {
  const numeric = Number.parseFloat(String(value || "").trim());
  return Number.isFinite(numeric) ? numeric : Number.NEGATIVE_INFINITY;
}

function normalizeSelectionKey(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function autoSelectCandidates(rows, limit) {
  const indexedRows = rows.map((row, index) => ({ row: { ...row }, index }));
  const rankedRows = indexedRows
    .filter(({ row }) => {
      const label = String(row.label || "").trim().toLowerCase();
      const hasStableReference = Boolean(row.page_url || row.file_name || row.paper_id);
      return Boolean(row.title && hasStableReference && label !== "teaching");
    })
    .sort((left, right) => {
      const scoreDiff = parseScore(right.row.final_score) - parseScore(left.row.final_score);
      if (scoreDiff !== 0) return scoreDiff;
      return left.index - right.index;
    });

  const seenTitles = new Set();
  const selectedEntries = [];
  for (const entry of rankedRows) {
    const key = normalizeSelectionKey(entry.row.title);
    if (!key || seenTitles.has(key)) {
      continue;
    }
    seenTitles.add(key);
    selectedEntries.push(entry);
    if (selectedEntries.length >= limit) {
      break;
    }
  }

  const selected = selectedEntries.map(({ row }) => row);
  const selectedIndexes = new Set(selectedEntries.map(({ index }) => index));
  const updatedRows = rows.map((row, index) => ({
    ...row,
    user_select: selectedIndexes.has(index) ? "yes" : ""
  }));

  return { selected, updatedRows };
}

function appendLogFile(state, logFile) {
  if (!state.logFiles.includes(logFile)) {
    state.logFiles.push(logFile);
  }
}

function appendLogLine(logPath, line) {
  ensureDir(path.dirname(logPath));
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
}

async function runWithTeeLog(logPath, fn) {
  ensureDir(path.dirname(logPath));
  appendLogLine(logPath, `\n# ${nowIso()}`);

  const originalLog = console.log;
  const originalError = console.error;

  const write = (method, args) => {
    const text = args
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join(" ");
    appendLogLine(logPath, text);
    method.apply(console, args);
  };

  console.log = (...args) => write(originalLog, args);
  console.error = (...args) => write(originalError, args);

  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function streamLines(stream, callback) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) {
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

function spawnLoggedCommand({ command, args, cwd, env, logPath, onLine, stdinMode = "pipe" }) {
  ensureDir(path.dirname(logPath));
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n$ ${command} ${args.join(" ")}\n`);

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: [stdinMode, "pipe", "pipe"],
    windowsHide: true
  });

  const handleLine = (line) => {
    const text = String(line || "");
    process.stdout.write(`${text}\n`);
    logStream.write(`${text}\n`);
    if (onLine) {
      onLine(text);
    }
  };

  streamLines(child.stdout, handleLine);
  streamLines(child.stderr, handleLine);

  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      logStream.end();
      reject(error);
    });
    child.on("close", (code) => {
      logStream.end();
      resolve(code);
    });
  });
}

async function runResearchSearch(state, options) {
  const attemptNumber = Math.max(1, Number(state.searchAttempts || 1));
  const logPath = getRunFile(state.runDir, `pipeline_search_attempt_${String(attemptNumber).padStart(2, "0")}.log`);
  appendLogFile(state, logPath);
  emitEvent("research_search_start", {
    runDir: state.runDir,
    attempt: attemptNumber,
    logPath
  });

  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1"
  };

  const args = [
    RESEARCH_SCRIPT,
    "--topic-file",
    state.topicFile,
    "--resume-dir",
    state.runDir,
    "--approve-strategy"
  ];

  const pollHandle = setInterval(() => {
    const runStatus = readJson(getRunFile(state.runDir, "run_status.json"), null);
    if (!runStatus) return;
    const mappedStage = mapResearchStage(runStatus);
    updateState(state, {
      stage: mappedStage,
      lastError: runStatus.error || "",
      metadata: {
        ...state.metadata,
        researchStage: runStatus.stage || "",
        researchLastCheckpoint: runStatus.last_checkpoint || ""
      }
    });
  }, 2000);

  try {
    const exitCode = await spawnLoggedCommand({
      command: "python",
      args,
      cwd: SEARCH_DIR,
      env,
      logPath
    });
    emitEvent("research_search_finish", {
      runDir: state.runDir,
      attempt: attemptNumber,
      exitCode,
      logPath
    });
    return exitCode;
  } finally {
    clearInterval(pollHandle);
  }
}

async function generateWorkSummaryReport(state, options) {
  const logPath = getRunFile(state.runDir, "pipeline_work_summary.log");
  appendLogFile(state, logPath);
  let structuredOutput = null;
  emitEvent("work_report_start", {
    runDir: state.runDir,
    logPath
  });

  const exitCode = await spawnLoggedCommand({
    command: "python",
    args: [
      WORK_REPORT_SCRIPT,
      "--run-dir",
      state.runDir,
      "--topic",
      state.topic,
      "--provider",
      process.env.WORK_SUMMARY_PROVIDER || "auto",
      "--project-report-dir",
      PROJECT_WORK_REPORT_DIR
    ],
    cwd: SEARCH_DIR,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1"
    },
    logPath,
    onLine: (line) => {
      const text = String(line || "").trim();
      if (!text || !text.startsWith("{")) {
        return;
      }
      try {
        structuredOutput = JSON.parse(text);
      } catch {
        // Keep listening for a valid JSON payload.
      }
    }
  });

  if (exitCode !== 0) {
    throw new Error(`Work summary report generation failed with exit code ${exitCode}.`);
  }

  const reportMdPath = structuredOutput?.report_md_path || getRunFile(state.runDir, "work_summary_report.md");
  const projectMdPath = structuredOutput?.project_md_path || path.join(PROJECT_WORK_REPORT_DIR, `${path.basename(state.runDir)}-work-summary-report.md`);

  if (!fs.existsSync(reportMdPath)) {
    throw new Error("Work summary report file was not created.");
  }

  updateState(state, {
    metadata: {
      ...state.metadata,
      workReportTitle: structuredOutput?.report_title || "",
      workReportProvider: structuredOutput?.provider || "",
      workReportPath: reportMdPath,
      projectWorkReportPath: projectMdPath
    }
  });
  emitEvent("work_report_finish", {
    runDir: state.runDir,
    logPath,
    reportMdPath,
    projectMdPath
  });
}

async function ensureCandidates(state, options) {
  if (fs.existsSync(state.candidateCsv) && readCsvRows(state.candidateCsv).length > 0) {
    updateState(state, { stage: PIPELINE_STAGES.CANDIDATE_READY, lastError: "" });
    return;
  }

  for (let attempt = state.searchAttempts + 1; attempt <= options.searchRetries; attempt += 1) {
    updateState(state, {
      stage: PIPELINE_STAGES.SEARCH_STRATEGY,
      searchAttempts: attempt,
      lastError: ""
    });

    const exitCode = await runResearchSearch(state, options);
    const candidateRows = readCsvRows(state.candidateCsv);
    if (exitCode === 0 && candidateRows.length > 0) {
      updateState(state, { stage: PIPELINE_STAGES.CANDIDATE_READY, lastError: "" });
      return;
    }

    const runStatus = readJson(getRunFile(state.runDir, "run_status.json"), null);
    const errorMessage =
      runStatus?.error ||
      `Research pipeline attempt ${attempt}/${options.searchRetries} exited with code ${exitCode}.`;

    updateState(state, {
      stage: PIPELINE_STAGES.SEARCH_CRAWL,
      lastError: errorMessage
    });

    if (attempt < options.searchRetries) {
      const delayMs = randomInt(4000, 9000);
      console.log(`[search] retrying after ${delayMs}ms...`);
      await sleep(delayMs);
      continue;
    }
  }

  throw new Error(state.lastError || "Research pipeline did not produce candidates.");
}

function ensureQueueFromCandidates(state) {
  const candidateRows = readCsvRows(state.candidateCsv);
  if (!candidateRows.length) {
    throw new Error("Candidate CSV is empty.");
  }
  emitEvent("queue_build_start", {
    runDir: state.runDir,
    candidateCount: candidateRows.length,
    downloadLimit: state.downloadLimit
  });

  const columns = Object.keys(candidateRows[0]);
  const { selected, updatedRows } = autoSelectCandidates(candidateRows, state.downloadLimit);
  if (!selected.length) {
    throw new Error("Auto-selection found no downloadable papers.");
  }

  writeCsvRows(state.candidateCsv, updatedRows, columns);
  writeCsvRows(state.queueCsv, selected, columns);

  updateState(state, {
    stage: PIPELINE_STAGES.QUEUE_READY,
    selectedTitles: selected.map((row) => row.title),
    lastError: "",
    waitingForUser: false
  });
  emitEvent("queue_build_finish", {
    runDir: state.runDir,
    selectedCount: selected.length,
    selectedTitles: selected.map((row) => row.title)
  });
}

function loadQueueRows(state) {
  const rows = readCsvRows(state.queueCsv);
  if (!rows.length) {
    throw new Error("Download queue is empty.");
  }
  return rows;
}

function normalizeDownloadedPath(value) {
  return String(value || "").trim();
}

function isDownloadedResultUsable(result) {
  if (!result || result.status !== "downloaded") return false;
  const downloadPath = normalizeDownloadedPath(result.downloadPath);
  return Boolean(downloadPath && fs.existsSync(downloadPath));
}

function getExistingSuccessfulResult(state, title) {
  return state.downloadResults.find((item) => item.title === title && isDownloadedResultUsable(item));
}

function upsertDownloadResult(state, payload) {
  const nextResults = state.downloadResults.filter((item) => item.title !== payload.title);
  nextResults.push(payload);
  updateState(state, {
    downloadResults: nextResults
  });
}

async function waitForPipelineContinuePrompt() {
  while (true) {
    const answer = String(await askLine("[auth] 完成登录或验证码处理后，输入 continue 继续："))
      .trim()
      .toLowerCase();
    if (!answer || answer === "continue") {
      return;
    }
    console.log("[auth] 请输入 continue。");
  }
}

function nextAuthRetryMetadata(state, message, pauseReason) {
  const previousCount = Number(state.metadata?.authAutoResumeCount || 0);
  return {
    ...state.metadata,
    authAutoResumeCount: previousCount + 1,
    lastAuthPauseAt: nowIso(),
    lastAuthPauseReason: pauseReason || "",
    lastAuthPauseMessage: message || ""
  };
}

function resetAuthRetryMetadata(state) {
  if (!state.metadata?.authAutoResumeCount) {
    return;
  }
  updateState(state, {
    metadata: {
      ...state.metadata,
      authAutoResumeCount: 0
    }
  });
}

async function handlePipelineAuthPause(state, index, title, message, pauseReason) {
  const maxAutoRetries = getNumEnv("PIPELINE_AUTH_AUTO_RETRY_MAX", 8);
  const retryDelayMs = getNumEnv("PIPELINE_AUTH_AUTO_RETRY_DELAY_MS", 20000);
  const promptOnExhausted = getBoolEnv("PIPELINE_AUTH_PROMPT_ON_EXHAUSTED", false);
  const retryCount = Number(state.metadata?.authAutoResumeCount || 0) + 1;

  updateState(state, {
    stage: PIPELINE_STAGES.PAUSED_FOR_AUTH,
    currentDownloadIndex: index + 1,
    currentDownloadTitle: title,
    lastError: message,
    metadata: nextAuthRetryMetadata(state, message, pauseReason)
  });

  emitEvent("auth_pause", {
    runDir: state.runDir,
    reason: pauseReason || "",
    message,
    retryCount,
    maxAutoRetries,
    currentDownloadIndex: index + 1,
    currentDownloadTitle: title
  });
  process.stdout.write("\u0007");

  if (retryCount <= maxAutoRetries) {
    console.log(`[auth] auto retry ${retryCount}/${maxAutoRetries} after ${retryDelayMs}ms.`);
    emitEvent("auth_auto_retry_wait", {
      runDir: state.runDir,
      retryCount,
      retryDelayMs
    });
    await sleep(retryDelayMs);
    emitEvent("auth_auto_retry_resume", {
      runDir: state.runDir,
      retryCount
    });
    return;
  }

  if (promptOnExhausted) {
    await waitForPipelineContinuePrompt();
    emitEvent("auth_manual_resume", {
      runDir: state.runDir,
      retryCount
    });
    return;
  }

  throw new Error(`Authentication could not be recovered automatically: ${message}`);
}

async function ensureLegacySession(state, index, title) {
  while (true) {
    try {
      const session = await openLegacySixueSession({});
      resetAuthRetryMetadata(state);
      return session;
    } catch (error) {
      const message = error?.message || String(error || "");
      const pauseReason = classifyAuthPauseReason(message);
      if (!pauseReason) {
        throw error;
      }
      await handlePipelineAuthPause(state, index, title, message, pauseReason);
    }
  }
}

function isSessionReusable(session) {
  return Boolean(session?.context && session?.searchPage && !session.searchPage.isClosed?.());
}

async function runLegacyDownload(state, session, row, index, options) {
  const title = String(row.title || "").trim();
  const logPath = getRunFile(state.runDir, `pipeline_download_${String(index + 1).padStart(2, "0")}.log`);
  appendLogFile(state, logPath);
  appendLogLine(logPath, `$ reuse-session download: ${title}`);

  while (true) {
    try {
      const result = await runWithTeeLog(logPath, () =>
        downloadOneFromLegacySixueSession(session, {
          query: title,
          targetTitle: title,
          targetAuthors: row.authors || "",
          targetJournal: row.journal || "",
          targetYear: row.publish_year || "",
          targetPaperId: row.paper_id || "",
          targetDbCode: row.db_code || "",
          targetFileName: row.file_name || "",
          targetPageUrl: row.page_url || ""
        })
      );
      resetAuthRetryMetadata(state);
      return result;
    } catch (error) {
      const message = error?.message || String(error || "");
      const pauseReason = classifyAuthPauseReason(message);
      if (!pauseReason) {
        throw error;
      }
      await handlePipelineAuthPause(state, index, title, message, pauseReason);
      session.context = null;
      session.searchPage = null;
      throw error;
    }
  }
}

async function runDownloadQueue(state, options) {
  const queueRows = loadQueueRows(state);
  let session = null;

  try {
    for (let index = 0; index < queueRows.length; index += 1) {
      const row = queueRows[index];
      const title = String(row.title || "").trim();
      const existing = getExistingSuccessfulResult(state, title);
      if (existing) {
        console.log(`[download] skip already-downloaded title: ${title}`);
        continue;
      }

      let downloaded = false;
      for (let attempt = 1; attempt <= options.downloadRetries; attempt += 1) {
        updateState(state, {
          stage: PIPELINE_STAGES.DOWNLOADING,
          currentDownloadIndex: index + 1,
          currentDownloadTitle: title,
          lastError: ""
        });
        emitEvent("download_item_start", {
          runDir: state.runDir,
          index: index + 1,
          title,
          attempt,
          pageUrl: row.page_url || ""
        });

        try {
          if (!isSessionReusable(session)) {
            if (session) {
              await closeLegacySixueSession(session).catch(() => {});
            }
            session = await ensureLegacySession(state, index, title);
          }

          const result = await runLegacyDownload(state, session, row, index, options);
          const payload = {
            index: index + 1,
            title,
            selectedTitle: result.selectedTitle || title,
            downloadPath: normalizeDownloadedPath(result.downloadPath),
            query: result.query || title,
            targetTitle: result.targetTitle || title,
            pageUrl: row.page_url || "",
            status: "downloaded",
            attempt,
            downloadRoute: "legacy-sixue"
          };
          upsertDownloadResult(state, payload);
          emitEvent("download_item_finish", {
            runDir: state.runDir,
            index: index + 1,
            title,
            attempt,
            status: "downloaded",
            downloadPath: payload.downloadPath
          });
          downloaded = true;
          break;
        } catch (error) {
          const message = error?.message || String(error || "");
          upsertDownloadResult(state, {
            index: index + 1,
            title,
            selectedTitle: title,
            downloadPath: "",
            query: title,
            targetTitle: title,
            pageUrl: row.page_url || "",
            status: "failed",
            attempt,
            downloadRoute: "legacy-sixue",
            error: message
          });
          emitEvent("download_item_finish", {
            runDir: state.runDir,
            index: index + 1,
            title,
            attempt,
            status: "failed",
            error: message
          });

          if (!isSessionReusable(session) && session) {
            await closeLegacySixueSession(session).catch(() => {});
            session = null;
          }

          if (attempt < options.downloadRetries) {
            const retryDelay = randomInt(5000, 12000);
            console.log(`[download] retrying "${title}" after ${retryDelay}ms...`);
            await sleep(retryDelay);
            continue;
          }

          throw new Error(`Download failed for "${title}": ${message}`);
        }
      }

      if (!downloaded) {
        throw new Error(`Download failed for "${title}".`);
      }

      const isLast = index === queueRows.length - 1;
      if (!isLast) {
        const delayMs = randomInt(BETWEEN_DOWNLOAD_DELAY_MIN_MS, BETWEEN_DOWNLOAD_DELAY_MAX_MS);
        console.log(`[download] waiting ${delayMs}ms before next paper...`);
        emitEvent("between_download_delay", {
          runDir: state.runDir,
          index: index + 1,
          title,
          delayMs
        });
        await sleep(delayMs);
      }
    }
  } finally {
    if (session) {
      await closeLegacySixueSession(session).catch(() => {});
    }
  }
}

function verifyDownloadResults(state) {
  updateState(state, {
    stage: PIPELINE_STAGES.VERIFY_DOWNLOADS,
    lastError: ""
  });
  emitEvent("verify_downloads_start", {
    runDir: state.runDir,
    downloadResultCount: state.downloadResults.length
  });

  const failed = [];
  for (const result of state.downloadResults) {
    if (result.status !== "downloaded") {
      failed.push(`${result.title}: status=${result.status}`);
      continue;
    }
    if (!isDownloadedResultUsable(result)) {
      failed.push(`${result.title}: missing file ${result.downloadPath || "(empty path)"}`);
    }
  }

  if (failed.length) {
    throw new Error(`Download verification failed: ${failed.join("; ")}`);
  }
  emitEvent("verify_downloads_finish", {
    runDir: state.runDir,
    verifiedCount: state.downloadResults.length
  });
}

async function maybePauseForManualConfirmation(state, options) {
  if (state.mode !== "manual") {
    return false;
  }

  if (state.stage === PIPELINE_STAGES.WAIT_USER_CONFIRM && fs.existsSync(state.queueCsv)) {
    console.log("[manual] queue confirmed by rerun, continuing downloads.");
    updateState(state, {
      stage: PIPELINE_STAGES.QUEUE_READY,
      waitingForUser: false,
      lastError: ""
    });
    return false;
  }

  updateState(state, {
    stage: PIPELINE_STAGES.WAIT_USER_CONFIRM,
    waitingForUser: true,
    lastError: ""
  });
  console.log(`[manual] review and edit ${state.queueCsv}, then rerun with --resume-run "${state.runDir}".`);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const state = initializeRun(options);
  emitRunMarker(state);

  try {
    updateState(state, {
      stage: state.stage === PIPELINE_STAGES.WAIT_USER_CONFIRM ? state.stage : PIPELINE_STAGES.INIT,
      lastError: ""
    });

    await ensureCandidates(state, options);

    if (!fs.existsSync(state.queueCsv) || !readCsvRows(state.queueCsv).length) {
      ensureQueueFromCandidates(state);
    } else if (!state.selectedTitles.length) {
      const queueRows = readCsvRows(state.queueCsv);
      updateState(state, {
        selectedTitles: queueRows.map((row) => row.title).filter(Boolean)
      });
    }

    const shouldPause = await maybePauseForManualConfirmation(state, options);
    if (shouldPause) {
      return;
    }

    await runDownloadQueue(state, options);
    verifyDownloadResults(state);
    if (getBoolEnv("PIPELINE_SKIP_WORK_REPORT", false)) {
      emitEvent("work_report_skipped", {
        runDir: state.runDir,
        reason: "PIPELINE_SKIP_WORK_REPORT"
      });
      updateState(state, {
        metadata: {
          ...state.metadata,
          workReportSkipped: true,
          workReportSkipReason: "PIPELINE_SKIP_WORK_REPORT"
        }
      });
    } else {
      updateState(state, {
        stage: PIPELINE_STAGES.WRITE_WORK_REPORT,
        lastError: ""
      });
      try {
        await generateWorkSummaryReport(state, options);
      } catch (error) {
        if (!getBoolEnv("PIPELINE_CONTINUE_ON_WORK_REPORT_FAILURE", true)) {
          throw error;
        }
        const message = error?.message || String(error || "");
        emitEvent("work_report_failed", {
          runDir: state.runDir,
          message
        });
        updateState(state, {
          metadata: {
            ...state.metadata,
            workReportFailed: true,
            workReportError: message
          }
        });
      }
    }

    updateState(state, {
      stage: PIPELINE_STAGES.DONE,
      currentDownloadIndex: 0,
      currentDownloadTitle: "",
      waitingForUser: false,
      lastError: ""
    });
    emitEvent("pipeline_complete", {
      runDir: state.runDir,
      stage: PIPELINE_STAGES.DONE
    });
  } catch (error) {
    updateState(state, {
      stage: PIPELINE_STAGES.FAILED,
      lastError: error?.message || String(error || "")
    });
    emitEvent("pipeline_complete", {
      runDir: state.runDir,
      stage: PIPELINE_STAGES.FAILED,
      error: state.lastError
    });
    console.error(`[pipeline] ${state.lastError}`);
    process.exitCode = 1;
  }
}

main();
