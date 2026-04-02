const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { ensureDir } = require("./common");

const CANDIDATE_FIELDS = [
  "paper_id",
  "title",
  "authors",
  "journal",
  "publish_year",
  "cited_count",
  "download_count",
  "final_score",
  "label",
  "keep_reason",
  "abstract",
  "page_url",
  "db_code",
  "file_name",
  "user_select"
];

function parseArgs(argv) {
  const options = {
    runDir: "",
    downloadLimit: 8,
    candidateLimit: 15
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--run-dir") {
      options.runDir = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (token === "--download-limit") {
      options.downloadLimit = Number(argv[index + 1] || options.downloadLimit);
      index += 1;
      continue;
    }
    if (token === "--candidate-limit") {
      options.candidateLimit = Number(argv[index + 1] || options.candidateLimit);
      index += 1;
      continue;
    }
  }

  if (!options.runDir) {
    throw new Error("Use --run-dir to point at a pipeline output directory.");
  }
  if (!Number.isFinite(options.downloadLimit) || options.downloadLimit <= 0) {
    options.downloadLimit = 8;
  }
  if (!Number.isFinite(options.candidateLimit) || options.candidateLimit <= 0) {
    options.candidateLimit = 15;
  }
  return options;
}

function readCsvRows(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV not found: ${filePath}`);
  }
  return parse(fs.readFileSync(filePath, "utf8"), {
    bom: true,
    columns: true,
    skip_empty_lines: true
  });
}

function writeCsvRows(filePath, rows, columns) {
  ensureDir(path.dirname(filePath));
  const output = stringify(rows, {
    header: true,
    columns,
    bom: true
  });
  fs.writeFileSync(filePath, output, "utf8");
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeTitle(value) {
  return String(value || "")
    .replace(/[“”"'《》〈〉（）()·:：—\-]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function safeNumber(value) {
  const numeric = Number(String(value || "0").replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function containsAny(text, terms) {
  return terms.filter((term) => text.includes(term));
}

function heuristicScore(row) {
  const title = String(row.title || "");
  const journal = String(row.journal || "");
  const abstract = String(row.abstract || "");
  const haystack = `${title} ${journal} ${abstract}`;

  const strongPositive = [
    "岳阳楼记",
    "范仲淹",
    "滕子京",
    "庆历",
    "成书",
    "写作",
    "创作",
    "背景",
    "文本",
    "版本",
    "校勘",
    "传播",
    "接受",
    "经典化",
    "文史",
    "历史",
    "文学地理"
  ];
  const mildPositive = [
    "家国",
    "政治",
    "友情",
    "文体",
    "景观",
    "思想",
    "史料",
    "文献"
  ];
  const strongNegative = [
    "教学",
    "教案",
    "课堂",
    "教材",
    "高一",
    "中学",
    "语文",
    "插画",
    "设计",
    "文旅",
    "纸塑",
    "朗读",
    "背诵"
  ];
  const mildNegative = [
    "赏析",
    "艺术特色",
    "动态",
    "旅游",
    "课文",
    "探究"
  ];

  const positives = containsAny(haystack, strongPositive);
  const milds = containsAny(haystack, mildPositive);
  const negatives = containsAny(haystack, strongNegative);
  const softNegatives = containsAny(haystack, mildNegative);

  let score = 0;
  score += positives.length * 1.15;
  score += milds.length * 0.35;
  score -= negatives.length * 1.0;
  score -= softNegatives.length * 0.35;

  if (title.includes("岳阳楼记")) score += 2.2;
  if (title.includes("成书") || title.includes("写作") || title.includes("背景")) score += 1.2;
  if (title.includes("滕子京") || title.includes("范仲淹") || title.includes("庆历")) score += 0.8;

  const publishYear = safeNumber(row.publish_year);
  if (publishYear >= 2020) score += 0.2;
  if (publishYear >= 2023) score += 0.1;

  const citedCount = safeNumber(row.cited_count);
  const downloadCount = safeNumber(row.download_count);
  score += Math.min(1.0, Math.log10(citedCount + 1) * 0.28);
  score += Math.min(1.0, Math.log10(downloadCount + 1) * 0.18);

  const exactNoise = negatives.length >= 2 || title.includes("设计") || title.includes("插画");
  let label = "unknown";
  if (score >= 2.2) {
    label = "history";
  } else if (score >= 1.2) {
    label = "mixed";
  } else if (exactNoise) {
    label = "teaching";
  }

  const isWorthKeeping = label === "history" || label === "mixed";
  const relevanceScore = Math.max(0, Math.min(1, score / 4.0));
  const reasons = [];
  if (title.includes("岳阳楼记")) reasons.push("标题直接命中《岳阳楼记》");
  if (title.includes("成书") || title.includes("写作") || title.includes("背景")) reasons.push("主题贴近成书/写作背景");
  if (title.includes("范仲淹") || title.includes("滕子京") || title.includes("庆历")) reasons.push("涉及核心历史人物或时代背景");
  if (!reasons.length && positives.length) reasons.push(`命中关键词：${positives.slice(0, 3).join("、")}`);
  if (!reasons.length && isWorthKeeping) reasons.push("与题目存在较强相关性");
  if (!reasons.length) reasons.push("相关性较弱，保留价值有限");

  return {
    score,
    label,
    isWorthKeeping,
    relevanceScore,
    keepReason: reasons.join("；")
  };
}

function dedupeRows(rows) {
  const byTitle = new Map();
  for (const row of rows) {
    const key = `${normalizeTitle(row.title)}|${String(row.publish_year || "")}`;
    if (!key.trim()) continue;
    const current = byTitle.get(key);
    const currentValue = current ? safeNumber(current.download_count) + safeNumber(current.cited_count) : -1;
    const nextValue = safeNumber(row.download_count) + safeNumber(row.cited_count);
    if (!current || nextValue > currentValue) {
      byTitle.set(key, { ...row });
    }
  }
  return Array.from(byTitle.values());
}

function buildCandidateRows(rows, options) {
  const deduped = dedupeRows(rows);
  const enriched = deduped.map((row) => {
    const mapped = heuristicScore(row);
    return {
      ...row,
      relevance_score: mapped.relevanceScore.toFixed(4),
      label: mapped.label,
      keep_reason: mapped.keepReason,
      is_worth_keeping: mapped.isWorthKeeping ? "true" : "false",
      heuristic_score: mapped.score
    };
  });

  const shortlisted = enriched
    .filter((row) => row.is_worth_keeping === "true" && row.label !== "teaching")
    .sort((left, right) => {
      const scoreDiff = Number(right.heuristic_score || 0) - Number(left.heuristic_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const impactDiff =
        safeNumber(right.cited_count) +
        safeNumber(right.download_count) -
        safeNumber(left.cited_count) -
        safeNumber(left.download_count);
      return impactDiff;
    })
    .slice(0, options.candidateLimit);

  const selectedKeys = new Set(
    shortlisted.slice(0, options.downloadLimit).map((row) => `${normalizeTitle(row.title)}|${String(row.publish_year || "")}`)
  );

  const candidateRows = shortlisted.map((row) => ({
    paper_id: row.paper_id || "",
    title: row.title || "",
    authors: row.authors || "",
    journal: row.journal || "",
    publish_year: row.publish_year || "",
    cited_count: row.cited_count || "",
    download_count: row.download_count || "",
    final_score: Number(row.heuristic_score || 0).toFixed(4),
    label: row.label || "",
    keep_reason: row.keep_reason || "",
    abstract: row.abstract || "",
    page_url: row.page_url || "",
    db_code: row.db_code || "",
    file_name: row.file_name || "",
    user_select: selectedKeys.has(`${normalizeTitle(row.title)}|${String(row.publish_year || "")}`) ? "yes" : ""
  }));

  const queueRows = candidateRows.filter((row) => row.user_select === "yes").slice(0, options.downloadLimit);
  return { candidateRows, queueRows, dedupedCount: deduped.length };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(options.runDir);
  const masterPath = path.join(runDir, "papers_master.csv");
  const candidatePath = path.join(runDir, "papers_for_download.csv");
  const queuePath = path.join(runDir, "download_queue.csv");
  const summaryPath = path.join(runDir, "heuristic_queue_summary.json");

  const rows = readCsvRows(masterPath);
  const { candidateRows, queueRows, dedupedCount } = buildCandidateRows(rows, options);
  writeCsvRows(candidatePath, candidateRows, CANDIDATE_FIELDS);
  writeCsvRows(queuePath, queueRows, CANDIDATE_FIELDS);

  const summary = {
    runDir,
    sourceRows: rows.length,
    dedupedRows: dedupedCount,
    candidateCount: candidateRows.length,
    queueCount: queueRows.length,
    selectedTitles: queueRows.map((row) => row.title)
  };
  writeJson(summaryPath, summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main();
