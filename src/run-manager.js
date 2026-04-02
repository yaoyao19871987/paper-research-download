const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { spawn, spawnSync } = require("child_process");
const { ensureDir } = require("./common");

const ROOT_DIR = path.resolve(__dirname, "..");
const SEARCH_DIR = path.join(ROOT_DIR, "python-scraper", "cnkiLRspider");
const OUTPUT_ROOT = path.join(SEARCH_DIR, "outputs");
const STATE_DIR = path.join(ROOT_DIR, "state");
const MANAGER_STATE_PATH = path.join(STATE_DIR, "console-manager.json");
const MANAGER_LOG_DIR = path.join(STATE_DIR, "console-logs");
const PIPELINE_SCRIPT = path.join(ROOT_DIR, "src", "pipeline-runner.js");
const PIPELINE_RUN_MARKER = "__PIPELINE_RUN__";
const PIPELINE_STAGE_MARKER = "__PIPELINE_STAGE__";
const PIPELINE_EVENT_MARKER = "__PIPELINE_EVENT__";

function nowIso() {
  return new Date().toISOString();
}

function createRunId(prefix = "run") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}`;
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readText(filePath, fallback = "") {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function fileStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  if (!pid || !Number.isFinite(Number(pid))) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function withinRoot(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.toLowerCase().startsWith(ROOT_DIR.toLowerCase());
}

function listRunDirs() {
  if (!fileExists(OUTPUT_ROOT)) {
    return [];
  }
  return fs
    .readdirSync(OUTPUT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(OUTPUT_ROOT, entry.name);
      const stat = fileStat(fullPath);
      const looksLikeRunDir =
        fileExists(path.join(fullPath, "run_status.json")) ||
        fileExists(path.join(fullPath, "pipeline_state.json")) ||
        fileExists(path.join(fullPath, "input_topic.txt"));
      return {
        name: entry.name,
        fullPath,
        mtimeMs: stat ? stat.mtimeMs : 0,
        looksLikeRunDir
      };
    })
    .filter((item) => item.looksLikeRunDir)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function splitStreamLines(stream, onLine) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const part of parts) {
      onLine(part);
    }
  });
  stream.on("end", () => {
    if (buffer) {
      onLine(buffer);
      buffer = "";
    }
  });
}

function parseMarkerLine(prefix, line) {
  if (!String(line || "").startsWith(prefix)) {
    return null;
  }
  try {
    return JSON.parse(String(line).slice(prefix.length));
  } catch {
    return null;
  }
}

function previewText(text, limit = 12000) {
  const value = String(text || "").trim();
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n\n...[truncated]`;
}

function makeFileEntry(label, filePath, kind = "text") {
  const stat = fileStat(filePath);
  return {
    label,
    path: filePath,
    exists: Boolean(stat),
    size: stat ? stat.size : 0,
    updatedAt: stat ? stat.mtime.toISOString() : "",
    kind
  };
}

function latestExistingFile(candidates) {
  for (const filePath of candidates) {
    if (fileExists(filePath)) {
      return filePath;
    }
  }
  return "";
}

function pythonCommandAvailable(args) {
  const result = spawnSync("python", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    output: String(result.stdout || result.stderr || "").trim()
  };
}

class RunManager extends EventEmitter {
  constructor() {
    super();
    ensureDir(STATE_DIR);
    ensureDir(MANAGER_LOG_DIR);
    ensureDir(OUTPUT_ROOT);
    this.child = null;
    this.childRunId = "";
    this.state = this._loadState();
    this._normalizeRecoveredState();
  }

  _loadState() {
    return readJson(MANAGER_STATE_PATH, {
      activeRun: null,
      recentRuns: []
    });
  }

  _saveState() {
    writeJson(MANAGER_STATE_PATH, this.state);
  }

  _normalizeRecoveredState() {
    if (!this.state || typeof this.state !== "object") {
      this.state = { activeRun: null, recentRuns: [] };
    }
    if (!Array.isArray(this.state.recentRuns)) {
      this.state.recentRuns = [];
    }
    if (this.state.activeRun) {
      this.state.activeRun.processRunning = isProcessRunning(this.state.activeRun.pid);
      if (!this.state.activeRun.processRunning && !this.state.activeRun.processState) {
        this.state.activeRun.processState = "exited";
      }
    }
    this._saveState();
  }

  _replaceRecentRun(nextRun) {
    const current = Array.isArray(this.state.recentRuns) ? this.state.recentRuns : [];
    const filtered = current.filter((item) => item.runId !== nextRun.runId);
    this.state.recentRuns = [nextRun, ...filtered].slice(0, 25);
  }

  _updateActiveRun(patch) {
    if (!this.state.activeRun) {
      return;
    }
    this.state.activeRun = {
      ...this.state.activeRun,
      ...patch,
      updatedAt: nowIso()
    };
    this.state.activeRun.processRunning = isProcessRunning(this.state.activeRun.pid);
    this._replaceRecentRun(this.state.activeRun);
    this._saveState();
    this.emit("state", this.state.activeRun);
  }

  _clearActiveRun(patch = {}) {
    if (!this.state.activeRun) {
      return;
    }
    const finished = {
      ...this.state.activeRun,
      ...patch,
      updatedAt: nowIso(),
      processRunning: false
    };
    this._replaceRecentRun(finished);
    this.state.activeRun = null;
    this._saveState();
    this.emit("state", finished);
  }

  _appendLog(logPath, line) {
    ensureDir(path.dirname(logPath));
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  }

  _handleMarker(line) {
    const activeRun = this.state.activeRun;
    if (!activeRun) {
      return;
    }

    const runMarker = parseMarkerLine(PIPELINE_RUN_MARKER, line);
    if (runMarker) {
      this._updateActiveRun({
        topic: runMarker.topic || activeRun.topic,
        mode: runMarker.mode || activeRun.mode,
        runDir: runMarker.runDir || activeRun.runDir,
        lastMarker: "run",
        lastMarkerPayload: runMarker
      });
      return;
    }

    const stageMarker = parseMarkerLine(PIPELINE_STAGE_MARKER, line);
    if (stageMarker) {
      this._updateActiveRun({
        runDir: stageMarker.runDir || activeRun.runDir,
        stage: stageMarker.stage || activeRun.stage,
        lastMarker: "stage",
        lastMarkerPayload: stageMarker,
        lastError: stageMarker.lastError || ""
      });
      return;
    }

    const eventMarker = parseMarkerLine(PIPELINE_EVENT_MARKER, line);
    if (eventMarker) {
      const patch = {
        runDir: eventMarker.runDir || activeRun.runDir,
        lastEventType: eventMarker.type || "",
        lastMarker: "event",
        lastMarkerPayload: eventMarker
      };
      if (eventMarker.stage) {
        patch.stage = eventMarker.stage;
      }
      if (eventMarker.type === "pipeline_complete") {
        patch.processState = eventMarker.stage === "DONE" ? "done" : "failed";
        patch.exitCode = eventMarker.stage === "DONE" ? 0 : 1;
        patch.lastError = eventMarker.error || "";
      }
      this._updateActiveRun(patch);
    }
  }

  _attachChild(runId, child, logPath) {
    this.child = child;
    this.childRunId = runId;

    splitStreamLines(child.stdout, (line) => {
      this._appendLog(logPath, line);
      this._handleMarker(line);
      this._updateActiveRun({
        lastOutputAt: nowIso()
      });
    });

    splitStreamLines(child.stderr, (line) => {
      this._appendLog(logPath, `[stderr] ${line}`);
      this._updateActiveRun({
        lastOutputAt: nowIso(),
        lastError: line
      });
    });

    child.on("error", (error) => {
      this._appendLog(logPath, `[manager] spawn error: ${error.message || error}`);
      if (this.state.activeRun && this.state.activeRun.runId === runId) {
        this._clearActiveRun({
          processState: "failed",
          exitCode: 1,
          lastError: error.message || String(error || "")
        });
      }
      this.child = null;
      this.childRunId = "";
    });

    child.on("close", (code, signal) => {
      this._appendLog(logPath, `[manager] child closed code=${code} signal=${signal || ""}`);
      if (this.state.activeRun && this.state.activeRun.runId === runId) {
        this._clearActiveRun({
          processState: code === 0 ? "done" : "failed",
          exitCode: Number.isFinite(code) ? code : null,
          signal: signal || ""
        });
      }
      this.child = null;
      this.childRunId = "";
    });
  }

  _spawnPipeline({ args, topic = "", mode = "auto", downloadLimit = 20, requestedRunDir = "" }) {
    const current = this.state.activeRun;
    if (current && current.processRunning) {
      throw new Error("A pipeline run is already active. Stop it before starting another one.");
    }

    const runId = createRunId("console");
    const logPath = path.join(MANAGER_LOG_DIR, `${runId}.log`);
    const commandArgs = [PIPELINE_SCRIPT, ...args];
    const child = spawn(process.execPath, commandArgs, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1"
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const activeRun = {
      runId,
      topic,
      mode,
      downloadLimit,
      requestedRunDir,
      runDir: requestedRunDir,
      pid: child.pid,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      processState: "running",
      processRunning: true,
      stage: "LAUNCHING",
      exitCode: null,
      logPath,
      command: [process.execPath, ...commandArgs].join(" ")
    };

    this.state.activeRun = activeRun;
    this._replaceRecentRun(activeRun);
    this._saveState();
    this._appendLog(logPath, `$ ${activeRun.command}`);
    this._attachChild(runId, child, logPath);
    return this.getRunSnapshot(runId);
  }

  startRun({ topic, downloadLimit = 20, mode = "auto" }) {
    const normalizedTopic = String(topic || "").trim();
    if (!normalizedTopic) {
      throw new Error("Topic is required.");
    }
    const args = ["--topic", normalizedTopic, "--download-limit", String(downloadLimit)];
    if (mode === "manual") {
      args.push("--mode", "manual");
    }
    return this._spawnPipeline({
      args,
      topic: normalizedTopic,
      mode,
      downloadLimit
    });
  }

  resumeRun({ runDir, downloadLimit = 20, mode = "auto" }) {
    const normalizedRunDir = path.resolve(String(runDir || "").trim());
    if (!normalizedRunDir || !fileExists(normalizedRunDir)) {
      throw new Error("Resume run directory does not exist.");
    }
    const topicText = readText(path.join(normalizedRunDir, "input_topic.txt")).trim();
    const args = ["--resume-run", normalizedRunDir, "--download-limit", String(downloadLimit)];
    if (mode === "manual") {
      args.push("--mode", "manual");
    }
    return this._spawnPipeline({
      args,
      topic: topicText,
      mode,
      downloadLimit,
      requestedRunDir: normalizedRunDir
    });
  }

  continueActiveRun() {
    if (!this.child || !this.state.activeRun || this.childRunId !== this.state.activeRun.runId) {
      throw new Error("The active run is not attached to this console process, so continue is unavailable.");
    }
    if (!this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("The active run stdin is unavailable.");
    }
    this.child.stdin.write("continue\n");
    this._appendLog(this.state.activeRun.logPath, "[manager] sent continue");
    this._updateActiveRun({
      lastOutputAt: nowIso()
    });
    return this.getActiveRunSnapshot();
  }

  stopActiveRun() {
    const active = this.state.activeRun;
    if (!active) {
      throw new Error("There is no active run.");
    }

    if (this.child && this.childRunId === active.runId) {
      this.child.kill();
    } else if (active.pid && isProcessRunning(active.pid)) {
      process.kill(active.pid);
    }

    this._clearActiveRun({
      processState: "stopped",
      exitCode: null
    });
    return {
      ok: true,
      runId: active.runId
    };
  }

  getActiveRunSummary() {
    const active = this.state.activeRun;
    if (!active) {
      return null;
    }
    return {
      ...active,
      processRunning: isProcessRunning(active.pid)
    };
  }

  getLatestRunDir() {
    const latest = listRunDirs()[0];
    return latest ? latest.fullPath : "";
  }

  _findKnownRun(runId) {
    if (!runId) {
      return null;
    }
    if (this.state.activeRun && this.state.activeRun.runId === runId) {
      return this.state.activeRun;
    }
    return this.state.recentRuns.find((item) => item.runId === runId) || null;
  }

  _buildKeyFiles(runDir, managerRun, pipelineState) {
    if (!runDir) {
      return managerRun && managerRun.logPath ? [makeFileEntry("Console runtime log", managerRun.logPath)] : [];
    }

    const metadata = pipelineState && pipelineState.metadata ? pipelineState.metadata : {};
    const files = [
      makeFileEntry("Console runtime log", managerRun.logPath),
      makeFileEntry("Run directory", runDir, "directory"),
      makeFileEntry("Input topic", path.join(runDir, "input_topic.txt")),
      makeFileEntry("Pipeline state", path.join(runDir, "pipeline_state.json")),
      makeFileEntry("Run status", path.join(runDir, "run_status.json")),
      makeFileEntry("Pipeline result", path.join(runDir, "pipeline_result.json")),
      makeFileEntry("Strategy round 1", path.join(runDir, "strategy_round1.json")),
      makeFileEntry("Candidate review", path.join(runDir, "candidate_review.md")),
      makeFileEntry("Download candidates", path.join(runDir, "papers_for_download.csv")),
      makeFileEntry("Download queue", path.join(runDir, "download_queue.csv")),
      makeFileEntry("Analysis summary", path.join(runDir, "analysis_summary.md")),
      makeFileEntry("Work summary", metadata.workReportPath || path.join(runDir, "work_summary_report.md")),
      makeFileEntry("Project work report", metadata.projectWorkReportPath || "")
    ];
    return files.filter((item) => item.path);
  }

  _buildReportPreview(runDir, pipelineState) {
    if (!runDir) {
      return { path: "", content: "" };
    }
    const metadata = pipelineState && pipelineState.metadata ? pipelineState.metadata : {};
    const reportPath = latestExistingFile([
      metadata.workReportPath || "",
      metadata.projectWorkReportPath || "",
      path.join(runDir, "work_summary_report.md"),
      path.join(runDir, "analysis_summary.md"),
      path.join(runDir, "candidate_review.md")
    ]);
    return {
      path: reportPath,
      content: reportPath ? previewText(readText(reportPath)) : ""
    };
  }

  getRunSnapshot(runId) {
    const managerRun =
      runId === "latest" && !this._findKnownRun("latest")
        ? null
        : this._findKnownRun(runId);

    const latestRunDir = runId === "latest" ? this.getLatestRunDir() : "";
    const runDir = managerRun ? managerRun.runDir || managerRun.requestedRunDir || "" : latestRunDir;
    const resolvedRunDir = runDir && fileExists(runDir) ? runDir : "";

    const pipelineState = resolvedRunDir ? readJson(path.join(resolvedRunDir, "pipeline_state.json"), {}) : {};
    const pipelineResult = resolvedRunDir ? readJson(path.join(resolvedRunDir, "pipeline_result.json"), {}) : {};
    const runStatus = resolvedRunDir ? readJson(path.join(resolvedRunDir, "run_status.json"), {}) : {};
    const reportPreview = this._buildReportPreview(resolvedRunDir, pipelineState);
    const keyFiles = this._buildKeyFiles(resolvedRunDir, managerRun || { logPath: "" }, pipelineState);

    return {
      runId: managerRun ? managerRun.runId : "",
      manager: managerRun
        ? {
            ...managerRun,
            processRunning: isProcessRunning(managerRun.pid)
          }
        : null,
      runDir: resolvedRunDir,
      pipelineState,
      pipelineResult,
      runStatus,
      reportPreview,
      keyFiles
    };
  }

  getActiveRunSnapshot() {
    const active = this.getActiveRunSummary();
    if (!active) {
      return null;
    }
    return this.getRunSnapshot(active.runId);
  }

  readLog(runId, cursor = null, maxBytes = 65536) {
    const snapshot = this.getRunSnapshot(runId);
    const logPath =
      snapshot && snapshot.manager && snapshot.manager.logPath
        ? snapshot.manager.logPath
        : snapshot && snapshot.keyFiles
          ? (snapshot.keyFiles.find((item) => item.label === "Console runtime log") || {}).path
          : "";

    if (!logPath || !fileExists(logPath)) {
      return {
        logPath,
        cursor: 0,
        size: 0,
        hasMore: false,
        text: ""
      };
    }

    const stat = fileStat(logPath);
    const size = stat ? stat.size : 0;
    let start = Number.isFinite(Number(cursor)) ? Number(cursor) : null;
    if (start === null) {
      start = Math.max(0, size - maxBytes);
    }
    if (start > size) {
      start = Math.max(0, size - maxBytes);
    }

    const toRead = Math.min(maxBytes, Math.max(0, size - start));
    const buffer = Buffer.alloc(toRead);
    const fd = fs.openSync(logPath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, toRead, start);
    fs.closeSync(fd);

    return {
      logPath,
      cursor: start + bytesRead,
      size,
      hasMore: start + bytesRead < size,
      text: buffer.toString("utf8", 0, bytesRead)
    };
  }

  readFilePreview(filePath, limit = 200000) {
    const resolved = path.resolve(String(filePath || ""));
    if (!resolved || !withinRoot(resolved)) {
      throw new Error("File path is outside the workspace.");
    }
    const extension = path.extname(resolved).toLowerCase();
    const allowed = new Set([".md", ".txt", ".json", ".log", ".csv", ".html"]);
    if (!allowed.has(extension)) {
      throw new Error("Preview is only available for text-like files.");
    }
    const content = readText(resolved, "");
    return {
      path: resolved,
      content: previewText(content, limit)
    };
  }

  runPreflightChecks({ resolveSiteCredentials }) {
    const checks = [];

    const envPath = path.join(ROOT_DIR, ".env");
    checks.push({
      key: "env",
      ok: fileExists(envPath),
      required: false,
      message: fileExists(envPath) ? `.env found at ${envPath}` : "No .env file found; environment overrides may still come from .env.<name>."
    });

    const selectorsPath = path.join(ROOT_DIR, "config", "selectors.json");
    checks.push({
      key: "selectors",
      ok: fileExists(selectorsPath),
      required: true,
      message: fileExists(selectorsPath)
        ? `selectors ready at ${selectorsPath}`
        : "Missing config/selectors.json. Copy config/selectors.example.json first."
    });

    checks.push({
      key: "pipeline-script",
      ok: fileExists(PIPELINE_SCRIPT),
      required: true,
      message: fileExists(PIPELINE_SCRIPT)
        ? `pipeline entry found at ${PIPELINE_SCRIPT}`
        : "Missing src/pipeline-runner.js."
    });

    checks.push({
      key: "research-script",
      ok: fileExists(path.join(SEARCH_DIR, "research_pipeline.py")),
      required: true,
      message: fileExists(path.join(SEARCH_DIR, "research_pipeline.py"))
        ? `research entry found at ${path.join(SEARCH_DIR, "research_pipeline.py")}`
        : "Missing python-scraper/cnkiLRspider/research_pipeline.py."
    });

    const pythonVersion = pythonCommandAvailable(["--version"]);
    checks.push({
      key: "python",
      ok: pythonVersion.ok,
      required: true,
      message: pythonVersion.ok ? pythonVersion.output : "Python is unavailable from PATH."
    });

    const credentialBundle = resolveSiteCredentials({});
    checks.push({
      key: "site-credentials",
      ok: Boolean(credentialBundle.username && credentialBundle.password),
      required: true,
      message: credentialBundle.username && credentialBundle.password
        ? `site credentials available from ${credentialBundle.source}`
        : "Library username/password are unavailable from explicit input, vault, or environment."
    });

    const authStatePath = path.join(ROOT_DIR, "state", "auth.json");
    checks.push({
      key: "auth-state",
      ok: fileExists(authStatePath),
      required: false,
      message: fileExists(authStatePath)
        ? `existing auth state found at ${authStatePath}`
        : "No auth state cached yet; the first run may require login."
    });

    const kimiCheck = pythonCommandAvailable([
      "-c",
      [
        "import sys",
        `sys.path.insert(0, r'${SEARCH_DIR.replace(/\\/g, "\\\\")}')`,
        "from kimi_client import KimiClient",
        "client = KimiClient()",
        "print('Kimi credential available' if getattr(client, 'token', '') else 'Kimi credential missing')"
      ].join("; ")
    ]);
    checks.push({
      key: "kimi",
      ok: kimiCheck.ok,
      required: true,
      message: kimiCheck.ok ? kimiCheck.output : "Kimi credential could not be loaded by the Python client."
    });

    for (const dirName of ["downloads", "outputs", "work-reports"]) {
      const fullPath = path.join(ROOT_DIR, dirName);
      try {
        ensureDir(fullPath);
        fs.accessSync(fullPath, fs.constants.W_OK);
        checks.push({
          key: `dir-${dirName}`,
          ok: true,
          required: true,
          message: `writable directory ready at ${fullPath}`
        });
      } catch {
        checks.push({
          key: `dir-${dirName}`,
          ok: false,
          required: true,
          message: `directory is not writable: ${fullPath}`
        });
      }
    }

    const ready = checks.every((item) => item.ok || !item.required);
    return {
      ready,
      checkedAt: nowIso(),
      checks
    };
  }
}

module.exports = {
  ROOT_DIR,
  OUTPUT_ROOT,
  RunManager
};
