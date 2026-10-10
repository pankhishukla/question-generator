const form = document.getElementById("form");
const topicInput = document.getElementById("topic");
const difficultyEl = document.getElementById("difficulty");
const generateBtn = document.getElementById("generate");
const moreBtn = document.getElementById("more");
const statusEl = document.getElementById("status");
const list = document.getElementById("questions");
const progress = document.getElementById("progress");
const bar = document.getElementById("bar");

let currentTopic = "";
let seen = []; // every question shown for the current topic, sent back so new sets don't repeat

function addQuestion({ question, solution }) {
  const li = document.createElement("li");
  const q = document.createElement("div");
  q.className = "q";
  q.textContent = question;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Show solution";
  const sol = document.createElement("div");
  sol.className = "sol";
  sol.textContent = solution;
  details.append(summary, sol);
  details.addEventListener("toggle", () => {
    summary.textContent = details.open ? "Hide solution" : "Show solution";
  });
  li.append(q, details);
  list.append(li);
  seen.push(question);
}

function setProgress(done, message) {
  progress.hidden = false;
  bar.style.width = `${(done / 5) * 100}%`;
  statusEl.textContent = message;
}

async function load(topic) {
  generateBtn.disabled = moreBtn.disabled = true;
  moreBtn.hidden = true;
  statusEl.className = "";
  list.innerHTML = "";
  let done = 0;
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  setProgress(0, "Starting…");
  const timer = setInterval(() => {
    if (done < 5) statusEl.textContent = `Writing question ${done + 1} of 5… (${elapsed()})`;
  }, 1000);

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, previous: seen, difficulty: difficultyEl.value }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Something went wrong.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const ev = JSON.parse(line);
        if (ev.type === "question") {
          addQuestion(ev);
          done = ev.n;
          setProgress(done, done < 5 ? `Question ${done} of 5 ready — writing the next… (${elapsed()})` : "");
        } else if (ev.type === "status") {
          setProgress(done, ev.message);
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
    }
    if (done === 0) throw new Error("The model returned no questions. Try again.");
    statusEl.textContent = `Done — ${done} questions in ${elapsed()}.`;
    moreBtn.hidden = false;
  } catch (err) {
    statusEl.className = "error";
    statusEl.textContent = err.message;
    if (done > 0) moreBtn.hidden = false;
  } finally {
    clearInterval(timer);
    progress.hidden = true;
    generateBtn.disabled = moreBtn.disabled = false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const topic = topicInput.value.trim();
  if (topic.toLowerCase() !== currentTopic.toLowerCase()) seen = [];
  currentTopic = topic;
  load(topic);
});

moreBtn.addEventListener("click", () => load(currentTopic));
