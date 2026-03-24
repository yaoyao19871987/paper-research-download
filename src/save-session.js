const path = require("path");
const { chromium } = require("playwright");
const {
  ensureDir,
  readSelectors,
  getEnv,
  getBoolEnv,
  getNumEnv,
  askEnter
} = require("./common");
const { resolveSiteCredentials } = require("./site-credentials");

async function main() {
  const selectors = readSelectors();
  const loginUrl = getEnv("LOGIN_URL") || getEnv("SITE_BASE_URL");
  const credentialBundle = resolveSiteCredentials({
    username: getEnv("USERNAME"),
    password: getEnv("PASSWORD")
  });
  const username = credentialBundle.username;
  const password = credentialBundle.password;
  const authStatePath = path.resolve(
    getEnv("AUTH_STATE_PATH", "D:/Code/paper-download/state/auth.json")
  );
  const headed = getBoolEnv("HEADED", true);
  const navTimeout = getNumEnv("NAV_TIMEOUT_MS", 120000);

  if (!loginUrl) {
    throw new Error("请在 .env 中设置 LOGIN_URL 或 SITE_BASE_URL。");
  }

  ensureDir(path.dirname(authStatePath));

  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 100 : 0
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);

  console.log(`打开登录页: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  if (username && selectors.login.username) {
    await page.fill(selectors.login.username, username);
    console.log("已填写用户名。");
  }
  if (password && selectors.login.password) {
    await page.fill(selectors.login.password, password);
    console.log("已填写密码。");
  }

  console.log(
    "请在浏览器中手动完成验证码、可能的滑块、短信验证，并完成登录。"
  );
  if (selectors.login.successIndicator) {
    console.log(`登录成功判断标识: ${selectors.login.successIndicator}`);
  }

  await askEnter("登录完成后回到终端，按 Enter 保存会话... ");

  await context.storageState({ path: authStatePath });
  console.log(`会话已保存: ${authStatePath}`);

  await browser.close();
}

main().catch((err) => {
  console.error("保存会话失败:", err.message);
  process.exit(1);
});
