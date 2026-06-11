// Drive headless Chromium over the DevTools Protocol (no puppeteer): open the
// smoke page, poll #out in real time until it reports RESULT, print it, exit
// non-zero on failure. Uses Node's built-in fetch + WebSocket globals.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_TO_OPEN = process.argv[2] ?? "http://127.0.0.1:8744/test/index.html";
const PORT = 9333;
const CHROME = "/snap/bin/chromium";

const profile = mkdtempSync(join(tmpdir(), "htl-cdp-"));
const HEADED = process.env.HTL_HEADED === "1"; // real GPU + window (true WebGPU)
const GPU = process.env.HTL_WEBGPU === "1"; // enable WebGPU (Linux needs explicit flags)
const chrome = spawn(CHROME, [
  ...(HEADED ? ["--start-minimized"] : ["--headless=new"]),
  ...(GPU ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan"] : HEADED ? [] : ["--disable-gpu"]),
  "--no-sandbox",
  "--disable-dev-shm-usage",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "about:blank",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};

async function wsConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error("ws error: " + (e.message ?? "")));
  });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.consoleAPICalled") {
      logs.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      logs.push("[exception] " + (d.exception?.description || d.text || JSON.stringify(d)));
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { send, logs };
}

try {
  // Wait for the debugger endpoint.
  let pageWs = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_TO_OPEN)}`, { method: "PUT" });
      if (r.ok) { pageWs = (await r.json()).webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(150);
  }
  if (!pageWs) throw new Error("could not open a debugging target");

  const { send, logs } = await wsConnect(pageWs);
  await send("Runtime.enable");
  if (process.env.HTL_LOGS === "1") {
    const dump = () => logs.length && console.log("--- console ---\n" + logs.join("\n"));
    process.on("exit", dump);
  }

  // Poll the page's #out until it carries a RESULT (real time → audio renders).
  let text = "";
  for (let i = 0; i < 1400; i++) {
    const r = await send("Runtime.evaluate", {
      expression: "document.getElementById('out')?.textContent || ''",
      returnByValue: true,
    });
    text = r.result?.result?.value ?? "";
    if (text.startsWith("RESULT")) break;
    await sleep(250);
  }

  const json = text.startsWith("RESULT") ? text.slice("RESULT ".length) : null;
  if (!json) { console.log("TIMEOUT, last #out:", JSON.stringify(text)); cleanup(); process.exit(2); }
  console.log("RESULT", json);
  const parsed = JSON.parse(json);
  cleanup();
  process.exit(parsed.pass ? 0 : 1);
} catch (err) {
  console.error("DRIVER ERROR", err.message);
  cleanup();
  process.exit(3);
}
