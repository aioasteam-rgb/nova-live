// Nova Live Operator - prototype
// Tavus (Nova) -> tool call -> this server -> Stagehand on a Browserbase cloud browser -> GAMA portals.
// The meeting sees the browser through /workspace, which Nova opens with her Browser Use flow.

import express from "express";
import crypto from "node:crypto";
import { Stagehand } from "@browserbasehq/stagehand";
import Browserbase from "@browserbasehq/sdk";

const env = (k, d = "") => process.env[k] ?? d;
const PORT = Number(env("PORT", "3000"));
const PUBLIC_URL = env("PUBLIC_URL").replace(/\/$/, ""); // e.g. https://nova-live.onrender.com
const ADMIN_TOKEN = env("ADMIN_TOKEN"); // protects /console actions and /setup
const TAVUS_API_KEY = env("TAVUS_API_KEY");
const TAVUS_PAL_ID = env("TAVUS_PAL_ID");
const TOOL_SECRET = env("TOOL_SECRET"); // shared HMAC secret for Tavus tool calls
const BB_API_KEY = env("BROWSERBASE_API_KEY");
const BB_PROJECT_ID = env("BROWSERBASE_PROJECT_ID");
const MODEL = env("STAGEHAND_MODEL", "google/gemini-2.5-flash");
const MODEL_API_KEY = env("MODEL_API_KEY");
const MAX_WAIT_MS = Number(env("MAX_WAIT_MS", "48000")); // must stay under the Tavus tool timeout (55 s)

const PORTALS = {
  admin: { name: "Admin Portal", url: env("ADMIN_URL", "https://demoadmin.gamasuite.com/"), user: env("ADMIN_USER"), pass: env("ADMIN_PASS") },
  crm: { name: "CRM Portal", url: env("CRM_URL", "https://demoadmin.gamasuite.com:8015/"), user: env("CRM_USER"), pass: env("CRM_PASS") },
  customer: { name: "Customer Portal", url: env("CUSTOMER_URL", "https://demoportal.gamasuite.com/"), user: env("CUSTOMER_USER"), pass: env("CUSTOMER_PASS") },
};

// ---------------- state ----------------
const state = {
  stagehand: null,
  sessionId: null,
  liveViewUrl: null,
  loggedIn: {},
  portal: null,
  busy: false,
  stopRequested: false,
  current: null, // { id, instruction, status, summary, startedAt, finishedAt }
  steps: [], // { t, text, kind }
  log: [],
};
const log = (text) => {
  const line = `${new Date().toISOString().slice(11, 19)}  ${text}`;
  state.log.push(line);
  if (state.log.length > 300) state.log.shift();
  console.log(line);
};
const step = (text, kind = "doing") => {
  state.steps.push({ t: Date.now(), text, kind });
  if (state.steps.length > 40) state.steps.shift();
};

// ---------------- browser ----------------
async function ensureBrowser() {
  if (state.stagehand) return state.stagehand;
  log("starting cloud browser");
  const sh = new Stagehand({
    env: "BROWSERBASE",
    apiKey: BB_API_KEY,
    projectId: BB_PROJECT_ID,
    modelName: MODEL,
    modelClientOptions: { apiKey: MODEL_API_KEY },
    verbose: 1,
    logger: (l) => {
      const msg = l?.message || "";
      if (/act|click|fill|type|navigat|select/i.test(msg)) step(msg.slice(0, 120), "detail");
    },
    browserbaseSessionCreateParams: {
      projectId: BB_PROJECT_ID,
      keepAlive: true,
      timeout: 3600,
      browserSettings: { viewport: { width: 1440, height: 860 } },
    },
  });
  await sh.init();
  state.stagehand = sh;
  state.sessionId = sh.browserbaseSessionID;
  try {
    const bb = new Browserbase({ apiKey: BB_API_KEY });
    const dbg = await bb.sessions.debug(state.sessionId);
    state.liveViewUrl = dbg.debuggerFullscreenUrl;
  } catch (e) {
    log("live view url error: " + e.message);
  }
  log("browser ready, session " + state.sessionId);
  return sh;
}

async function openPortal(key) {
  const p = PORTALS[key];
  if (!p) throw new Error("unknown portal " + key);
  const sh = await ensureBrowser();
  const page = sh.page;
  step(`Opening the ${p.name}`);
  await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  const hasPassword = await page.locator('input[type="password"]').count();
  if (hasPassword && p.user && p.pass) {
    step(`Logging in to the ${p.name}`);
    await page.act({ action: "type %username% into the username or email field", variables: { username: p.user } });
    await page.act({ action: "type %password% into the password field", variables: { password: p.pass } });
    await page.act("click the login or sign in button");
    await page.waitForTimeout(4000);
  }
  state.loggedIn[key] = true;
  state.portal = key;
}

function agentInstruction(portalKey, instruction, data) {
  const p = PORTALS[portalKey];
  const values = data && Object.keys(data).length ? "\nValues to use exactly as given: " + JSON.stringify(data) : "";
  return [
    `You are operating the GAMA Suite ${p.name}, a freight forwarding system, in a live demo watched by customers.`,
    `Task: ${instruction}${values}`,
    "Rules: use exactly the values given, spelled as given. For autocomplete fields (customer, country, port, city), type the value, wait for the suggestion list and click the best match.",
    "Do not click Submit, Save, Book or Delete unless the task explicitly asks for it. Do not log out. Work quickly and stop as soon as the task is done.",
  ].join("\n");
}

async function runInstruction({ portal = "admin", instruction, data }) {
  const id = crypto.randomUUID();
  state.busy = true;
  state.stopRequested = false;
  state.current = { id, instruction, status: "running", summary: "", startedAt: Date.now() };
  step(`Instruction: ${instruction}`, "instruction");
  log(`run [${portal}] ${instruction} ${data ? JSON.stringify(data) : ""}`);
  try {
    if (state.portal !== portal || !state.loggedIn[portal]) await openPortal(portal);
    if (state.stopRequested) throw new Error("stopped");
    const agent = state.stagehand.agent();
    const res = await agent.execute({ instruction: agentInstruction(portal, instruction, data), maxSteps: 20 });
    const msg = (res && (res.message || res.completed)) ? String(res.message || "Done") : "Done";
    state.current.status = state.stopRequested ? "stopped" : "done";
    state.current.summary = msg.slice(0, 400);
    step(state.current.status === "done" ? "Done" : "Stopped", state.current.status);
  } catch (e) {
    state.current.status = state.stopRequested ? "stopped" : "error";
    state.current.summary = state.stopRequested ? "Stopped as requested." : "I could not finish: " + e.message.slice(0, 200);
    step(state.current.summary, state.current.status);
    log("error: " + e.message);
  } finally {
    state.current.finishedAt = Date.now();
    state.busy = false;
  }
  return state.current;
}

// ---------------- Tavus helpers ----------------
async function tavus(path, method = "GET", body) {
  const r = await fetch("https://tavusapi.com" + path, {
    method,
    headers: { "x-api-key": TAVUS_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(`Tavus ${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return json;
}
async function tellNova(conversationId, text) {
  if (!conversationId || !TAVUS_API_KEY) return;
  try {
    await tavus(`/v2/conversations/${conversationId}/send-app-message`, "POST", {
      message_type: "conversation",
      event_type: "conversation.respond",
      properties: { text: `[system update, tell the participants briefly] ${text}` },
    });
  } catch (e) {
    log("send-app-message failed: " + e.message);
  }
}

// ---------------- HTTP ----------------
const app = express();
app.use("/v1/tavus", express.raw({ type: "*/*", limit: "1mb" }));
app.use(express.json());

function verifyTavus(req) {
  if (!TOOL_SECRET) return true; // allowed only while testing without HMAC
  const sig = req.get("X-Tavus-Signature") || "";
  const mac = crypto.createHmac("sha256", TOOL_SECRET).update(req.body).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac)); } catch { return false; }
}
function parseTool(req) {
  const body = JSON.parse(req.body.toString("utf8") || "{}");
  let args = body.arguments ?? {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
  return { body, args };
}
function requireAdmin(req, res, next) {
  const t = req.get("x-admin-token") || req.query.token;
  if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) return res.status(401).json({ error: "admin token required" });
  next();
}

// Tool: gama_do
app.post("/v1/tavus/do", async (req, res) => {
  if (!verifyTavus(req)) return res.status(401).json({ error: "bad signature" });
  const { body, args } = parseTool(req);
  if (state.busy) return res.json({ status: "busy", summary: "I am still finishing the previous action." });
  const job = runInstruction({ portal: args.portal || "admin", instruction: args.instruction || "", data: args.data });
  const timer = new Promise((r) => setTimeout(() => r(null), MAX_WAIT_MS));
  const done = await Promise.race([job, timer]);
  if (done) return res.json({ status: done.status, summary: done.summary });
  job.then((d) => tellNova(body.conversation_id, d.status === "done" ? `The live action is finished: ${d.summary}` : d.summary));
  res.json({ status: "running", summary: "It is taking a little longer; the screen shows the progress. I will say when it is done." });
});

// Tool: gama_stop
app.post("/v1/tavus/stop", async (req, res) => {
  if (!verifyTavus(req)) return res.status(401).json({ error: "bad signature" });
  state.stopRequested = true;
  step("Stop requested", "stopped");
  log("stop requested");
  res.json({ status: "stopped", summary: "Stopped." });
});

// Tool: gama_status
app.post("/v1/tavus/status", async (req, res) => {
  if (!verifyTavus(req)) return res.status(401).json({ error: "bad signature" });
  const c = state.current;
  res.json(c ? { status: c.status, summary: c.summary || "Working on it." } : { status: "idle", summary: "Nothing is running." });
});

// Tavus webhooks (transcript, recording, perception)
app.post("/v1/tavus/events", (req, res) => {
  try { const b = JSON.parse(req.body.toString("utf8")); log("webhook " + (b.event_type || "?")); } catch {}
  res.json({ ok: true });
});

// Live Workspace data
app.get("/v1/workspace/current", (req, res) => {
  res.json({
    liveViewUrl: state.liveViewUrl,
    portal: state.portal ? PORTALS[state.portal].name : null,
    current: state.current,
    steps: state.steps.slice(-12),
  });
});

// Console actions
app.post("/v1/console/start", requireAdmin, async (req, res) => {
  try { await openPortal(req.body?.portal || "admin"); res.json({ ok: true, liveViewUrl: state.liveViewUrl }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/v1/console/run", requireAdmin, async (req, res) => {
  if (state.busy) return res.status(409).json({ error: "busy" });
  const d = await runInstruction(req.body || {});
  res.json(d);
});
app.post("/v1/console/stop", requireAdmin, (req, res) => { state.stopRequested = true; res.json({ ok: true }); });
app.post("/v1/console/end", requireAdmin, async (req, res) => {
  try { await state.stagehand?.close(); } catch {}
  Object.assign(state, { stagehand: null, sessionId: null, liveViewUrl: null, loggedIn: {}, portal: null, busy: false });
  log("browser closed");
  res.json({ ok: true });
});
app.get("/v1/console/log", requireAdmin, (req, res) => res.json({ log: state.log.slice(-80) }));

// One-time setup: create the Tavus tools and attach them to Nova
app.post("/setup", requireAdmin, async (req, res) => {
  try {
    if (!PUBLIC_URL) throw new Error("PUBLIC_URL is not set");
    const api = (path, timeout) => ({ api: { url: PUBLIC_URL + path, method: "POST", timeout, ...(TOOL_SECRET ? { auth: { type: "hmac", secret: TOOL_SECRET } } : {}) } });
    const defs = [
      {
        name: "gama_do",
        description: "Perform an action live in the GAMA Suite portals exactly as the participant asked, with the exact data they gave (customer, origin, destination, mode, cargo, dates). Use for any request to open, create, fill, search, edit or show something in the Admin Portal, CRM or Customer Portal. Never claim an action is done until this tool returns.",
        parameters: {
          type: "object",
          properties: {
            portal: { type: "string", enum: ["admin", "crm", "customer"], description: "Which portal. Default admin." },
            instruction: { type: "string", description: "The request in plain English, including every value exactly as spoken." },
            data: { type: "object", description: "Key values given, for example origin, destination, mode, customer." },
          },
          required: ["instruction"],
        },
        origin: "llm",
        on_call: "static_filler",
        static_filler: "On it, doing that live now.",
        on_resolve: "generate_response",
        delivery: api("/v1/tavus/do", 55),
      },
      {
        name: "gama_stop",
        description: "Stop the live portal action immediately when anyone says stop, wait or hold on.",
        parameters: { type: "object", properties: {} },
        origin: "llm",
        on_call: "silent",
        on_resolve: "response_in_result",
        delivery: api("/v1/tavus/stop", 5),
      },
      {
        name: "gama_status",
        description: "Check the progress of a live portal action that is still running.",
        parameters: { type: "object", properties: {} },
        origin: "llm",
        on_call: "generate_filler",
        on_resolve: "generate_response",
        delivery: api("/v1/tavus/status", 10),
      },
    ];
    const ids = [];
    for (const d of defs) {
      try {
        const t = await tavus("/v2/tools", "POST", d);
        ids.push(t.tool_id || t.data?.tool_id || t.id);
      } catch (e) {
        if (!/409/.test(e.message)) throw e;
        const list = await tavus("/v2/tools");
        const found = (list.data || list.tools || []).find((x) => x.name === d.name);
        if (found) ids.push(found.tool_id);
      }
    }
    const attached = await tavus(`/v2/pals/${TAVUS_PAL_ID}/tools`, "POST", { tool_ids: ids.filter(Boolean) });
    res.json({ ok: true, tool_ids: ids, attached: (attached.data || []).map((t) => t.name) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(new URL("./public", import.meta.url).pathname));
app.get("/", (req, res) => res.redirect("/console.html"));
app.get("/workspace", (req, res) => res.sendFile(new URL("./public/workspace.html", import.meta.url).pathname));
app.get("/health", (req, res) => res.json({ ok: true, browser: !!state.stagehand, busy: state.busy }));

app.listen(PORT, () => log(`Nova Live Operator listening on ${PORT}`));
