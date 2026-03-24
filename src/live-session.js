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
const { resolveSiteCredentials } = require("./site-credentials");

const DEFAULT_AUTH_STATE = "D:/Code/paper-download/state/auth.json";
const DEFAULT_READY_PHRASE = "\u9A8C\u8BC1\u7801\u5DF2\u586B\u597D";
const ALT_READY_PHRASE = "captcha-ready";
const IDLE_WARNING_MS = 5 * 60 * 1000;

function parseCommand(input) {
  const trimmed = input.trim();
  if (!trimmed) return { cmd: "" };

  const [cmdRaw, ...rest] = trimmed.split(" ");
  const cmd = cmdRaw.toLowerCase();
  const args = rest.join(" ").trim();
  return { cmd, args };
}

async function isPageAlive(page) {
  try {
    await page.title();
    return true;
  } catch {
    return false;
  }
}

async function isVisible(page, selector) {
  if (!selector) return false;
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function isLoggedIn(page, selectors) {
  if (await isVisible(page, selectors.login.successIndicator)) return true;
  const hasLoginForm = await isVisible(page, selectors.login.username);
  if (hasLoginForm) return false;
  if (await isVisible(page, selectors.login.submit)) return false;
  return true;
}

async function tryFillCredentials(page, selectors, username, password) {
  if (username && selectors.login.username) {
    const userBox = page.locator(selectors.login.username).first();
    if (await userBox.count()) {
      await userBox.fill(username);
      console.log("Username filled.");
    }
  }
  if (password && selectors.login.password) {
    const passBox = page.locator(selectors.login.password).first();
    if (await passBox.count()) {
      await passBox.fill(password);
      console.log("Password filled.");
    }
  }
}

async function loginWithHumanCaptcha(page, selectors, readyPhrase, navTimeout) {
  console.log("");
  console.log("Manual step required:");
  console.log("1) Type captcha in the browser field.");
  console.log(`2) Return here and type exactly: ${readyPhrase}`);
  console.log(`   Fallback phrase: ${ALT_READY_PHRASE}`);

  while (true) {
    const line = await askLine("> ");
    if (line.trim() === readyPhrase || line.trim() === ALT_READY_PHRASE) {
      break;
    }
    if (line.trim().toLowerCase() === "help") {
      console.log(`Type ${readyPhrase} (or ${ALT_READY_PHRASE}) when captcha is ready.`);
      continue;
    }
    console.log("Command not accepted. Type help for usage.");
  }

  if (!selectors.login.submit) {
    throw new Error("selectors.login.submit is missing.");
  }

  await Promise.allSettled([
    page.waitForLoadState("domcontentloaded", { timeout: navTimeout }),
    page.locator(selectors.login.submit).first().click()
  ]);
}

async function saveState(context, authStatePath) {
  ensureDir(path.dirname(authStatePath));
  await context.storageState({ path: authStatePath });
  console.log(`Session saved: ${authStatePath}`);
}

async function launchBrowser(headed, authStatePath) {
  const hasState = fs.existsSync(authStatePath);
  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 80 : 0
  });
  const context = await browser.newContext({
    storageState: hasState ? authStatePath : undefined,
    acceptDownloads: true
  });
  const page = await context.newPage();

  page.on("dialog", async (dialog) => {
    console.log(`Site alert: ${dialog.message()}`);
    await dialog.accept();
  });

  return { browser, context, page };
}

function resetIdleTimer(state) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    console.log("");
    console.log("\u26a0\ufe0f  Idle for 5 minutes. Session may expire soon.");
    console.log("   Type save-state to persist, or any command to continue.");
  }, IDLE_WARNING_MS);
}

function clearIdleTimer(state) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

async function checkSessionAfterNav(page, selectors, loginUrl, username, password, readyPhrase, navTimeout) {
  const hasLoginForm = await isVisible(page, selectors.login.username);
  if (!hasLoginForm) return;

  console.log("Session expired — login form detected. Re-running login flow...");
  if (page.url() !== loginUrl) {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
  }
  await tryFillCredentials(page, selectors, username, password);
  await loginWithHumanCaptcha(page, selectors, readyPhrase, navTimeout);
  await page.waitForTimeout(1500);
  const ok = await isLoggedIn(page, selectors);
  if (ok) {
    console.log("Re-login confirmed.");
  } else {
    console.log("Re-login unconfirmed. You may need to complete login manually.");
  }
}

async function runInteractiveLoop(
  state, selectors, loginUrl, username, password, readyPhrase,
  authStatePath, downloadDir, headed, navTimeout
) {
  ensureDir(downloadDir);
  console.log("");
  console.log("Live mode ready. Type help for commands.");
  resetIdleTimer(state);

  while (true) {
    const line = await askLine("live> ");
    resetIdleTimer(state);
    const { cmd, args } = parseCommand(line);

    if (!cmd) continue;

    // --- Browser disconnect detection ---
    if (!await isPageAlive(state.page)) {
      console.log("");
      console.log("Browser disconnected (window closed or crashed).");
      const answer = await askLine("Reconnect? (yes/no) > ");
      if (answer.trim().toLowerCase() === "yes" || answer.trim().toLowerCase() === "y") {
        try {
          await state.browser.close().catch(() => {});
        } catch { /* ignore */ }
        console.log("Launching new browser...");
        const fresh = await launchBrowser(headed, authStatePath);
        state.browser = fresh.browser;
        state.context = fresh.context;
        state.page = fresh.page;
        state.page.setDefaultTimeout(navTimeout);
        console.log("Reconnected. Checking login status...");
        await state.page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
        const loggedIn = await isLoggedIn(state.page, selectors);
        if (!loggedIn) {
          await tryFillCredentials(state.page, selectors, username, password);
          await loginWithHumanCaptcha(state.page, selectors, readyPhrase, navTimeout);
          await state.page.waitForTimeout(1500);
          await saveState(state.context, authStatePath);
        }
        console.log("Ready. You may continue with commands.");
      } else {
        console.log("Exiting live mode.");
        clearIdleTimer(state);
        return;
      }
      continue;
    }

    try {
      if (cmd === "help") {
        console.log("Commands:");
        console.log("  url");
        console.log("  goto <url>");
        console.log("  click <css-selector>");
        console.log("  fill <css-selector> :: <text>");
        console.log("  wait <seconds>");
        console.log("  download <css-selector>");
        console.log("  screenshot [abs-path]");
        console.log("  save-state");
        console.log("  exit");
        continue;
      }

      if (cmd === "url") {
        console.log(`Current URL: ${state.page.url()}`);
        continue;
      }

      if (cmd === "goto") {
        if (!args) {
          console.log("Usage: goto <url>");
          continue;
        }
        await state.page.goto(args, { waitUntil: "domcontentloaded", timeout: navTimeout });
        console.log(`Navigated: ${state.page.url()}`);
        await checkSessionAfterNav(state.page, selectors, loginUrl, username, password, readyPhrase, navTimeout);
        continue;
      }

      if (cmd === "click") {
        if (!args) {
          console.log("Usage: click <css-selector>");
          continue;
        }
        await state.page.locator(args).first().click({ timeout: navTimeout });
        console.log(`Clicked: ${args}`);
        continue;
      }

      if (cmd === "fill") {
        const separator = " :: ";
        if (!args.includes(separator)) {
          console.log("Usage: fill <css-selector> :: <text>");
          continue;
        }
        const sepIndex = args.indexOf(separator);
        const selector = args.slice(0, sepIndex).trim();
        const text = args.slice(sepIndex + separator.length);
        await state.page.locator(selector).first().fill(text);
        console.log(`Filled: ${selector}`);
        continue;
      }

      if (cmd === "wait") {
        const seconds = Number(args);
        if (!Number.isFinite(seconds) || seconds < 0) {
          console.log("Usage: wait <seconds>");
          continue;
        }
        await state.page.waitForTimeout(seconds * 1000);
        console.log(`Waited ${seconds}s.`);
        continue;
      }

      if (cmd === "download") {
        if (!args) {
          console.log("Usage: download <css-selector>");
          continue;
        }
        await checkSessionAfterNav(state.page, selectors, loginUrl, username, password, readyPhrase, navTimeout);
        const [download] = await Promise.all([
          state.page.waitForEvent("download", { timeout: getNumEnv("DOWNLOAD_TIMEOUT_MS", 600000) }),
          state.page.locator(args).first().click()
        ]);
        const suggested = download.suggestedFilename() || `paper_${timestampString()}.pdf`;
        const savePath = path.resolve(downloadDir, suggested);
        await download.saveAs(savePath);
        console.log(`Downloaded: ${savePath}`);
        continue;
      }

      if (cmd === "screenshot") {
        const filePath = args
          ? path.resolve(args)
          : path.resolve(downloadDir, `screen_${timestampString()}.png`);
        await state.page.screenshot({ path: filePath, fullPage: true });
        console.log(`Screenshot saved: ${filePath}`);
        continue;
      }

      if (cmd === "save-state") {
        await saveState(state.context, authStatePath);
        continue;
      }

      if (cmd === "exit") {
        await saveState(state.context, authStatePath);
        console.log("Exiting live mode.");
        clearIdleTimer(state);
        return;
      }

      console.log("Unknown command. Type help.");
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("Target closed") || msg.includes("browser has been closed")) {
        console.log("Browser disconnected during command. Will attempt reconnect on next input.");
      } else {
        console.log(`Command failed: ${msg}`);
      }
    }
  }
}

async function main() {
  const selectors = readSelectors();
  const loginUrl = getEnv("LOGIN_URL") || getEnv("SITE_BASE_URL");
  const credentialBundle = resolveSiteCredentials({
    username: getEnv("USERNAME"),
    password: getEnv("PASSWORD")
  });
  const username = credentialBundle.username;
  const password = credentialBundle.password;
  const authStatePath = path.resolve(getEnv("AUTH_STATE_PATH", DEFAULT_AUTH_STATE));
  const downloadDir = path.resolve(getEnv("DOWNLOAD_DIR", "./downloads"));
  const headed = getBoolEnv("HEADED", true);
  const navTimeout = getNumEnv("NAV_TIMEOUT_MS", 120000);
  const readyPhrase = getEnv("CAPTCHA_READY_PHRASE", DEFAULT_READY_PHRASE);

  if (!loginUrl) {
    throw new Error("Set LOGIN_URL or SITE_BASE_URL in .env");
  }
  if (!username || !password) {
    throw new Error("Set USERNAME and PASSWORD in .env before running live mode.");
  }

  const { browser, context, page } = await launchBrowser(headed, authStatePath);
  page.setDefaultTimeout(navTimeout);

  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
  let loggedIn = await isLoggedIn(page, selectors);

  if (!loggedIn) {
    await tryFillCredentials(page, selectors, username, password);
    await loginWithHumanCaptcha(page, selectors, readyPhrase, navTimeout);
    await page.waitForTimeout(1500);
    loggedIn = await isLoggedIn(page, selectors);
  }

  if (!loggedIn) {
    console.log("Login still not confirmed. You can continue manually and then run: save-state");
  } else {
    console.log("Login confirmed.");
    await saveState(context, authStatePath);
  }

  const state = { browser, context, page, idleTimer: null };
  try {
    await runInteractiveLoop(
      state, selectors, loginUrl, username, password, readyPhrase,
      authStatePath, downloadDir, headed, navTimeout
    );
  } finally {
    clearIdleTimer(state);
    await state.context.close().catch(() => {});
    await state.browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`Live mode failed: ${err.message}`);
  process.exit(1);
});
