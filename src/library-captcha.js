const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ensureDir, getNumEnv, timestampString } = require("./common");

const ROOT_DIR = path.resolve(__dirname, "..");

function resolveOcrScript() {
  const candidates = [
    path.join(ROOT_DIR, "Chinese paper search", "cnkiLRspider", "kimi_image_ocr.py"),
    path.join(ROOT_DIR, "python-scraper", "cnkiLRspider", "kimi_image_ocr.py")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

const OCR_SCRIPT = resolveOcrScript();

const DEFAULT_INPUT_SELECTORS = [
  "input[name='yzm']",
  "input[name='captcha']",
  "input[name='code']",
  "input[id*='captcha']",
  "input[id*='verify']",
  "input[placeholder*='\u9a8c\u8bc1\u7801']",
  "input[placeholder*='\u6821\u9a8c\u7801']"
];

const DEFAULT_IMAGE_SELECTORS = [
  "img[title*='\u5237\u65b0']",
  "img[alt*='\u9a8c\u8bc1\u7801']",
  "img[src*='captcha']",
  "img[src*='verify']",
  "img[src*='ValidateCode']",
  ".captcha img",
  "#checkcodeimg",
  "#verifycode",
  "#imgcode"
];

const DEFAULT_REFRESH_SELECTORS = [
  "img[title*='\u5237\u65b0']",
  "a[title*='\u5237\u65b0']",
  "a:has-text('\u5237\u65b0')",
  "button:has-text('\u5237\u65b0')",
  ".captcha-refresh",
  "[onclick*='refresh']",
  "[onclick*='Refresh']"
];

const DEFAULT_SUBMIT_SELECTORS = [
  "button:has-text('\u63d0\u4ea4')",
  "button:has-text('\u786e\u5b9a')",
  "button:has-text('\u9a8c\u8bc1')",
  "button:has-text('\u767b\u5f55')",
  "input[type='submit']",
  "input[type='button'][value*='\u63d0\u4ea4']",
  "input[type='button'][value*='\u786e\u5b9a']"
];

function toSelectorList(configValue, fallbacks) {
  if (Array.isArray(configValue)) {
    return [...configValue, ...fallbacks];
  }
  if (typeof configValue === "string" && configValue.trim()) {
    return [configValue.trim(), ...fallbacks];
  }
  return [...fallbacks];
}

async function firstVisibleLocator(page, candidates) {
  for (const selector of candidates) {
    try {
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (!count) continue;
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    } catch {
      // Ignore invalid or unsupported fallback selectors.
    }
  }
  return null;
}

async function getCaptchaElements(page, selectorGroup = {}) {
  const input = await firstVisibleLocator(
    page,
    toSelectorList(selectorGroup.captcha, DEFAULT_INPUT_SELECTORS)
  );
  const image = await firstVisibleLocator(
    page,
    toSelectorList(selectorGroup.captchaImage, DEFAULT_IMAGE_SELECTORS)
  );
  const refresh = await firstVisibleLocator(
    page,
    toSelectorList(selectorGroup.captchaRefresh, DEFAULT_REFRESH_SELECTORS)
  );
  const submit = await firstVisibleLocator(
    page,
    toSelectorList(selectorGroup.captchaSubmit, DEFAULT_SUBMIT_SELECTORS)
  );
  return { input, image, refresh, submit };
}

async function hasCaptcha(page, selectorGroup = {}) {
  const { input, image } = await getCaptchaElements(page, selectorGroup);
  return Boolean(input && image);
}

function callKimiOcr(imagePath, label) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [OCR_SCRIPT, imagePath], {
      cwd: ROOT_DIR,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1"
      }
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Captcha OCR failed for ${label || "captcha"} with code ${code}: ${
              stderr.trim() || stdout.trim() || "unknown error"
            }`
          )
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const captcha = String(parsed.captcha || "")
          .replace(/\s+/g, "")
          .replace(/[^0-9A-Za-z]/g, "")
          .trim();
        if (!captcha) {
          reject(new Error(`Captcha OCR returned empty text for ${label || "captcha"}.`));
          return;
        }
        resolve(captcha);
      } catch (error) {
        reject(
          new Error(
            `Captcha OCR returned invalid JSON for ${label || "captcha"}: ${
              stdout.trim() || error.message
            }`
          )
        );
      }
    });
  });
}

async function clickBestEffort(locator) {
  await locator.click({ force: true }).catch(async () => {
    await locator.dispatchEvent("click").catch(() => {});
  });
}

async function refreshCaptcha(elements, page) {
  const waitMs = getNumEnv("LIBRARY_CAPTCHA_REFRESH_WAIT_MS", 1200);
  const target = elements.refresh || elements.image;
  if (!target) return false;
  await clickBestEffort(target);
  await page.waitForTimeout(waitMs);
  return true;
}

async function solveTextCaptcha(page, selectorGroup = {}, options = {}) {
  const label = options.label || "library-captcha";
  const maxAttempts = options.maxAttempts || getNumEnv("LIBRARY_CAPTCHA_MAX_ATTEMPTS", 3);
  const outputDir = options.outputDir || path.join(ROOT_DIR, "outputs", "library-captcha");
  const postFillWaitMs = options.postFillWaitMs || getNumEnv("LIBRARY_CAPTCHA_POST_FILL_WAIT_MS", 800);
  const submitAfterFill = Boolean(options.submitAfterFill);
  const expectedPattern = options.expectedPattern instanceof RegExp ? options.expectedPattern : null;
  ensureDir(outputDir);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const elements = await getCaptchaElements(page, selectorGroup);
    if (!elements.input || !elements.image) {
      return { solved: false, text: "", attempts: attempt - 1, imagePath: "" };
    }

    const imagePath = path.join(
      outputDir,
      `${timestampString()}_${label}_attempt${attempt}.png`
    );

    try {
      await elements.image.screenshot({ path: imagePath });
      const predicted = await callKimiOcr(imagePath, `${label}#${attempt}`);
      if (expectedPattern && !expectedPattern.test(predicted)) {
        throw new Error(`Captcha OCR returned unexpected format for ${label}: ${predicted}`);
      }
      await elements.input.fill("");
      await elements.input.fill(predicted);

      if (submitAfterFill) {
        if (elements.submit) {
          await clickBestEffort(elements.submit);
        } else {
          await elements.input.press("Enter").catch(() => {});
        }
      }

      await page.waitForTimeout(postFillWaitMs);

      if (typeof options.verify === "function") {
        const verified = await options.verify({
          attempt,
          predicted,
          imagePath,
          elements
        });
        if (verified) {
          return { solved: true, text: predicted, attempts: attempt, imagePath };
        }
      } else {
        return { solved: true, text: predicted, attempts: attempt, imagePath };
      }
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
    }

    if (attempt < maxAttempts) {
      await refreshCaptcha(elements, page).catch(() => {});
    }
  }

  return { solved: false, text: "", attempts: maxAttempts, imagePath: "" };
}

module.exports = {
  getCaptchaElements,
  hasCaptcha,
  refreshCaptcha,
  solveTextCaptcha
};
