const topicInput = document.getElementById("topicInput");
const runMeetingBtn = document.getElementById("runMeetingBtn");
const approveBtn = document.getElementById("approveBtn");
const alertBanner = document.getElementById("alertBanner");
const alertTitle = document.getElementById("alertTitle");
const alertMessage = document.getElementById("alertMessage");

const stageText = document.getElementById("stageText");
const actionHint = document.getElementById("actionHint");
const runningText = document.getElementById("runningText");
const commandText = document.getElementById("commandText");
const runDirName = document.getElementById("runDirName");
const updatedAtText = document.getElementById("updatedAtText");
const reportTitle = document.getElementById("reportTitle");
const reportOverview = document.getElementById("reportOverview");
const reportSections = document.getElementById("reportSections");
const coreQueryText = document.getElementById("coreQueryText");
const fileList = document.getElementById("fileList");
const logBox = document.getElementById("logBox");

let latestState = null;
let lastAlertActive = false;

function playAlertTone() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  const context = new AudioCtx();
  const scheduleBeep = (delay, frequency, duration) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.001;
    oscillator.connect(gain);
    gain.connect(context.destination);
    const startAt = context.currentTime + delay;
    gain.gain.exponentialRampToValueAtTime(0.08, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.03);
  };
  scheduleBeep(0, 880, 0.18);
  scheduleBeep(0.24, 880, 0.18);
  scheduleBeep(0.48, 660, 0.26);
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSections(report) {
  if (!report || !Array.isArray(report.sections) || !report.sections.length) {
    reportSections.innerHTML = "<div class='report-block'><p>还没有报告内容。</p></div>";
    return;
  }

  reportSections.innerHTML = report.sections
    .map((section) => {
      const items = Array.isArray(section.items)
        ? `<div class="mini-list">${section.items
            .map(
              (item) => `
                <div class="mini-item">
                  <strong>${escapeHtml(item.title)}</strong>
                  <span>${escapeHtml(item.detail)}</span>
                </div>
              `
            )
            .join("")}</div>`
        : "";

      return `
        <section class="report-block">
          <h3>${escapeHtml(section.heading)}</h3>
          ${section.body ? `<p>${escapeHtml(section.body)}</p>` : ""}
          ${items}
        </section>
      `;
    })
    .join("");
}

function renderFiles(files) {
  if (!files) {
    fileList.innerHTML = "<div class='file-item'>暂无文件</div>";
    return;
  }

  const entries = [
    ["运行目录", files.runDir],
    ["状态文件", files.statusPath],
    ["策略文件", files.strategyPath],
    ["讨论文件", files.discussionPath],
  ].filter(([, value]) => value);

  fileList.innerHTML = entries
    .map(
      ([label, value]) => `
        <div class="file-item">
          <span class="label">${escapeHtml(label)}</span>
          <span class="path">${escapeHtml(value)}</span>
        </div>
      `
    )
    .join("");
}

function renderState(payload) {
  latestState = payload;
  const active = payload.activeProcess || {};
  const activeAlert = payload.activeAlert || {};
  const latestRun = payload.latestRun || {};
  const status = latestRun.status || {};
  const report = latestRun.report || {};

  stageText.textContent = status.stage ? status.stage.replaceAll("_", " ") : "未开始";
  actionHint.textContent = payload.actionHint || "等待操作";
  runningText.textContent = active.running ? "运行中" : "空闲";
  commandText.textContent = active.command || "当前没有后台任务。";
  runDirName.textContent = latestRun.runDir ? latestRun.runDir.split("\\").pop() : "暂无";
  updatedAtText.textContent = status.updated_at || "等待首次运行";

  reportTitle.textContent = report.title || "还没有报告";
  reportOverview.textContent = report.overview || "";
  renderSections(report);
  coreQueryText.textContent = latestRun.strategy?.core_query?.expression || "暂无";
  renderFiles(latestRun.files);
  logBox.textContent = (active.logs || []).join("\n") || "暂无日志";

  if (activeAlert.active) {
    alertBanner.classList.remove("hidden");
    alertTitle.textContent = activeAlert.title || "需要人工操作";
    alertMessage.textContent = activeAlert.message || "";
    document.title = "请处理人工验证 - 中文论文检索控制台";
  } else {
    alertBanner.classList.add("hidden");
    document.title = "中文论文检索控制台";
  }

  if (activeAlert.active && !lastAlertActive) {
    playAlertTone();
  }
  lastAlertActive = Boolean(activeAlert.active);

  const running = Boolean(active.running);
  runMeetingBtn.disabled = running;
  approveBtn.disabled = running || !latestRun.runDir;
}

async function refreshState() {
  const response = await fetch("/api/state");
  const payload = await response.json();
  renderState(payload);
}

async function postJson(url, data) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

runMeetingBtn.addEventListener("click", async () => {
  try {
    const topic = topicInput.value.trim();
    if (!topic) {
      alert("先输入主题。");
      return;
    }
    runMeetingBtn.disabled = true;
    await postJson("/api/expert-meeting", { topic });
    await refreshState();
  } catch (error) {
    alert(error.message);
  } finally {
    runMeetingBtn.disabled = false;
  }
});

approveBtn.addEventListener("click", async () => {
  try {
    const runDir = latestState?.latestRun?.runDir;
    if (!runDir) {
      alert("还没有可继续的运行目录。");
      return;
    }
    approveBtn.disabled = true;
    await postJson("/api/approve-strategy", { runDir });
    await refreshState();
  } catch (error) {
    alert(error.message);
  } finally {
    approveBtn.disabled = false;
  }
});

refreshState();
setInterval(refreshState, 3000);
