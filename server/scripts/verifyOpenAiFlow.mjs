/**
 * End-to-end OpenAI checks against the same APIs the UI uses.
 * Usage (PowerShell):
 *   $env:OPENAI_API_KEY = "sk-..."
 *   node server/scripts/verifyOpenAiFlow.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE || "http://localhost:3001";
const openAiApiKey = process.env.OPENAI_API_KEY;

if (!openAiApiKey) {
  console.error("Set OPENAI_API_KEY before running this script.");
  process.exit(1);
}

const pdfPath = path.join(__dirname, "..", "test-fixtures", "sample-text.pdf");

async function readNdjsonStream(response, { abortAfterDeltas = null } = {}) {
  const controller = new AbortController();
  // abortAfterDeltas uses a separate fetch abort via returned cancel — handled by caller.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltas = 0;
  let text = "";
  let doneEvent = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "delta") {
        deltas += 1;
        text += event.text;
        if (abortAfterDeltas !== null && deltas >= abortAfterDeltas) {
          return { deltas, text, doneEvent, shouldAbort: true };
        }
      } else if (event.type === "done") {
        doneEvent = event;
      } else if (event.type === "error") {
        throw new Error(event.error || "stream error");
      }
    }
  }

  return { deltas, text, doneEvent, shouldAbort: false };
}

async function tutorTurn(body, { abortAfterDeltas = null } = {}) {
  const abortController = new AbortController();
  const response = await fetch(`${API_BASE}/api/tutor`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-openai-api-key": openAiApiKey,
    },
    signal: abortController.signal,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`tutor HTTP ${response.status}: ${await response.text()}`);
  }

  if (abortAfterDeltas === null) {
    return readNdjsonStream(response);
  }

  // Abort mid-stream once enough deltas arrived.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltas = 0;
  let text = "";
  let doneEvent = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "delta") {
          deltas += 1;
          text += event.text;
          if (deltas >= abortAfterDeltas) {
            abortController.abort();
            throw Object.assign(new Error("Aborted"), { name: "AbortError" });
          }
        } else if (event.type === "done") {
          doneEvent = event;
        }
      }
    }
  } catch (error) {
    if (error.name === "AbortError") {
      return { deltas, text, doneEvent, aborted: true };
    }
    throw error;
  }

  return { deltas, text, doneEvent, aborted: false };
}

const form = new FormData();
const pdfBytes = fs.readFileSync(pdfPath);
form.append(
  "document",
  new Blob([pdfBytes], { type: "application/pdf" }),
  "sample-text.pdf"
);

const docRes = await fetch(`${API_BASE}/api/document`, {
  method: "POST",
  body: form,
});
const doc = await docRes.json();
if (!docRes.ok) throw new Error(JSON.stringify(doc));
console.log(`document ok excerpts=${doc.excerptCount}`);

const lessonRes = await fetch(`${API_BASE}/api/lesson`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-openai-api-key": openAiApiKey,
  },
  body: JSON.stringify({
    excerpts: doc.excerpts,
    teacherBrief: "Focus on photosynthesis and one supporting detail.",
    tutorLanguage: "English",
  }),
});
const lesson = await lessonRes.json();
if (!lessonRes.ok) throw new Error(JSON.stringify(lesson));
console.log(`lesson ok steps=${lesson.lessonPlan.steps.length} model=${lesson.model}`);

const step0 = lesson.lessonPlan.steps[0];
const stepExcerpts = doc.excerpts.filter((excerpt) =>
  step0.excerptIds.includes(excerpt.id)
);

const open = await tutorTurn({
  mode: "open",
  teacherBrief: "Focus on photosynthesis and one supporting detail.",
  tutorLanguage: "English",
  step: step0,
  stepExcerpts,
  recentMessages: [],
});
console.log(
  `OPEN deltas=${open.deltas} advance=${open.doneEvent?.advance} sources=${JSON.stringify(open.doneEvent?.usedExcerptIds)}`
);

const wrong = await tutorTurn({
  mode: "reply",
  teacherBrief: "Focus on photosynthesis and one supporting detail.",
  tutorLanguage: "English",
  step: step0,
  stepExcerpts,
  recentMessages: [
    { role: "tutor", text: open.text },
    { role: "student", text: "idk" },
  ],
  studentMessage: "idk",
});
console.log(
  `WRONG deltas=${wrong.deltas} advance=${wrong.doneEvent?.advance} preview=${JSON.stringify(wrong.text.slice(0, 120))}`
);

const right = await tutorTurn({
  mode: "reply",
  teacherBrief: "Focus on photosynthesis and one supporting detail.",
  tutorLanguage: "English",
  step: step0,
  stepExcerpts,
  recentMessages: [
    { role: "tutor", text: open.text },
    { role: "student", text: "idk" },
    { role: "tutor", text: wrong.text },
  ],
  studentMessage:
    "Photosynthesis turns light into energy, which plants use to live and grow.",
});
console.log(
  `RIGHT deltas=${right.deltas} advance=${right.doneEvent?.advance} sources=${JSON.stringify(right.doneEvent?.usedExcerptIds)}`
);

const sourceIds = right.doneEvent?.usedExcerptIds || [];
const sourceOk = sourceIds.every((id) =>
  doc.excerpts.some((excerpt) => excerpt.id === id)
);
console.log(`VIEW_SOURCE ids_valid=${sourceOk && sourceIds.length > 0}`);

const stopped = await tutorTurn(
  {
    mode: "reply",
    teacherBrief: "Focus on photosynthesis and one supporting detail.",
    tutorLanguage: "English",
    step: step0,
    stepExcerpts,
    recentMessages: [],
    studentMessage:
      "Photosynthesis turns light into energy, which plants use to live and grow.",
  },
  { abortAfterDeltas: 2 }
);
console.log(
  `STOP aborted=${stopped.aborted} deltas=${stopped.deltas} done=${JSON.stringify(stopped.doneEvent)} advanceApplied=${Boolean(stopped.doneEvent?.advance)}`
);

const checks = {
  wrongStays: wrong.doneEvent?.advance === false,
  rightAdvances: right.doneEvent?.advance === true,
  viewSource: sourceOk && sourceIds.length > 0,
  stopNoAdvance: stopped.aborted && !stopped.doneEvent?.advance,
};

console.log("CHECKS", checks);
if (!Object.values(checks).every(Boolean)) {
  process.exit(2);
}
console.log("ALL_OPENAI_CHECKS_PASSED");
