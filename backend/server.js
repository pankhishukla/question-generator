// Minimal backend: serves the frontend and proxies quiz generation to a local Ollama.
// No dependencies — requires Node 18+.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.MODEL || "llama3.1";
const FRONTEND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../frontend");

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

// JSON schema passed to Ollama so the model must return well-formed output.
const QUIZ_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          solution: { type: "string" },
        },
        required: ["question", "solution"],
      },
    },
  },
  required: ["questions"],
};

// Random formats nudge the model toward a different mix of questions on every set.
const FORMATS = [
  "a definition or recall question", "a real-world application scenario", "a numerical or calculation problem",
  "a compare-and-contrast question", "a 'why does this happen' reasoning question", "a common-misconception question",
  "a multi-step problem", "a cause-and-effect question", "a data or diagram interpretation question",
  "a predict-the-outcome question", "an error-spotting question", "a historical or conceptual-origin question",
];

function pickFormats(n) {
  return [...FORMATS].sort(() => Math.random() - 0.5).slice(0, n);
}

const DIFFICULTY = {
  easy: "All questions should be easy: basic recall and simple, single-step problems for a beginner.",
  medium: "All questions should be medium difficulty: require understanding and applying concepts, a few steps each.",
  hard: "All questions should be hard: challenging multi-step problems that need deep understanding.",
  mixed: "Make them progressively harder, from easy (question 1) to hard (question 5).",
};

function buildPrompt(topic, previous, difficulty) {
  const formats = pickFormats(5).map((f, i) => `${i + 1}. ${f}`).join("\n");
  let prompt =
    `Create exactly 5 practice questions about: "${topic}".\n` +
    `Use these formats, in order:\n${formats}\n` +
    `${DIFFICULTY[difficulty] ?? DIFFICULTY.mixed}\nFor each question give a clear, step-by-step solution.\n` +
    `Use plain text (no LaTeX).`;
  if (previous.length) {
    prompt +=
      `\n\nThe student has already seen the questions below. Your 5 questions must be ` +
      `completely different — different scenarios, numbers and sub-topics:\n` +
      previous.map((q, i) => `${i + 1}. ${q}`).join("\n");
  }
  return prompt;
}

// Pulls complete {...} objects out of the partially streamed JSON, as they finish.
function makeQuestionExtractor(onQuestion) {
  let buf = "", pos = 0, depth = 0, start = -1, inStr = false, esc = false;
  return (chunk) => {
    buf += chunk;
    for (; pos < buf.length; pos++) {
      const c = buf[pos];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") { if (++depth === 2) start = pos; }
      else if (c === "}" && depth-- === 2) {
        try { onQuestion(JSON.parse(buf.slice(start, pos + 1))); } catch {}
      }
    }
  };
}

// Streams from Ollama, calling onQuestion for each finished question and onTokens for progress.
async function generate(topic, previous, difficulty, onQuestion, onTokens) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      format: QUIZ_SCHEMA,
      options: { temperature: 0.9, seed: Math.floor(Math.random() * 1e9) },
      messages: [
        { role: "system", content: "You are a teacher who writes practice problems with worked solutions." },
        { role: "user", content: buildPrompt(topic, previous, difficulty) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);

  let count = 0;
  const extract = makeQuestionExtractor((q) => {
    if (count < 5 && q.question && q.solution) onQuestion(q, ++count);
  });
  const decoder = new TextDecoder();
  let pending = "", tokens = 0;
  for await (const part of res.body) {
    pending += decoder.decode(part, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const piece = JSON.parse(line).message?.content ?? "";
      if (piece) { extract(piece); onTokens(++tokens); }
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function friendlyError(err) {
  return err.cause?.code === "ECONNREFUSED" ? "Ollama isn't running. Start it with `ollama serve`." : err.message;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/generate") {
      const { topic, previous = [], difficulty = "mixed" } = JSON.parse(await readBody(req));
      if (!topic || !topic.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Please enter a topic." }));
      }
      // Newline-delimited JSON events: status, question, done.
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      const send = (event) => res.write(JSON.stringify(event) + "\n");
      let lastTick = 0;
      send({ type: "status", message: `Asking ${MODEL}…` });
      try {
        await generate(
          topic.trim().slice(0, 200),
          previous.slice(-30),
          difficulty,
          (q, n) => send({ type: "question", n, ...q }),
          (tokens) => {
            if (Date.now() - lastTick > 500) { lastTick = Date.now(); send({ type: "tokens", tokens }); }
          },
        );
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: friendlyError(err) });
      }
      return res.end();
    }

    // Static files
    const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = path.join(FRONTEND_DIR, path.normalize(urlPath));
    if (!file.startsWith(FRONTEND_DIR)) {
      res.writeHead(403);
      return res.end();
    }
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(content);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: friendlyError(err) }));
  }
});

server.listen(PORT, () => console.log(`Quiz generator running at http://localhost:${PORT} (model: ${MODEL})`));
