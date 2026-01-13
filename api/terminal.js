export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = (process.env.ALLOWED_ORIGIN || "").trim();

  // CORS
  if (allowed && origin === allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  if (!allowed || origin !== allowed) {
    return res.status(403).json({ ok: false, error: "Origin blocked (check ALLOWED_ORIGIN)" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {}
  }

  const input = String(body?.input || "").trim();
  const mode = String(body?.mode || "ops_brief");
  const tone = String(body?.tone || "cinematic");

  if (!input) return res.status(400).json({ ok: false, error: "Empty input" });
  if (input.length > 600) return res.status(400).json({ ok: false, error: "Input too long (max 600 chars)" });

  const templates = {
    ops_brief: "Write an OPS BRIEF: Title, Situation, Key Facts (bullets), Narrative Angle, Suggested Copy, CTA.",
    episode_outline: "Write an EPISODE OUTLINE: Title, Cold Open, Beats (8-12 bullets), Cliffhanger.",
    post_kit: "Write a POST KIT: 1 main post (<=260 chars), 3 reply posts, 5 keywords/hashtags, 1 alt hook."
  };

  const toneRule =
    tone === "serious" ? "Tone: serious, clean, minimal hype."
    : tone === "unhinged" ? "Tone: unhinged, aggressive hype, still readable."
    : "Tone: cinematic, war-room, high-stakes.";

  const instructions = `You are PsyopAnime AI Terminal.\n${toneRule}\n${templates[mode] || templates.ops_brief}\nOutput only the deliverable. No preamble.`;

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      instructions,
      input,
      max_output_tokens: 650,
      temperature: tone === "serious" ? 0.35 : tone === "unhinged" ? 0.9 : 0.7,
      store: false
    }),
  });

  const data = await r.json();
  if (!r.ok) {
    return res.status(r.status).json({ ok: false, error: "OpenAI error", detail: data?.error?.message || "" });
  }

  const msg = Array.isArray(data.output) ? data.output.find((o) => o.type === "message") : null;
  const textBlock = msg?.content?.find((c) => c.type === "output_text");
  const text = (textBlock?.text || data.output_text || "").trim();

  return res.status(200).json({ ok: true, text });
}
