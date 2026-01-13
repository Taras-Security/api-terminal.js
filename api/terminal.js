// api/terminal.js
// Vercel Serverless Function (Node 18+)

const OPENAI_URL = "https://api.openai.com/v1/responses";

// ---- super simple in-memory rate limit (best-effort on serverless) ----
const getStore = () => {
  if (!globalThis.__PSYOP_RL__) globalThis.__PSYOP_RL__ = new Map();
  return globalThis.__PSYOP_RL__;
};

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function parseAllowedOrigins() {
  const raw = (process.env.ALLOWED_ORIGINS || "").trim();
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowList = parseAllowedOrigins();

  // If no allowlist set, reflect origin (works for Framer) or fall back to "*"
  let allowOrigin = "*";
  if (allowList.length > 0) {
    allowOrigin = allowList.includes(origin) ? origin : allowList[0];
  } else if (origin) {
    allowOrigin = origin;
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function buildPrompt({ text, mode, tone }) {
  const persona = [
    "You are **PSYOPANIME AI TERMINAL**.",
    "Your job: turn user input into anime-flavored intelligence-style output.",
    "Style rules:",
    "- Keep it themed (anime ops vibe), but do NOT invent concrete facts.",
    "- If info is missing, say 'UNKNOWN' or 'UNCONFIRMED'.",
    "- No calls to violence, no hate, no targeted persuasion. Keep it neutral.",
    "- Be concise and structured. No rambling.",
  ].join("\n");

  const toneMap = {
    CINEMATIC: "Cinematic, high-stakes, dramatic but still clear.",
    SERIOUS: "Straight serious analyst tone. Minimal flair.",
    UNHINGED: "Chaotic anime terminal energy, but still readable + structured.",
  };

  const modeBlocks = {
    OPS_BRIEF: [
      "Return exactly these sections:",
      "TITLE:",
      "SUMMARY: (2–4 lines)",
      "KEY FACTS: (bullets, mark unknowns)",
      "RISK / ANGLE: (bullets)",
      "NEXT ACTION: (bullets, neutral)",
    ].join("\n"),
    EPISODE_OUTLINE: [
      "Return exactly these sections:",
      "EPISODE TITLE:",
      "COLD OPEN: (2–4 lines)",
      "SCENES: (5–9 numbered beats)",
      "TWIST:",
      "CLIFFHANGER:",
    ].join("\n"),
    POST_KIT: [
      "Return exactly these sections:",
      "X POST: (<= 280 chars, no hashtags unless user asked)",
      "ALT POSTS: (2 variants, <= 200 chars each)",
      "HOOKS: (5 bullets)",
      "SAFE DISCLAIMERS: (1–2 short lines if topic is sensitive)",
    ].join("\n"),
  };

  return [
    persona,
    "",
    `TONE: ${tone} — ${toneMap[tone] || toneMap.CINEMATIC}`,
    `MODE: ${mode}`,
    modeBlocks[mode] || modeBlocks.OPS_BRIEF,
    "",
    "USER INPUT:",
    text,
  ].join("\n");
}

export default async function handler(req, res) {
  setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // Helpful GET so you stop confusing yourself with “method not allowed”
  if (req.method === "GET") {
    return json(res, 200, {
      ok: true,
      message: "Endpoint is up. Use POST with JSON: { text, mode, tone }",
      example: { text: "hello", mode: "OPS_BRIEF", tone: "CINEMATIC" },
    });
  }

  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  // Rate limit (10 req/min per IP)
  const ip = getClientIp(req);
  const store = getStore();
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 10;

  const rec = store.get(ip) || { start: now, count: 0 };
  if (now - rec.start > windowMs) {
    rec.start = now;
    rec.count = 0;
  }
  rec.count += 1;
  store.set(ip, rec);

  if (rec.count > limit) {
    const retry = Math.ceil((rec.start + windowMs - now) / 1000);
    return json(res, 429, { ok: false, error: "Rate limited", retry_after_seconds: retry });
  }

  try {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return json(res, 500, { ok: false, error: "Missing OPENAI_API_KEY env var" });

    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = String(body.text || "").trim();
    const mode = String(body.mode || "OPS_BRIEF").trim();
    const tone = String(body.tone || "CINEMATIC").trim();

    if (!text) return json(res, 400, { ok: false, error: "Missing text" });

    const model = (process.env.OPENAI_MODEL || "gpt-5.2").trim();
    const input = buildPrompt({ text, mode, tone });

    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
      }),
    });

    const raw = await r.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}

    if (!r.ok) {
      const msg =
        data?.error?.message ||
        data?.error ||
        data?.message ||
        raw ||
        `OpenAI error (${r.status})`;
      return json(res, r.status, { ok: false, error: msg });
    }

    const out = String(data?.output_text || "").trim();
    return json(res, 200, { ok: true, result: out });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
}
