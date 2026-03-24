const path = require("path");
const { ensureDir, getNumEnv } = require("./common");
const {
  getCaptchaElements,
  hasCaptcha,
  refreshCaptcha,
  solveTextCaptcha
} = require("./library-captcha");

async function isVisible(page, selector) {
  if (!selector) return false;
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function hasLoginForm(page, selectors) {
  const userSelector = selectors?.login?.username;
  const passSelector = selectors?.login?.password;
  return (await isVisible(page, userSelector)) || (await isVisible(page, passSelector));
}

async function bodyText(page) {
  return page.locator("body").innerText().catch(() => "");
}

async function isLoggedIn(page, selectors) {
  if (selectors?.login?.successIndicator) {
    if (await isVisible(page, selectors.login.successIndicator)) {
      return true;
    }
  }

  if (await hasLoginForm(page, selectors)) {
    return false;
  }

  const text = await bodyText(page);
  return /\u9000\u51fa\u767b\u5f55|\u4f1a\u5458\u4e2d\u5fc3|\u4f1a\u5458\u8d26\u53f7|\u6b22\u8fce\u60a8|\u7eed\u8d39|\u6211\u7684\u8d26\u6237|\u4e2a\u4eba\u4e2d\u5fc3/.test(text);
}

async function fillCredentials(page, selectors, username, password) {
  if (selectors?.login?.username && username) {
    const field = page.locator(selectors.login.username).first();
    await field.fill("");
    await field.fill(username);
    const actual = await field.inputValue().catch(() => "");
    if (actual !== username) {
      throw new Error("Username field did not retain the expected value.");
    }
  }
  if (selectors?.login?.password && password) {
    const field = page.locator(selectors.login.password).first();
    await field.fill("");
    await field.fill(password);
    const actual = await field.inputValue().catch(() => "");
    if (actual !== password) {
      throw new Error("Password field did not retain the expected value.");
    }
  }
  console.log("[auth] credential fields filled and verified locally.");
}

async function clickSubmit(page, selectors) {
  if (selectors?.login?.submit) {
    await page.locator(selectors.login.submit).first().click({ force: true });
    return;
  }
  if (selectors?.login?.password) {
    await page.locator(selectors.login.password).first().press("Enter");
    return;
  }
  throw new Error("Login submit selector is missing.");
}

async function saveState(context, authStatePath) {
  if (!authStatePath) return;
  ensureDir(path.dirname(authStatePath));
  await context.storageState({ path: authStatePath });
}

async function submitSolvedCaptcha(page, selectors, predicted) {
  await Promise.allSettled([
    page.waitForLoadState("domcontentloaded", { timeout: getNumEnv("NAV_TIMEOUT_MS", 120000) }),
    clickSubmit(page, selectors)
  ]);
  await page.waitForTimeout(getNumEnv("LIBRARY_LOGIN_POST_SUBMIT_WAIT_MS", 2200));
  return predicted;
}

async function ensureLibrarySession({
  page,
  context,
  selectors,
  authStatePath,
  loginUrl,
  username,
  password,
  navTimeout
}) {
  const loginAttempts = getNumEnv("LIBRARY_LOGIN_MAX_ATTEMPTS", 4);

  if (!loginUrl) {
    throw new Error("LOGIN_URL or SITE_BASE_URL is required for library login.");
  }

  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
  if (await isLoggedIn(page, selectors)) {
    await saveState(context, authStatePath);
    return;
  }

  if (!username || !password) {
    throw new Error("USERNAME and PASSWORD are required because no valid library session is available.");
  }

  for (let attempt = 1; attempt <= loginAttempts; attempt += 1) {
    console.log(`Library login attempt ${attempt}/${loginAttempts}...`);
    await fillCredentials(page, selectors, username, password);

    if (await hasCaptcha(page, selectors?.login || {})) {
      let solved = null;
      try {
        solved = await solveTextCaptcha(page, selectors.login || {}, {
          label: `library-login-${attempt}`,
          // This login form often clears the password after a failed submit,
          // so each captcha guess should be a fresh outer login attempt.
          maxAttempts: 1,
          expectedPattern: /^\d{4}$/,
          verify: async () => {
            await submitSolvedCaptcha(page, selectors, "");
            return await isLoggedIn(page, selectors);
          }
        });
      } catch (error) {
        console.log(`Library captcha solve attempt ${attempt} failed: ${error.message || error}`);
      }
      if (solved?.solved) {
        console.log(`Library captcha recognized as: ${solved.text}`);
      }
    } else {
      await Promise.allSettled([
        page.waitForLoadState("domcontentloaded", { timeout: navTimeout }),
        clickSubmit(page, selectors)
      ]);
      await page.waitForTimeout(getNumEnv("LIBRARY_LOGIN_POST_SUBMIT_WAIT_MS", 2200));
    }

    if (await isLoggedIn(page, selectors)) {
      console.log("Library login confirmed.");
      await saveState(context, authStatePath);
      return;
    }

    if (attempt < loginAttempts) {
      if (await hasCaptcha(page, selectors?.login || {})) {
        const elements = await getCaptchaElements(page, selectors.login || {});
        await refreshCaptcha(elements, page).catch(() => {});
      }
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
    }
  }

  throw new Error("Library login was not confirmed after captcha retries.");
}

module.exports = {
  ensureLibrarySession,
  hasLoginForm,
  isLoggedIn
};
