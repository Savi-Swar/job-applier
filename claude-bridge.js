// Claude bridge — lets the Job Applier extension use your Claude Max plan for
// AI answers via the local `claude` CLI (no API billing, no keys).
//
//   Start manually:  node ~/Downloads/job-applier/claude-bridge.js
//   Auto-start:      installed as a launchd agent (com.savitur.claude-bridge)
//
// Endpoints (127.0.0.1 only — never exposed to the network):
//   GET  /ping      -> "ok"
//   POST /generate  {"prompt": "..."} -> {"text": "..."} | {"error": "..."}

const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = 8976;
// launchd doesn't have the user's shell PATH — resolve the CLI explicitly
const CLAUDE_BIN =
  [process.env.HOME + "/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
    .find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || "claude";

function runClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ["-p"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: "" }, // never nest into a parent session
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ error: "Claude timed out after 150s" }); }, 150000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      clearTimeout(timer);
      const text = out.trim();
      if (/not logged in/i.test(text + err))
        resolve({ error: "claude CLI not logged in — run `claude` in Terminal once and use /login", code: 503 });
      else if (text) resolve({ text });
      else resolve({ error: (err.trim() || "empty response from claude").slice(0, 300) });
    });
    child.on("error", (e) =>
      resolve({ error: "could not launch claude CLI: " + e.message, code: 503 }));
    child.stdin.end(prompt);
  });
}

http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.end();
    if (req.method === "GET" && req.url === "/ping") return res.end("ok");
    if (req.method === "POST" && req.url === "/generate") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        let prompt;
        try { prompt = JSON.parse(body).prompt; } catch { /* fallthrough */ }
        if (!prompt) { res.statusCode = 400; return res.end(JSON.stringify({ error: "no prompt" })); }
        const result = await runClaude(prompt);
        if (result.error) res.statusCode = result.code || 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  })
  .listen(PORT, "127.0.0.1", () => console.log(`claude-bridge listening on 127.0.0.1:${PORT}`));
