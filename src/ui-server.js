const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const PIPELINE_DIR = path.join(ROOT_DIR, "Chinese paper search", "cnkiLRspider");
const OUTPUTS_DIR = path.join(PIPELINE_DIR, "outputs");
const UI_DIR = path.join(ROOT_DIR, "ui");
const TOPIC_FILE = path.join(PIPELINE_DIR, "topic-ui.txt");
const HOST = process.env.UI_HOST || "127.0.0.1";
const PORT = Number(process.env.UI_PORT || "3210");

const activeRun = {
  child: null,
  command: "",
  startedAt: "",
  logLines: [],
};

function buildActiveAlert(logs, status) {
  if (status?.waiting_for_verification) {
    return {
      active: true,
      level: "warning",
      title: "需要人工验证",
      message: "CNKI 正在等待你完成安全验证。处理完浏览器里的验证后，流程会自动继续。",
    };
  }

  const joined = (logs || []).join("\n");
  const lastDetected = joined.lastIndexOf("CNKI security verification detected");
  const lastCleared = joined.lastIndexOf("CNKI security verification cleared");

  if (lastDetected !== -1 && lastDetected > lastCleared) {
    return {
      active: true,
      level: "warning",
      title: "需要人工验证",
      message: "CNKI 正在等待你完成安全验证。验证完成后，不用再点按钮，流程会自动往下跑。",
    };
  }

  if (lastCleared !== -1 && lastCleared >= lastDetected) {
    return {
      active: false,
      level: "info",
      title: "验证已通过",
      message: "刚刚的人工验证已经通过，流程正在继续。",
    };
  }

  return {
    active: false,
    level: "idle",
    title: "",
    message: "",
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(text);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function appendLog(line) {
  const text = String(line || "").trimEnd();
  if (!text) return;
  activeRun.logLines.push(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${text}`);
  if (activeRun.logLines.length > 500) {
    activeRun.logLines = activeRun.logLines.slice(-500);
  }
}

function listRunDirs() {
  if (!fs.existsSync(OUTPUTS_DIR)) return [];
  return fs
    .readdirSync(OUTPUTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "_llm_debug")
    .map((entry) => {
      const fullPath = path.join(OUTPUTS_DIR, entry.name);
      const stat = fs.statSync(fullPath);
      return { name: entry.name, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function getLatestRun() {
  const [latest] = listRunDirs();
  if (!latest) return null;
  return latest.fullPath;
}

function stageLabel(stage) {
  const mapping = {
    initialized: "已初始化",
    strategy_round1: "正在开专家会",
    strategy_round1_done: "专家会完成",
    awaiting_strategy_approval: "等待确认策略",
    searching: "正在知网检索",
    kimi_map_batch: "正在分析摘要",
    kimi_map_batch_done: "摘要分析完成",
    kimi_reduce_round2: "正在二轮策略讨论",
    kimi_reduce_round2_done: "二轮策略完成",
    awaiting_download_selection: "等待确认下载清单",
    final_reduce: "正在生成总结",
    ready_for_download: "已生成下载队列",
    failed: "运行失败",
    paused: "已暂停",
  };
  return mapping[stage] || stage || "未知状态";
}

function buildActionHint(status) {
  if (!status) return "还没有运行记录。先输入主题，点击“运行专家会”。";
  if (status.waiting_for_verification) {
    return "现在需要你切到浏览器，完成 CNKI 安全验证。验证结束后页面会继续跑。";
  }
  if (status.stage === "awaiting_strategy_approval") {
    return "专家会已经结束。你先看下面的人话报告，确认没问题后点击“继续知网检索”。";
  }
  if (status.stage === "awaiting_download_selection") {
    return "知网检索已经结束，下一步是勾选准备下载的文献。";
  }
  if (status.stage === "ready_for_download") {
    return "下载队列已经生成，下一步可以接思学图书馆/VPN 下载流程。";
  }
  if (status.stage === "failed") {
    return `流程中断了：${status.error || "未知错误"}。`;
  }
  if (activeRun.child) {
    return "流程正在运行中，你可以盯着状态区和日志区，不需要回命令行。";
  }
  return "当前没有进行中的任务。";
}

function buildHumanReport(strategy, status) {
  if (!strategy) {
    return {
      title: "还没有可读报告",
      overview:
        "当前还没有可用的策略文件，所以网页上暂时无法生成自然语言报告。先运行专家会，等策略文件产出后这里会自动刷新。",
      sections: [],
    };
  }

  const alternateQueries = Array.isArray(strategy.alternate_queries) ? strategy.alternate_queries : [];
  const directionNames = alternateQueries.map((item) => item.name).filter(Boolean);
  const excludeTerms = Array.isArray(strategy.exclude_terms) ? strategy.exclude_terms : [];
  const priorityAspects = Array.isArray(strategy.priority_aspects) ? strategy.priority_aspects : [];
  const qualityHints = Array.isArray(strategy.quality_hints) ? strategy.quality_hints : [];

  return {
    title: strategy.topic || "检索策略报告",
    overview:
      `这轮专家会的结论是：不要直接拿大而空的关键词去知网乱搜，而是把题目拆成 ${alternateQueries.length + 1} 条线来搜。` +
      `核心线负责“先查准”，确保结果真的围绕欧阳修、《醉翁亭记》以及庆历、滁州、贬谪、古文运动这些主轴；` +
      `分线再分别补“政治背景、地方治理、文学地位、文本接受、内部修辞、比较研究”几个角度。`,
    sections: [
      {
        heading: "这次准备怎么搜",
        body:
          "先用一条核心检索式把范围卡住，再用多条分检索式把不同研究方向补全。这样做的目的不是一次搜完，而是先保证准，再补齐漏掉的重要论文。",
      },
      {
        heading: "核心检索式在干什么",
        body:
          `核心式是：${strategy.core_query?.expression || "暂无"}。` +
          `它的意思很简单：必须同时碰到“欧阳修”和“醉翁亭记”，再去交叉“庆历、滁州、贬谪、古文运动、记体”等背景词，` +
          `同时主动排除“教学、赏析、译文、旅游”等噪音。`,
      },
      {
        heading: "重点分成哪几路补搜",
        items: [
          {
            title: "庆历政治与党争背景",
            detail:
              "用来找《醉翁亭记》背后的政治语境，重点看庆历新政失败、朋党、贬滁这些历史背景。",
          },
          {
            title: "滁州地域与地方治理",
            detail:
              "用来找欧阳修在滁州任内的治理实践、空间书写和“与民同乐”之间的关系。",
          },
          {
            title: "古文运动与文体范式",
            detail:
              "用来回答《醉翁亭记》在欧阳修文学里到底占什么位置，尤其是它在记体、古文运动、宋代散文转型中的作用。",
          },
          {
            title: "文本接受与经典化",
            detail:
              "用来找后世怎么讲、怎么选、怎么评《醉翁亭记》，也就是它是怎样一步步变成经典的。",
          },
          {
            title: "文本内部与文学思想",
            detail:
              "用来找更细的文章内部研究，比如修辞、结构、“也”字句法，以及它和欧阳修文学思想的关系。",
          },
          {
            title: "比较视野与贬谪书写",
            detail:
              "用来把它放到更大的贬谪文学里，和柳宗元等人的亭台记、贬谪书写放在一起看。",
          },
        ],
      },
      {
        heading: "哪些结果一眼就该排除",
        body: `优先排除这些方向：${excludeTerms.slice(0, 12).join("、")}。这些大多不是研究文献，而是中学语文、课堂教学、白话翻译、旅游介绍。`,
      },
      {
        heading: "最后要拿到什么样的文献",
        body:
          `优先抓 ${qualityHints.join("、")} 这类结果。真正有用的，不只是标题里直接出现《醉翁亭记》的文章，` +
          `还包括标题看起来更宏观、但摘要里明确讨论欧阳修贬滁、庆历政治或宋代记体散文的论文。`,
      },
      {
        heading: "接下来怎么推进",
        body:
          status?.stage === "awaiting_strategy_approval"
            ? "现在专家会已经结束，下一步就是带着这套策略进入知网执行检索。你不用再回命令行，直接点“继续知网检索”就行。"
            : buildActionHint(status),
      },
      {
        heading: "本轮重点",
        body: priorityAspects.join("、"),
      },
    ],
    rawStrategy: strategy,
    directionNames,
  };
}

function collectRunData(runDir) {
  if (!runDir) return null;
  const status = readJsonSafe(path.join(runDir, "run_status.json"));
  const strategy = readJsonSafe(path.join(runDir, "strategy_round1.json"));
  const report = buildHumanReport(strategy, status);
  const files = {
    runDir,
    statusPath: path.join(runDir, "run_status.json"),
    strategyPath: path.join(runDir, "strategy_round1.json"),
    discussionPath: path.join(runDir, "expert_discussion_round1.md"),
  };
  return { runDir, status, strategy, report, files };
}

function parseJsonBody(body) {
  if (!body) return {};
  return JSON.parse(body);
}

function startPipeline(args, logLabel) {
  if (activeRun.child) {
    throw new Error("当前已经有一个流程在运行，请先等它结束。");
  }

  const env = {
    ...process.env,
    CNKI_VERIFY_TIMEOUT: process.env.CNKI_VERIFY_TIMEOUT || "1800",
    CNKI_MAX_PAGES_PER_VIEW: process.env.CNKI_MAX_PAGES_PER_VIEW || "2",
    CNKI_MAP_BATCH_SIZE: process.env.CNKI_MAP_BATCH_SIZE || "12",
    CNKI_DOWNLOAD_CANDIDATES: process.env.CNKI_DOWNLOAD_CANDIDATES || "15",
    EXPERT_MEETING_PAUSE_SECONDS: process.env.EXPERT_MEETING_PAUSE_SECONDS || "0.5",
    KIMI_MAX_TOKENS: process.env.KIMI_MAX_TOKENS || "8192",
    KIMI_MAX_TOKENS_CAP: process.env.KIMI_MAX_TOKENS_CAP || "12000",
    PYTHONUTF8: "1",
  };

  const child = spawn("python", args, {
    cwd: PIPELINE_DIR,
    env,
    windowsHide: true,
  });

  activeRun.child = child;
  activeRun.command = `python ${args.join(" ")}`;
  activeRun.startedAt = new Date().toISOString();
  activeRun.logLines = [];
  appendLog(`开始执行：${logLabel}`);

  child.stdout.on("data", (chunk) => appendLog(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => appendLog(chunk.toString("utf8")));
  child.on("close", (code) => {
    appendLog(`流程结束，退出码：${code}`);
    activeRun.child = null;
  });
  child.on("error", (error) => {
    appendLog(`流程启动失败：${error.message}`);
    activeRun.child = null;
  });
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(UI_DIR, safePath.replace(/^\/+/, ""));
  if (!filePath.startsWith(UI_DIR) || !fs.existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  sendText(res, 200, fs.readFileSync(filePath), typeMap[ext] || "application/octet-stream");
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/state") {
    const latestRun = getLatestRun();
    const runData = collectRunData(latestRun);
    const activeAlert = buildActiveAlert(activeRun.logLines, runData?.status);
    sendJson(res, 200, {
      activeProcess: {
        running: Boolean(activeRun.child),
        command: activeRun.command,
        startedAt: activeRun.startedAt,
        logs: activeRun.logLines.slice(-120),
      },
      activeAlert,
      latestRun: runData,
      runs: listRunDirs().slice(0, 8).map((item) => ({
        name: item.name,
        runDir: item.fullPath,
      })),
      actionHint: buildActionHint(runData?.status),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/expert-meeting") {
    const body = parseJsonBody(await readRequestBody(req));
    const topic = String(body.topic || "").trim();
    if (!topic) {
      sendJson(res, 400, { error: "请先输入主题。" });
      return;
    }
    fs.writeFileSync(TOPIC_FILE, topic, "utf8");
    startPipeline(["research_pipeline.py", "--topic-file", TOPIC_FILE], `专家会：${topic}`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/approve-strategy") {
    const body = parseJsonBody(await readRequestBody(req));
    const runDir = String(body.runDir || getLatestRun() || "").trim();
    if (!runDir) {
      sendJson(res, 400, { error: "没有找到可继续的运行目录。" });
      return;
    }
    const status = readJsonSafe(path.join(runDir, "run_status.json"));
    const topic = String(status?.topic || "").trim();
    if (!topic) {
      sendJson(res, 400, { error: "没有找到该运行目录对应的主题。" });
      return;
    }
    fs.writeFileSync(TOPIC_FILE, topic, "utf8");
    startPipeline(
      ["research_pipeline.py", "--topic-file", TOPIC_FILE, "--resume-dir", runDir, "--approve-strategy"],
      `继续知网检索：${runDir}`
    );
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "API not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`UI server running at http://${HOST}:${PORT}`);
});
