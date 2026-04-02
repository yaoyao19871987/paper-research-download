const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  ensureDir,
  readSelectors,
  getEnv,
  getBoolEnv,
  getNumEnv,
  askLine,
  timestampString
} = require("./common");
const { ensureLibrarySession } = require("./library-auth");
const { hasCaptcha, solveTextCaptcha } = require("./library-captcha");
const { resolveSiteCredentials } = require("./site-credentials");

const DEFAULT_PREFERRED_DOWNLOAD_SELECTORS = [
  "a:has-text('PDF1')",
  "a:has-text('PDF2')",
  "a:has-text('PDF下载')",
  "a[title*='PDF']",
  "a:has-text('点此下载')",
  "a:has-text('移动(HW)')",
  "a:has-text('点击下载')",
  "a:has-text('下载')",
  "a[href*='download']",
  ".download a",
  ".download"
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function sanitizeFileComponent(value) {
  return String(value || "paper")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function parseContentDispositionFilename(headerValue) {
  const header = String(headerValue || "");
  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const basicMatch = header.match(/filename\s*=\s*"?([^\";]+)"?/i);
  return basicMatch ? basicMatch[1] : "";
}

function maybeDecodeURIComponent(value) {
  const text = String(value || "");
  if (!/%[0-9A-Fa-f]{2}/.test(text)) {
    return text;
  }
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function guessExtensionFromType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("pdf")) return ".pdf";
  if (type.includes("caj")) return ".caj";
  if (type.includes("kdh")) return ".kdh";
  if (type.includes("octet-stream")) return ".bin";
  if (type.includes("zip")) return ".zip";
  return "";
}

function makeDirectDownloadArtifact(buffer, suggestedName) {
  return {
    kind: "direct-response",
    suggestedFilename() {
      return suggestedName;
    },
    async saveAs(savePath) {
      await fs.promises.writeFile(savePath, buffer);
    }
  };
}

async function savePageArtifacts(page, artifactDir, label) {
  ensureDir(artifactDir);
  const stamp = timestampString();
  const safeLabel = String(label || "page").replace(/[<>:"/\\|?*]+/g, "_");
  const htmlPath = path.join(artifactDir, `${stamp}-${safeLabel}.html`);
  const pngPath = path.join(artifactDir, `${stamp}-${safeLabel}.png`);
  await fs.promises.writeFile(htmlPath, await page.content(), "utf8").catch(() => {});
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  return { htmlPath, pngPath };
}

async function humanPause(page, label, minMs = 1000, maxMs = 3000) {
  if (!page || page.isClosed?.()) {
    return;
  }
  const duration = randomInt(minMs, maxMs);
  console.log(`[pause] ${label}: ${duration}ms`);
  await page.waitForTimeout(duration).catch((error) => {
    const message = String(error?.message || error || "");
    if (/Target page, context or browser has been closed/i.test(message)) {
      return;
    }
    throw error;
  });
}

async function observeAfterNavigation(page, label) {
  await humanPause(page, `${label}-observe`, 2000, 5000);
}

async function humanClick(page, locator, label, options = {}) {
  const beforeMin = options.beforeMin ?? 1000;
  const beforeMax = options.beforeMax ?? 3000;
  const afterMin = options.afterMin ?? 1000;
  const afterMax = options.afterMax ?? 3000;
  await humanPause(page, `${label}-before-click`, beforeMin, beforeMax);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.hover().catch(() => {});
  await locator.click({ force: true });
  await humanPause(page, `${label}-after-click`, afterMin, afterMax);
}

function normalizeText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .replace(/[“”"'`·,，.。:：;；!！?？()（）\[\]【】]/g, "")
    .toLowerCase();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function extractYear(value) {
  const match = String(value || "").match(/((?:19|20)\d{2})/);
  return match ? match[1] : "";
}

function splitNormalizedPeople(value) {
  return String(value || "")
    .split(/[;；,，、/|]+/g)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function deriveIdentityFromPageUrl(pageUrl) {
  const text = String(pageUrl || "").trim();
  if (!text) {
    return { dbCode: "", fileName: "" };
  }

  try {
    const url = new URL(text);
    const dbCode = firstNonEmpty(url.searchParams.get("dbcode"), url.searchParams.get("dbname")).toUpperCase();
    const fileName = firstNonEmpty(url.searchParams.get("filename"), url.searchParams.get("name")).toUpperCase();
    return { dbCode, fileName };
  } catch {
    return { dbCode: "", fileName: "" };
  }
}

function parseProxyHrefMetadata(rawHref) {
  const href = decodeHtmlEntities(String(rawHref || "").trim());
  if (!href) {
    return {
      href: "",
      dbCode: "",
      fileName: "",
      title: "",
      authors: "",
      journal: "",
      publishDate: "",
      publishYear: ""
    };
  }

  try {
    const parsed = new URL(href);
    const ddata = firstNonEmpty(parsed.searchParams.get("ddata"), parsed.searchParams.get("DData"));
    const parts = ddata ? ddata.split("|").map((item) => maybeDecodeURIComponent(item)) : [];
    const fileName = firstNonEmpty(parts[0], parsed.searchParams.get("filename"), parsed.searchParams.get("name")).trim();
    const dbCode = firstNonEmpty(parts[1], parsed.searchParams.get("dbcode"), parsed.searchParams.get("dbname")).trim();
    const title = firstNonEmpty(parts[2]);
    const authors = firstNonEmpty(parts[3]);
    const journal = firstNonEmpty(parts[4]);
    const publishDate = firstNonEmpty(parts[5]);

    return {
      href,
      dbCode: dbCode.toUpperCase(),
      fileName: fileName.toUpperCase(),
      title,
      authors,
      journal,
      publishDate,
      publishYear: extractYear(publishDate)
    };
  } catch {
    return {
      href,
      dbCode: "",
      fileName: "",
      title: "",
      authors: "",
      journal: "",
      publishDate: "",
      publishYear: ""
    };
  }
}

function buildTargetMetadata(options = {}) {
  const title = firstNonEmpty(options.targetTitle, options.query);
  const derivedIdentity = deriveIdentityFromPageUrl(options.targetPageUrl);
  const dbCode = firstNonEmpty(options.targetDbCode, derivedIdentity.dbCode).toUpperCase();
  const fileName = firstNonEmpty(options.targetFileName, derivedIdentity.fileName).toUpperCase();

  return {
    title,
    normalizedTitle: normalizeText(title),
    authors: String(options.targetAuthors || "").trim(),
    authorTerms: splitNormalizedPeople(options.targetAuthors),
    journal: String(options.targetJournal || "").trim(),
    normalizedJournal: normalizeText(options.targetJournal || ""),
    publishYear: extractYear(options.targetYear),
    paperId: String(options.targetPaperId || "").trim().toUpperCase(),
    dbCode,
    fileName,
    pageUrl: String(options.targetPageUrl || "").trim()
  };
}

function scoreResultCandidate(candidate, target) {
  let score = 0;
  const reasons = [];
  const candidateIdentity = `${candidate.dbCode || ""}${candidate.fileName || ""}`.toUpperCase();

  if (!candidate.normalizedTitle) {
    score -= 200;
    reasons.push("empty-title");
  }

  if (target.fileName && candidate.fileName) {
    if (target.fileName === candidate.fileName) {
      score += 240;
      reasons.push("file-name");
    } else {
      score -= 45;
    }
  }

  if (target.dbCode && candidate.dbCode) {
    if (target.dbCode === candidate.dbCode) {
      score += 40;
      reasons.push("db-code");
    } else if (target.fileName) {
      score -= 10;
    }
  }

  if (target.paperId && candidateIdentity && target.paperId === candidateIdentity) {
    score += 260;
    reasons.push("paper-id");
  }

  if (target.normalizedTitle && candidate.normalizedTitle === target.normalizedTitle) {
    score += 120;
    reasons.push("exact-title");
  } else if (target.normalizedTitle && candidate.normalizedTitle.includes(target.normalizedTitle)) {
    score += 90;
    reasons.push("title-contains-target");
  } else if (target.normalizedTitle && target.normalizedTitle.includes(candidate.normalizedTitle) && candidate.normalizedTitle) {
    score += 70;
    reasons.push("target-contains-title");
  } else if (!target.normalizedTitle && candidate.normalizedTitle) {
    score += 10;
  }

  if (target.authorTerms.length && candidate.authorTerms.length) {
    const overlap = candidate.authorTerms.filter((term) => target.authorTerms.includes(term)).length;
    if (overlap) {
      score += overlap * 22;
      reasons.push(`author-overlap:${overlap}`);
    }
  }

  if (target.normalizedJournal && candidate.normalizedJournal) {
    if (target.normalizedJournal === candidate.normalizedJournal) {
      score += 28;
      reasons.push("journal");
    } else if (candidate.normalizedJournal.includes(target.normalizedJournal)) {
      score += 18;
      reasons.push("journal-contains");
    }
  }

  if (target.publishYear && candidate.publishYear) {
    if (target.publishYear === candidate.publishYear) {
      score += 14;
      reasons.push("year");
    } else {
      score -= 3;
    }
  }

  return { score, reasons };
}

async function extractResultCandidate(rowLocator, index) {
  const titleLocator = rowLocator
    .locator("td.name a.fz14, td.name a[href*='papermao.net/cdown'], dd h6 a.fz14, dd h6 a[href*='papermao.net/cdown']")
    .first();
  const titleExists = (await titleLocator.count().catch(() => 0)) > 0;
  if (!titleExists) {
    return null;
  }

  const downloadLocator = rowLocator
    .locator("td.operat a.downloadlink, a.downloadlink[href*='papermao.net/cdown'], a.downloadlink")
    .first();

  const titleText = (await titleLocator.innerText().catch(() => "")).trim();
  const titleHref = await titleLocator.getAttribute("href").catch(() => "");
  const downloadHref = await downloadLocator.getAttribute("href").catch(() => "");
  const titleMeta = parseProxyHrefMetadata(titleHref);
  const downloadMeta = parseProxyHrefMetadata(downloadHref);
  const authorText = (await rowLocator.locator("td.author").innerText().catch(() => "")).trim();
  const sourceText = (await rowLocator.locator("td.source").innerText().catch(() => "")).trim();
  const dateText = (await rowLocator.locator("td.date").innerText().catch(() => "")).trim();

  const resolvedTitle = firstNonEmpty(titleText, downloadMeta.title, titleMeta.title);
  const resolvedAuthors = firstNonEmpty(authorText, downloadMeta.authors, titleMeta.authors);
  const resolvedJournal = firstNonEmpty(sourceText, downloadMeta.journal, titleMeta.journal);
  const resolvedDate = firstNonEmpty(dateText, downloadMeta.publishDate, titleMeta.publishDate);
  const resolvedDbCode = firstNonEmpty(downloadMeta.dbCode, titleMeta.dbCode).toUpperCase();
  const resolvedFileName = firstNonEmpty(downloadMeta.fileName, titleMeta.fileName).toUpperCase();

  return {
    index,
    rowLocator,
    titleLocator,
    downloadLocator,
    titleText: resolvedTitle,
    normalizedTitle: normalizeText(resolvedTitle),
    authors: resolvedAuthors,
    authorTerms: splitNormalizedPeople(resolvedAuthors),
    journal: resolvedJournal,
    normalizedJournal: normalizeText(resolvedJournal),
    publishDate: resolvedDate,
    publishYear: extractYear(resolvedDate),
    dbCode: resolvedDbCode,
    fileName: resolvedFileName,
    href: firstNonEmpty(downloadMeta.href, titleMeta.href)
  };
}

function asSelectorList(configValue, fallbacks = []) {
  if (Array.isArray(configValue)) {
    return [...configValue, ...fallbacks];
  }
  if (typeof configValue === "string" && configValue.trim()) {
    return [configValue.trim(), ...fallbacks];
  }
  return [...fallbacks];
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) && (await locator.isVisible().catch(() => false))) {
        return { selector, locator };
      }
    } catch {
      // Ignore invalid selectors from fallbacks.
    }
  }
  return null;
}

async function maybeSolvePageCaptcha(page, selectorGroup, label) {
  if (!(await hasCaptcha(page, selectorGroup))) {
    return false;
  }
  console.log(`[captcha] detected on ${label}`);
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
  console.log(`[captcha] ${label} => ${solved.text}`);
  return true;
}

function hasCountdownText(text) {
  if (!text) return false;
  const normalized = text.replace(/\s+/g, "");
  const patterns = [
    /\d+\s*秒/,
    /请等待/,
    /倒计时/,
    /后可下载/,
    /后重试/,
    /预计\d+\s*-\s*\d+\s*秒/,
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

async function waitUntilReady(page, selectors, options) {
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastState = "";
  let softTimeoutLogged = false;

  while (Date.now() - startedAt < options.downloadHardTimeoutMs) {
    if (!page || page.isClosed?.()) {
      throw new Error("Download page closed before readiness check completed.");
    }
    await maybeSolvePageCaptcha(page, selectors.paper || selectors.login || {}, "legacy-download-page").catch(
      () => {}
    );

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
      const containerText = selectors?.paper?.countdownContainer
        ? await page.locator(selectors.paper.countdownContainer).first().innerText().catch(() => "")
        : "";

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
    if (elapsed > options.downloadSoftTimeoutMs && !softTimeoutLogged) {
      softTimeoutLogged = true;
      console.log(
        `[wait] exceeded soft timeout ${options.downloadSoftTimeoutMs}ms, continuing because state is still moving`
      );
    }

    const stagnantFor = Date.now() - lastProgressAt;
    if (elapsed > options.downloadSoftTimeoutMs && stagnantFor > options.waitProgressGraceMs) {
      throw new Error(`Download readiness stalled for ${stagnantFor} ms after soft timeout.`);
    }

    await page.waitForTimeout(options.pollIntervalMs);
  }

  throw new Error(`Waited up to ${options.downloadHardTimeoutMs} ms and download is still not ready.`);
}

async function clickAndCaptureDownload(page, selector, timeoutMs) {
  const locator = page.locator(selector).first();
  const popupPromise = page.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
  await humanClick(page, locator, `download-trigger:${selector}`, {
    beforeMin: 1000,
    beforeMax: 3000,
    afterMin: 1500,
    afterMax: 3000
  });
  const popup = await popupPromise;
  const download = await downloadPromise;
  return { popup, download };
}

function isLegacyCdownUrl(url) {
  return /papermao\.net\/cdown/i.test(String(url || ""));
}

async function isLegacyCdownPage(page) {
  if (!page || page.isClosed?.()) return false;
  if (isLegacyCdownUrl(page.url())) {
    return true;
  }

  const selectors = ["#clk4", "#clk1", "#clk0", "iframe#autodwn", "a[href*='type=pdf']"];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) && (await locator.isVisible().catch(() => true))) {
        return true;
      }
    } catch {
      // Ignore probe failures and keep checking other markers.
    }
  }

  const text = await page.locator("body").innerText().catch(() => "");
  return /自动关闭|点击下载|点此下载|下载1|下载2/.test(String(text || ""));
}

async function clickAndCaptureContextDownload(context, page, locator, label, timeoutMs) {
  const popupPromise = context.waitForEvent("page", { timeout: 3000 }).catch(() => null);
  const downloadPromise = context.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
  await humanClick(page, locator, label, {
    beforeMin: 1000,
    beforeMax: 3000,
    afterMin: 1200,
    afterMax: 2600
  });
  const download = await downloadPromise;
  const popup = await popupPromise;
  return { download, popup };
}

async function waitForContextDownload(context, timeoutMs) {
  return context.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
}

async function buildLegacyCdownCandidates(page) {
  const specs = [
    { selector: "#clk1", label: "iframe-default" },
    { selector: "#clk4", label: "pdf" },
    { selector: "#clk3", label: "hw" },
    { selector: "#clk2", label: "mirror-1" }
  ];
  const candidates = [];
  for (const spec of specs) {
    try {
      const locator = page.locator(spec.selector).first();
      if (!(await locator.count())) continue;
      const href = decodeHtmlEntities(await locator.getAttribute("href").catch(() => ""));
      if (!href) continue;
      candidates.push({ ...spec, href, locator });
    } catch {
      // Ignore probe failures and keep checking other candidates.
    }
  }
  return candidates;
}

async function tryDirectRequestDownload(context, page, candidate, timeoutMs, titleHint) {
  const response = await context.request
    .get(candidate.href, {
      timeout: timeoutMs,
      failOnStatusCode: false,
      headers: {
        referer: page.url()
      }
    })
    .catch(() => null);

  if (!response) {
    return null;
  }

  const status = response.status();
  const headers = response.headers();
  const contentType = headers["content-type"] || headers["Content-Type"] || "";
  const body = await response.body().catch(() => null);
  if (!body || !body.length) {
    return null;
  }

  const bodyPreview = body.slice(0, 512).toString("utf8");
  const looksLikeHtml =
    /html|text\//i.test(contentType) ||
    /^\s*</.test(bodyPreview) ||
    /window\.close|当前链接已过期|重新点击题目获取最新全文链接|alert\(/i.test(bodyPreview);

  if (status >= 400 || looksLikeHtml) {
    console.log(
      `[legacy-cdown] direct request ${candidate.label} skipped: status=${status}, contentType=${contentType || "unknown"}`
    );
    return null;
  }

  const dispositionName = maybeDecodeURIComponent(
    parseContentDispositionFilename(
      headers["content-disposition"] || headers["Content-Disposition"]
    )
  );
  const urlName = (() => {
    try {
      const pathname = new URL(candidate.href).pathname;
      return maybeDecodeURIComponent(path.basename(pathname || ""));
    } catch {
      return "";
    }
  })();
  const rawName = sanitizeFileComponent(dispositionName || urlName || titleHint || "paper");
  const derivedExtension =
    path.extname(rawName) ||
    path.extname(dispositionName || urlName || "") ||
    guessExtensionFromType(contentType) ||
    "";
  const baseName = derivedExtension ? rawName.slice(0, -derivedExtension.length) || rawName : rawName;
  const suggestedName = `${baseName}${derivedExtension}`;

  console.log(
    `[legacy-cdown] direct request ${candidate.label} succeeded: status=${status}, contentType=${contentType || "unknown"}, bytes=${body.length}`
  );
  return makeDirectDownloadArtifact(body, suggestedName);
}

async function downloadFromLegacyCdownPage(context, page, selectors, options) {
  const directDownloadPromise = context.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  const passiveDownload = await directDownloadPromise;
  if (passiveDownload) {
    return passiveDownload;
  }

  const directCandidates = await buildLegacyCdownCandidates(page);
  for (const candidate of directCandidates) {
    console.log(`[legacy-cdown] trying direct request ${candidate.label}: ${candidate.href}`);
    const directArtifact = await tryDirectRequestDownload(
      context,
      page,
      candidate,
      Math.max(options.downloadStartTimeoutMs, 20000),
      options.fileNameHint || ""
    );
    if (directArtifact) {
      return directArtifact;
    }
  }

  const preferredSelectors = [
    "#clk1",
    "a:has-text('点此下载')",
    "#clk4",
    "a.clk2[title*='PDF']",
    "a[href*='type=pdf']",
    "a:has-text('下载2')",
    "#clk3",
    "a:has-text('移动(HW)')",
    "#clk2",
    "a:has-text('下载1')"
  ];

  for (const selector of preferredSelectors) {
    const visible = await firstVisibleLocator(page, [selector]);
    if (!visible) continue;
    console.log(`[legacy-cdown] trying trigger ${selector}`);
    const { download, popup } = await clickAndCaptureContextDownload(
      context,
      page,
      visible.locator,
      `legacy-cdown-trigger:${selector}`,
      Math.max(options.downloadStartTimeoutMs, 20000)
    );
    if (download) {
      return download;
    }
    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: options.navTimeout }).catch(() => {});
      try {
        return await downloadFromPage(popup, selectors, options, 1);
      } catch (error) {
        const fallbackDownload = await waitForContextDownload(
          context,
          Math.max(options.downloadStartTimeoutMs, 10000)
        );
        if (fallbackDownload) {
          return fallbackDownload;
        }
        throw error;
      }
    }
  }

  throw new Error("Legacy cdown page did not produce a browser download.");
}

async function downloadFromPage(page, selectors, options, depth = 0) {
  if (depth > 2) {
    throw new Error("Exceeded maximum nested download depth.");
  }

  if (await isLegacyCdownPage(page)) {
    return downloadFromLegacyCdownPage(page.context(), page, selectors, options);
  }

  page.setDefaultTimeout(options.navTimeout);
  await page.waitForLoadState("domcontentloaded", { timeout: options.navTimeout }).catch(() => {});
  await observeAfterNavigation(page, `download-page-depth-${depth}`);

  if (await isLegacyCdownPage(page)) {
    return downloadFromLegacyCdownPage(page.context(), page, selectors, options);
  }

  if (selectors?.paper?.downloadReadyIndicator) {
    await page.waitForSelector(selectors.paper.downloadReadyIndicator, { timeout: options.navTimeout }).catch(
      () => {}
    );
  }

  await maybeSolvePageCaptcha(page, selectors.paper || selectors.login || {}, `legacy-download-depth-${depth}`).catch(
    () => {}
  );

  try {
    await waitUntilReady(page, selectors, options);
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/closed before readiness check/i.test(message) || /Target page, context or browser has been closed/i.test(message)) {
      const lateDownload = await waitForContextDownload(page.context(), Math.max(options.downloadStartTimeoutMs, 10000));
      if (lateDownload) {
        return lateDownload;
      }
    }
    throw error;
  }

  const triggerSelectors = asSelectorList(
    selectors?.paper?.preferredDownloadTriggers,
    asSelectorList(selectors?.paper?.downloadTrigger, DEFAULT_PREFERRED_DOWNLOAD_SELECTORS)
  );

  for (const selector of triggerSelectors) {
    const visible = await firstVisibleLocator(page, [selector]);
    if (!visible) continue;

    console.log(`[download] trying trigger ${selector}`);
    const { popup, download } = await clickAndCaptureDownload(page, selector, options.downloadStartTimeoutMs);

    if (download) {
      return download;
    }

    await maybeSolvePageCaptcha(page, selectors.paper || selectors.login || {}, `post-click-depth-${depth}`).catch(
      () => {}
    );

    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: options.navTimeout }).catch(() => {});
      if ((await isLegacyCdownPage(popup)) || isLegacyCdownUrl(popup.url())) {
        return downloadFromLegacyCdownPage(page.context(), popup, selectors, options);
      }
      const nestedDownload = await downloadFromPage(popup, selectors, options, depth + 1);
      if (nestedDownload) {
        return nestedDownload;
      }
    }
  }

  throw new Error("No download trigger produced a browser download.");
}

async function waitForNewPage(context, action, timeoutMs, label) {
  const existing = new Set(context.pages());
  const pagePromise = context.waitForEvent("page", { timeout: timeoutMs }).catch(() => null);
  await action();
  const pageFromEvent = await pagePromise;
  if (pageFromEvent) {
    await pageFromEvent.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    return pageFromEvent;
  }
  const currentPages = context.pages();
  for (const page of currentPages) {
    if (!existing.has(page)) {
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
      return page;
    }
  }
  throw new Error(`No new page appeared after ${label}.`);
}

async function openLiteratureCenter(page) {
  const literatureLink = page.locator("a[href*='cnview.php']").first();
  if ((await literatureLink.count()) && (await literatureLink.isVisible().catch(() => false))) {
    await humanClick(page, literatureLink, "sixue-literature-download");
    await page.waitForURL(/cnview\.php/, { timeout: 120000 }).catch(() => {});
    await observeAfterNavigation(page, "sixue-literature-download");
    return;
  }
  await humanPause(page, "fallback-to-cnview", 1200, 2600);
  await page.goto("http://www.sixuexiazai.com/m/cnview.php", { waitUntil: "domcontentloaded", timeout: 120000 });
  await observeAfterNavigation(page, "cnview-fallback");
}

async function openEntryOne(context, page) {
  const entryLink = page.locator("a[href*='cnkiyx.php']").first();
  if (!(await entryLink.count())) {
    throw new Error("Could not find 思学入口1 link on cnview page.");
  }
  const gatePage = await waitForNewPage(
    context,
    async () => {
      await humanClick(page, entryLink, "sixue-entry-1");
    },
    20000,
    "入口1 click"
  );
  await observeAfterNavigation(gatePage, "papermao-gate");
  return gatePage;
}

async function openSearchOne(context, gatePage) {
  const searchLink = gatePage.locator("a[href*='/kns8s/defaultresult/index']").first();
  if (!(await searchLink.count())) {
    throw new Error("Could not find 检索1 link on papermao gate page.");
  }
  const searchPage = await waitForNewPage(
    context,
    async () => {
      await humanClick(gatePage, searchLink, "papermao-search-1");
    },
    20000,
    "检索1 click"
  );
  await observeAfterNavigation(searchPage, "proxy-cnki-search-home");
  return searchPage;
}

async function ensureFieldModeTka(page) {
  const alreadySet = await page
    .evaluate(() => {
      const input = document.querySelector("#selectfield");
      return !!input && input.value === "TKA";
    })
    .catch(() => false);
  if (alreadySet) {
    return;
  }

  let selected = false;
  try {
    await humanClick(page, page.locator(".sort.reopt .sort-default").first(), "cnki-open-field-dropdown");
    const tkaLink = page.locator(".sort-list li[data-val='TKA'] a").first();
    if ((await tkaLink.count()) && (await tkaLink.isVisible().catch(() => false))) {
      await humanClick(page, tkaLink, "cnki-select-tka");
      selected = true;
    }
  } catch {
    // Fall back to direct DOM manipulation below.
  }

  if (!selected) {
    selected = await page
      .evaluate(() => {
        const input = document.querySelector("#selectfield");
        if (!input) return false;
        input.value = "TKA";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        const option = document.querySelector(".sort-list li[data-val='TKA'] a");
        const trigger = document.querySelector(".sort.reopt .sort-default");
        if (option && trigger) {
          trigger.textContent = option.textContent || trigger.textContent;
        }
        return true;
      })
      .catch(() => false);
  }

  if (!selected) {
    throw new Error("Could not switch CNKI field mode to TKA.");
  }

  await page
    .waitForFunction(() => {
      const input = document.querySelector("#selectfield");
      return input && input.value === "TKA";
    }, { timeout: 120000 })
    .catch(() => {});
}

async function runProxySearch(page, query) {
  await ensureFieldModeTka(page);
  const searchInput = page.locator("#txt_search").first();
  await humanPause(page, "before-fill-query", 1000, 2000);
  await searchInput.fill("");
  await searchInput.fill(query);
  await humanPause(page, "after-fill-query", 800, 1800);
  await humanClick(page, page.locator(".search-btn").first(), "cnki-search-button");
  await page.waitForURL(/\/kns8s\/search/, { timeout: 120000 }).catch(() => {});
  try {
    await page.waitForSelector("table.result-table-list, .result-table-list", { timeout: 120000 });
  } catch (error) {
    const artifactDir = path.join(process.cwd(), "outputs", "legacy-sixue-download");
    await savePageArtifacts(page, artifactDir, "proxy-cnki-results-timeout").catch(() => {});
    throw error;
  }
  await observeAfterNavigation(page, "proxy-cnki-results");
}

async function pickBestResult(page, targetOptions = {}) {
  const target = typeof targetOptions === "string" ? buildTargetMetadata({ targetTitle: targetOptions }) : buildTargetMetadata(targetOptions);
  const resultRows = page.locator("#gridTable table.result-table-list tbody tr, table.result-table-list tbody tr, .result-table-list tbody tr");
  const rowCount = await resultRows.count();
  if (!rowCount) {
    throw new Error("No CNKI result rows were found on proxy search results page.");
  }

  let bestCandidate = null;
  const candidateSummaries = [];

  for (let index = 0; index < rowCount; index += 1) {
    const rowLocator = resultRows.nth(index);
    const candidate = await extractResultCandidate(rowLocator, index);
    if (!candidate) {
      continue;
    }

    const { score, reasons } = scoreResultCandidate(candidate, target);
    candidate.score = score;
    candidate.reasons = reasons;
    candidateSummaries.push({
      index,
      titleText: candidate.titleText,
      score,
      fileName: candidate.fileName,
      dbCode: candidate.dbCode,
      publishYear: candidate.publishYear,
      reasons
    });

    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    throw new Error("No clickable CNKI result candidates were found on proxy search results page.");
  }

  const hasStructuredTarget =
    Boolean(target.normalizedTitle) ||
    Boolean(target.fileName) ||
    Boolean(target.paperId) ||
    Boolean(target.authorTerms.length) ||
    Boolean(target.normalizedJournal);
  const minAcceptableScore = hasStructuredTarget ? 20 : 0;
  if (bestCandidate.score < minAcceptableScore) {
    throw new Error(
      `No confident proxy result match was found for "${target.title || target.pageUrl || "target"}" (best="${bestCandidate.titleText || "(empty title)"}", score=${bestCandidate.score}).`
    );
  }

  console.log(
    `[result] selected row ${bestCandidate.index + 1}: ${bestCandidate.titleText || "(empty title)"}; score=${bestCandidate.score}; reasons=${bestCandidate.reasons.join(
      "|"
    )}; candidates=${JSON.stringify(candidateSummaries.slice(0, 5))}`
  );

  return {
    container: bestCandidate.rowLocator,
    titleLocator: bestCandidate.titleLocator,
    selectedTitle: bestCandidate.titleText,
    selectedMeta: bestCandidate
  };
}

async function openDownloadTarget(context, searchPage, resultMatch) {
  const preferredLink = resultMatch.container.locator(
    "td.operat a.downloadlink[href*='papermao.net/cdown'], td.operat a.downloadlink, a.downloadlink[href*='papermao.net/cdown'], a.downloadlink, a[href*='papermao.net/cdown']"
  ).first();
  const fallbackTitle = resultMatch.titleLocator;
  const useLocator = (await preferredLink.count()) ? preferredLink : fallbackTitle;
  if (!(await useLocator.count())) {
    throw new Error("Neither row download link nor title link was found on selected result.");
  }

  const page = await waitForNewPage(
    context,
    async () => {
      await humanClick(searchPage, useLocator, "open-result-download-target");
    },
    20000,
    "result open click"
  );
  await observeAfterNavigation(page, "download-target-page");
  return page;
}

async function saveDownload(download, downloadDir, fileNameHint) {
  const suggestedName = download.suggestedFilename() || fileNameHint || `paper_${timestampString()}.pdf`;
  const savePath = path.join(downloadDir, suggestedName);
  await download.saveAs(savePath);
  return savePath;
}

async function openLegacySixueSession(options = {}) {
  const selectors = readSelectors();
  const loginUrl = getEnv("LOGIN_URL") || getEnv("SITE_BASE_URL", "http://www.sixuexiazai.com/");
  const credentialBundle = resolveSiteCredentials({
    username: options.username || getEnv("USERNAME"),
    password: options.password || getEnv("PASSWORD")
  });
  const username = credentialBundle.username;
  const password = credentialBundle.password;
  const authStatePath = path.resolve(
    options.authStatePath || getEnv("AUTH_STATE_PATH", "D:/Code/paper-download/state/auth.json")
  );
  const headed = options.headed ?? getBoolEnv("HEADED", true);
  const navTimeout = options.navTimeout || getNumEnv("NAV_TIMEOUT_MS", 120000);
  ensureDir(path.dirname(authStatePath));

  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 60 : 0
  });

  try {
    const context = await browser.newContext({
      storageState: fs.existsSync(authStatePath) ? authStatePath : undefined,
      acceptDownloads: true
    });
    const page = await context.newPage();
    page.setDefaultTimeout(navTimeout);
    page.on("dialog", async (dialog) => {
      console.log(`[dialog] ${dialog.message()}`);
      await dialog.accept().catch(() => {});
    });

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

    await observeAfterNavigation(page, "sixue-home");
    await openLiteratureCenter(page);
    const gatePage = await openEntryOne(context, page);
    const searchPage = await openSearchOne(context, gatePage);
    return {
      browser,
      context,
      page,
      gatePage,
      searchPage,
      selectors,
      navTimeout
    };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeLegacySixueSession(session) {
  if (!session) return;
  await session.context?.close().catch(() => {});
  await session.browser?.close().catch(() => {});
}

async function downloadOneFromLegacySixueSession(session, options = {}) {
  const query = options.query || getEnv("LEGACY_QUERY") || getEnv("PAPER_TITLE");
  const targetTitle = options.targetTitle || getEnv("LEGACY_TITLE") || query;
  const targetAuthors = options.targetAuthors || getEnv("LEGACY_AUTHORS");
  const targetJournal = options.targetJournal || getEnv("LEGACY_JOURNAL");
  const targetYear = options.targetYear || getEnv("LEGACY_YEAR");
  const targetPaperId = options.targetPaperId || getEnv("LEGACY_PAPER_ID");
  const targetDbCode = options.targetDbCode || getEnv("LEGACY_DB_CODE");
  const targetFileName = options.targetFileName || getEnv("LEGACY_FILE_NAME");
  const targetPageUrl = options.targetPageUrl || getEnv("LEGACY_PAGE_URL");
  const downloadDir = path.resolve(options.downloadDir || getEnv("DOWNLOAD_DIR", "./downloads"));
  const pollIntervalMs = options.pollIntervalMs || getNumEnv("POLL_INTERVAL_MS", 2000);
  const downloadSoftTimeoutMs = options.downloadSoftTimeoutMs || getNumEnv("DOWNLOAD_SOFT_TIMEOUT_MS", 600000);
  const downloadHardTimeoutMs = options.downloadHardTimeoutMs || getNumEnv("DOWNLOAD_HARD_TIMEOUT_MS", 3600000);
  const waitProgressGraceMs = options.waitProgressGraceMs || getNumEnv("WAIT_PROGRESS_GRACE_MS", 180000);
  const downloadStartTimeoutMs = options.downloadStartTimeoutMs || getNumEnv("DOWNLOAD_START_TIMEOUT_MS", 15000);

  if (!query) {
    throw new Error("LEGACY_QUERY or PAPER_TITLE is required for legacy Sixue download flow.");
  }

  ensureDir(downloadDir);

  const result = {
    query,
    targetTitle,
    downloadPath: "",
    proxySearchUrl: session.searchPage.url(),
    selectedTitle: "",
    matchedDbCode: "",
    matchedFileName: ""
  };

  await runProxySearch(session.searchPage, query);
  const artifactDir = path.join(process.cwd(), "outputs", "legacy-sixue-download");
  await savePageArtifacts(session.searchPage, artifactDir, "proxy-cnki-results");

  const selectedMatch = await pickBestResult(session.searchPage, {
    query,
    targetTitle,
    targetAuthors,
    targetJournal,
    targetYear,
    targetPaperId,
    targetDbCode,
    targetFileName,
    targetPageUrl
  });
  result.selectedTitle = selectedMatch.selectedTitle;
  result.matchedDbCode = selectedMatch.selectedMeta?.dbCode || "";
  result.matchedFileName = selectedMatch.selectedMeta?.fileName || "";

  const downloadPage = await openDownloadTarget(session.context, session.searchPage, selectedMatch);
  await savePageArtifacts(downloadPage, artifactDir, "legacy-download-target");
  const download = (await isLegacyCdownPage(downloadPage))
    ? await downloadFromLegacyCdownPage(session.context, downloadPage, session.selectors, {
        navTimeout: session.navTimeout,
        pollIntervalMs,
        downloadSoftTimeoutMs,
        downloadHardTimeoutMs,
        waitProgressGraceMs,
        downloadStartTimeoutMs,
        fileNameHint: targetTitle
      })
    : await downloadFromPage(downloadPage, session.selectors, {
        navTimeout: session.navTimeout,
        pollIntervalMs,
        downloadSoftTimeoutMs,
        downloadHardTimeoutMs,
        waitProgressGraceMs,
        downloadStartTimeoutMs,
        fileNameHint: targetTitle
      });

  result.downloadPath = await saveDownload(download, downloadDir, `${normalizeText(targetTitle) || "paper"}.pdf`);

  if (!downloadPage.isClosed()) {
    await humanPause(downloadPage, "before-close-download-page", 1000, 2000).catch(() => {});
    await downloadPage.close().catch(() => {});
  }

  if (session.searchPage.isClosed()) {
    throw new Error("Search page was unexpectedly closed after download; session cannot continue.");
  }

  await humanPause(session.searchPage, "after-return-to-search-page", 1000, 2000);
  return result;
}

async function runLegacySixueDownload(options = {}) {
  const session = await openLegacySixueSession(options);
  try {
    return await downloadOneFromLegacySixueSession(session, options);
  } finally {
    await closeLegacySixueSession(session);
  }
}

const PIPELINE_AUTH_REQUIRED_MARKER = "__PIPELINE_AUTH_REQUIRED__";
const PIPELINE_AUTH_RESUMED_MARKER = "__PIPELINE_AUTH_RESUMED__";
const PIPELINE_RESULT_MARKER = "__PIPELINE_RESULT__";
const PIPELINE_ERROR_MARKER = "__PIPELINE_ERROR__";

function classifyAuthPauseReason(message) {
  const text = String(message || "").toLowerCase();
  if (
    text.includes("username and password are required") ||
    text.includes("library login was not confirmed") ||
    text.includes("captcha") ||
    text.includes("security verification") ||
    text.includes("auth state")
  ) {
    return "auth";
  }
  return "";
}

function emitPipelineEvent(marker, payload = {}) {
  console.log(`${marker}${JSON.stringify(payload, null, 0)}`);
}

async function waitForAuthContinue() {
  while (true) {
    const answer = String(await askLine("[auth] 完成处理后输入 continue 再继续：")).trim().toLowerCase();
    if (!answer || answer === "continue") {
      return;
    }
    console.log("[auth] 请输入 continue。");
  }
}

async function runLegacySixueDownloadCli(options = {}) {
  while (true) {
    let session = null;
    try {
      session = await openLegacySixueSession(options);
      while (true) {
        try {
          return await downloadOneFromLegacySixueSession(session, options);
        } catch (error) {
          const message = error?.message || String(error || "");
          const pauseReason = classifyAuthPauseReason(message);
          if (!pauseReason) {
            throw error;
          }
          emitPipelineEvent(PIPELINE_AUTH_REQUIRED_MARKER, {
            reason: pauseReason,
            message,
            query: options.query || "",
            targetTitle: options.targetTitle || options.query || ""
          });
          process.stdout.write("\u0007");
          await waitForAuthContinue();
          emitPipelineEvent(PIPELINE_AUTH_RESUMED_MARKER, {
            reason: pauseReason,
            query: options.query || "",
            targetTitle: options.targetTitle || options.query || ""
          });
        }
      }
    } catch (error) {
      const message = error?.message || String(error || "");
      const pauseReason = classifyAuthPauseReason(message);
      if (!pauseReason) {
        throw error;
      }
      emitPipelineEvent(PIPELINE_AUTH_REQUIRED_MARKER, {
        reason: pauseReason,
        message,
        query: options.query || "",
        targetTitle: options.targetTitle || options.query || ""
      });
      process.stdout.write("\u0007");
      await waitForAuthContinue();
      emitPipelineEvent(PIPELINE_AUTH_RESUMED_MARKER, {
        reason: pauseReason,
        query: options.query || "",
        targetTitle: options.targetTitle || options.query || ""
      });
    } finally {
      if (session) {
        await closeLegacySixueSession(session);
      }
    }
  }
}

async function main() {
  const query = process.argv[2] || "";
  const targetTitle = process.argv[3] || "";
  const result = await runLegacySixueDownloadCli({ query, targetTitle });
  emitPipelineEvent(PIPELINE_RESULT_MARKER, result);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    emitPipelineEvent(PIPELINE_ERROR_MARKER, {
      message: error?.message || String(error || "")
    });
    console.error(`Legacy Sixue download failed: ${error.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  openLegacySixueSession,
  closeLegacySixueSession,
  downloadOneFromLegacySixueSession,
  runLegacySixueDownload,
  classifyAuthPauseReason,
  __internal: {
    pickBestResult,
    buildTargetMetadata,
    parseProxyHrefMetadata,
    scoreResultCandidate
  }
};
