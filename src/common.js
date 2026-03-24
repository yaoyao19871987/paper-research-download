const fs = require("fs");
const path = require("path");
const readline = require("readline");
const dotenv = require("dotenv");

const ROOT_DIR = path.resolve(__dirname, "..");

function loadEnvironmentFiles() {
  const envName = String(process.env.PAPER_ENV || "").trim().toLowerCase();
  const envFiles = [".env"];

  if (envName) {
    envFiles.push(`.env.${envName}`);
  }

  for (const fileName of envFiles) {
    const filePath = path.join(ROOT_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    dotenv.config({
      path: filePath,
      override: fileName !== ".env"
    });
  }
}

loadEnvironmentFiles();

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readSelectors() {
  const selectorPath = path.resolve(process.cwd(), "config", "selectors.json");
  if (!fs.existsSync(selectorPath)) {
    throw new Error(
      "找不到 config/selectors.json，请先从 config/selectors.example.json 复制一份并按页面实际结构修改。"
    );
  }
  return JSON.parse(fs.readFileSync(selectorPath, "utf-8"));
}

function getEnv(name, fallback = "") {
  const value = process.env[name];
  return value === undefined ? fallback : value;
}

function getBoolEnv(name, defaultValue = true) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes";
}

function getNumEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function askEnter(questionText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(questionText, () => {
      rl.close();
      resolve();
    });
  });
}

function askLine(questionText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(questionText, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function timestampString() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
    now.getHours()
  )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

module.exports = {
  ensureDir,
  readSelectors,
  getEnv,
  getBoolEnv,
  getNumEnv,
  askEnter,
  askLine,
  timestampString
};
