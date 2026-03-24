const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  ensureDir,
  readSelectors,
  getEnv,
  getBoolEnv,
  getNumEnv,
  timestampString
} = require("./common");
const { ensureLibrarySession } = require("./library-auth");
const { hasCaptcha, solveTextCaptcha } = require("./library-captcha");
const { resolveSiteCredentials } = require("./site-credentials");

const DEFAULT_PREFERRED_DOWNLOAD_SELECTORS = [
  "a:has-text('PDF1')",
  "a:has-text('PDF2')",
  "a:has-text('PDF\u4e0b\u8f7d')",
  "a[title*='PDF']",
  "a:has-text('\u70b9\u6b64\u4e0b\u8f7d')",
  "a:has-text('\u70b9\u51fb\u4e0b\u8f7d')",
  "a:has-text('\u4e0b\u8f7d')",
  "a[href*='download']",
  ".download a",
  ".download"
];

function hasCountdownText(text) {
  if (!text) return false;
  const normalized = text.replace(/\s+/g, "");
  const patterns = [
    /\d+\s*\u79d2/,
    /\u8bf7\u7b49\u5f85/,
    /\u5012\u8ba1\u65f6/,
    /\u540e\u53ef\u4e0b\u8f7d/,
    /\u540e\u91cd\u8bd5/,
    /\u9884\u8ba1\d+\s*-\s*\d+\s*\u79d2/,
    /remaining/i,
    /countdown/i,
    /wait/i
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function summarizeWaitState(disabled, triggerText, containerText) {
  const shortContainer = (containerText || "").replace(/\s+/g, " ").slice(0, 120);
  return `${disabled ? "D" : "E"}|${(triggerText || "").trim()}|${shortContainer}`;
}

function asSelectorList(configValue, fallbacks = []) {
  const decode = (selector) =>
    String(selector || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
      String.fromCharCode(parseInt(code, 16))
    );
  if (Array.isArray(configValue)) {
    return [...configValue.map(decode), ...fallbacks.map(decode)];
  }
  if (typeof configValue === "string" && configValue.trim()) {
    return [decode(configValue.trim()), ...fallbacks.map(decode)];
  }
  return [...fallbacks.map(decode)];
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (!count) continue;
      if (await locator.isVisible().catch(() => false)) {
        return { selector, locator };
      }
    } catch {
      // Ignore invalid fallback selectors.
    }
  }
  return null;
}

async function maybeSolvePageCaptcha(page, selectorGroup, label) {
  if (!(await hasCaptcha(page, selectorGroup))) {
    return false;
  }

  console.log(`Captcha detected on ${label}. Sending image to Kimi OCR...`);
  const solved = await solveTextCaptcha(page, selectorGroup, {
    label,
    submitAfterFill: true,
    verify: async () => {
      await page.waitForTimeout(getNumEnv("LIBRARY_CAPTCHA_VERIFY_WAIT_MS", 1800));
      return !(await hasCaptcha(page, selectorGroup));
    }
  });

  if (!solved.solved) {
    throw new Error(`Captcha on ${label} could not be solved.`);
  }

  console.log(`Captcha on ${label} recognized as: ${solved.text}`);
  return true;
}

async function waitUntilReady(
  page,
  selectors,
  pollIntervalMs,
  softTimeoutMs,
  hardTimeoutMs,
  progressGraceMs
) {
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastState = "";
  let softTimeoutLogged = false;

  while (Date.now() - startedAt < hardTimeoutMs) {
    await maybeSolvePageCaptcha(page, selectors.paper || selectors.login || {}, "download-page").catch(() => {});

    const triggerInfo = await firstVisibleLocator(
      page,
      asSelectorList(
        selectors?.paper?.preferredDownloadTriggers,
        asSelectorList(selectors?.paper?.downloadTrigger, DEFAULT_PREFERRED_DOWNLOAD_SELECTORS)
      )
    );

    if (triggerInfo) {
      const { locator } = triggerInfo;
      const disabled = await locator.isDisabled().catch(() => false);
      const triggerText = (await locator.innerText().catch(() => "")).trim();

      let containerText = "";
      if (selectors?.paper?.countdownContainer) {
        containerText = await page
          .locator(selectors.paper.countdownContainer)
          .first()
          .innerText()
          .catch(() => "");
      }

      const waiting = disabled || hasCountdownText(triggerText) || hasCountdownText(containerText);
      if (!waiting) {
        return;
      }

      const currentState = summarizeWaitState(disabled, triggerText, containerText);
      if (currentState !== lastState) {
        lastState = currentState;
        lastProgressAt = Date.now();
      }
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed > softTimeoutMs && !softTimeoutLogged) {
      softTimeoutLogged = true;
      console.log(
        `Download readiness exceeded soft timeout (${softTimeoutMs} ms); still waiting while page state changes.`
      );
    }

    const stagnantFor = Date.now() - lastProgressAt;
    if (elapsed > softTimeoutMs && stagnantFor > progressGraceMs) {
      throw new Error(
        `Download readiness stalled for ${stagnantFor} ms after soft timeout; page needs inspection.`
      );
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  throw new Error(`Waited up to hard timeout (${hardTimeoutMs} ms) and download is still not ready.`);
}

async function clickAndCaptureDownload(page, selector, timeoutMs) {
  const locator = page.locator(selector).first();
  const popupPromise = page.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
  await locator.click({ force: true });
  const popup = await popupPromise;
  const download = await downloadPromise;
  return { popup, download };
}

async function downloadFromPage(page, selectors, options, depth = 0) {
  if (depth > 2) {
    throw new Error("Exceeded maximum nested download-page depth.");
  }

  const {
    navTimeout,
    pollIntervalMs,
    downloadSoftTimeoutMs,
    downloadHardTimeoutMs,
    waitProgressGraceMs,
    downloadStartTimeoutMs
  } = options;

  page.setDefaultTimeout(navTimeout);
  await page.waitForLoadState("domcontentloaded", { timeout: navTimeout }).catch(() => {});

  if (selectors?.paper?.downloadReadyIndicator) {
    await page.waitForSelector(selectors.paper.downloadReadyIndicator, { timeout: navTimeout });
  }

  await maybeSolvePageCaptcha(page, selectors.paper || selectors.login || {}, `download-page-depth${depth}`).catch(() => {});

  await waitUntilReady(
    page,
    selectors,
    pollIntervalMs,
    downloadSoftTimeoutMs,
    downloadHardTimeoutMs,
    waitProgressGraceMs
  );

  const triggerSelectors = asSelectorList(
    selectors?.paper?.preferredDownloadTriggers,
    asSelectorList(selectors?.paper?.downloadTrigger, DEFAULT_PREFERRED_DOWNLOAD_SELECTORS)
  );

  for (const selector of triggerSelectors) {
    const visible = await firstVisibleLocator(page, [selector]);
    if (!visible) continue;

    console.log(`Trying download trigger: ${selector}`);
    const { popup, download } = await clickAndCaptureDownload(page, selector, downloadStartTimeoutMs);

    if (download) {
      return download;
    }

    await maybeSolvePageCaptcha(page, selectors.paper || selectors.login || {}, `post-click-depth${depth}`).catch(() => {});

    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: navTimeout }).catch(() => {});
      const nestedDownload = await downloadFromPage(popup, selectors, options, depth + 1);
      if (nestedDownload) {
        return nestedDownload;
      }
    }
  }

  throw new Error("No download trigger produced a browser download.");
}

async function main() {
  const selectors = readSelectors();
  const loginUrl = getEnv("LOGIN_URL") || getEnv("SITE_BASE_URL", "http://www.sixuexiazai.com/");
  const credentialBundle = resolveSiteCredentials({
    username: getEnv("USERNAME"),
    password: getEnv("PASSWORD")
  });
  const username = credentialBundle.username;
  const password = credentialBundle.password;
  const authStatePath = path.resolve(
    getEnv("AUTH_STATE_PATH", "D:/Code/paper-download/state/auth.json")
  );
  const paperUrl = process.argv[2] || getEnv("PAPER_URL");
  const downloadDir = path.resolve(getEnv("DOWNLOAD_DIR", "./downloads"));
  const headed = getBoolEnv("HEADED", true);
  const navTimeout = getNumEnv("NAV_TIMEOUT_MS", 120000);
  const pollIntervalMs = getNumEnv("POLL_INTERVAL_MS", 2000);
  const downloadSoftTimeoutMs = getNumEnv("DOWNLOAD_SOFT_TIMEOUT_MS", 600000);
  const downloadHardTimeoutMs = getNumEnv("DOWNLOAD_HARD_TIMEOUT_MS", 3600000);
  const waitProgressGraceMs = getNumEnv("WAIT_PROGRESS_GRACE_MS", 180000);
  const downloadStartTimeoutMs = getNumEnv("DOWNLOAD_START_TIMEOUT_MS", 15000);
  const hasSavedSession = fs.existsSync(authStatePath);
  const canAttemptLibraryLogin = hasSavedSession || Boolean(username && password);

  if (!paperUrl) {
    throw new Error("Please set PAPER_URL in .env or pass the paper URL as a CLI argument.");
  }

  ensureDir(downloadDir);
  ensureDir(path.dirname(authStatePath));

  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 60 : 0
  });

  try {
    const context = await browser.newContext({
      storageState: hasSavedSession ? authStatePath : undefined,
      acceptDownloads: true
    });
    const page = await context.newPage();
    page.setDefaultTimeout(navTimeout);

    page.on("dialog", async (dialog) => {
      console.log(`Site dialog: ${dialog.message()}`);
      await dialog.accept().catch(() => {});
    });

    if (canAttemptLibraryLogin) {
      await ensureLibrarySession({
        page,
        context,
        selectors,
        authStatePath,
        loginUrl,
        username,
        password,
        navTimeout
      });
    } else {
      console.log("No library credentials or saved session found. Skipping pre-login and trying the paper URL directly.");
    }

    console.log(`Open paper page: ${paperUrl}`);
    await page.goto(paperUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });

    const download = await downloadFromPage(
      page,
      selectors,
      {
        navTimeout,
        pollIntervalMs,
        downloadSoftTimeoutMs,
        downloadHardTimeoutMs,
        waitProgressGraceMs,
        downloadStartTimeoutMs
      }
    );

    const suggestedName = download.suggestedFilename() || `paper_${timestampString()}.pdf`;
    const savePath = path.join(downloadDir, suggestedName);
    await download.saveAs(savePath);
    console.log(`Download completed: ${savePath}`);

    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  const msg = err.message || "";
  if (msg.includes("Target closed") || msg.includes("browser has been closed")) {
    console.error("Download failed: browser window was closed before download completed.");
  } else {
    console.error(`Download failed: ${msg}`);
  }
  process.exit(1);
});
