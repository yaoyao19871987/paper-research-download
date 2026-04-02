const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const { RunManager, ROOT_DIR } = require("./run-manager");
const { resolveSiteCredentials } = require("./site-credentials");

const UI_DIR = path.join(ROOT_DIR, "ui");
const DEFAULT_PORT = Number(process.env.CONSOLE_PORT || 8787);
const MAX_BODY_BYTES = 1024 * 1024;

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message || error}`));
      }
    });
    req.on("error", reject);
  });
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    text(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  const contentType = contentTypes[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function buildHealthPayload(manager) {
  return {
    ok: true,
    service: "paper-download-console",
    timestamp: new Date().toISOString(),
    activeRun: manager.getActiveRunSummary()
  };
}

function createServer() {
  const manager = new RunManager();

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const { pathname, searchParams } = requestUrl;

    try {
      if (req.method === "GET" && pathname === "/api/health") {
        json(res, 200, buildHealthPayload(manager));
        return;
      }

      if (req.method === "GET" && pathname === "/api/preflight") {
        json(res, 200, manager.runPreflightChecks({ resolveSiteCredentials }));
        return;
      }

      if (req.method === "GET" && pathname === "/api/runs/active") {
        json(res, 200, {
          activeRun: manager.getActiveRunSummary(),
          activeSnapshot: manager.getActiveRunSnapshot()
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/runs/latest") {
        json(res, 200, manager.getRunSnapshot("latest"));
        return;
      }

      if (req.method === "POST" && pathname === "/api/runs/new") {
        const body = await readBody(req);
        const snapshot = manager.startRun({
          topic: body.topic,
          downloadLimit: Number(body.downloadLimit || 20),
          mode: body.mode === "manual" ? "manual" : "auto"
        });
        json(res, 200, snapshot);
        return;
      }

      if (req.method === "POST" && pathname === "/api/runs/resume") {
        const body = await readBody(req);
        const snapshot = manager.resumeRun({
          runDir: body.runDir,
          downloadLimit: Number(body.downloadLimit || 20),
          mode: body.mode === "manual" ? "manual" : "auto"
        });
        json(res, 200, snapshot);
        return;
      }

      if (req.method === "POST" && pathname === "/api/runs/active/continue") {
        json(res, 200, manager.continueActiveRun());
        return;
      }

      if (req.method === "POST" && pathname === "/api/runs/active/stop") {
        json(res, 200, manager.stopActiveRun());
        return;
      }

      const statusMatch = pathname.match(/^\/api\/runs\/([^/]+)\/status$/);
      if (req.method === "GET" && statusMatch) {
        json(res, 200, manager.getRunSnapshot(statusMatch[1]));
        return;
      }

      const logsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/logs$/);
      if (req.method === "GET" && logsMatch) {
        const cursorRaw = searchParams.get("cursor");
        const cursor = cursorRaw === null || cursorRaw === "" ? null : Number(cursorRaw);
        json(res, 200, manager.readLog(logsMatch[1], cursor));
        return;
      }

      if (req.method === "GET" && pathname === "/api/file") {
        const filePath = searchParams.get("path") || "";
        json(res, 200, manager.readFilePreview(filePath));
        return;
      }

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        sendFile(res, path.join(UI_DIR, "index.html"));
        return;
      }

      if (req.method === "GET" && (pathname === "/app.js" || pathname === "/styles.css")) {
        sendFile(res, path.join(UI_DIR, pathname.slice(1)));
        return;
      }

      text(res, 404, "Not found");
    } catch (error) {
      json(res, 500, {
        ok: false,
        error: error.message || String(error || "Unknown error")
      });
    }
  });

  return { server, manager };
}

function startServer(port = DEFAULT_PORT) {
  const { server, manager } = createServer();
  server.listen(port, "127.0.0.1", () => {
    const active = manager.getActiveRunSummary();
    console.log(`Paper console listening on http://127.0.0.1:${port}`);
    if (active) {
      console.log(`Recovered active run: ${active.runId} (${active.topic || "no topic"})`);
    }
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServer,
  startServer
};
