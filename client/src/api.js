/**
 * Thin wrappers around fetch("/api/...").
 * Relative URLs work in both modes:
 * - development: Vite proxies /api to Express
 * - production: Express serves API and React from the same origin
 */

/**
 * Read a JSON body safely.
 * Empty/cut responses (proxy reset, server restart) used to throw a cryptic
 * "Unexpected end of JSON input" — we turn those into a clear Error instead.
 */
async function readJsonBody(response, fallbackError) {
  const rawText = await response.text();
  if (!rawText.trim()) {
    throw new Error(
      fallbackError ||
        "The server returned an empty response. Wait a second and try Start Lesson again."
    );
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(
      fallbackError ||
        "The server returned an invalid response. Wait a second and try Start Lesson again."
    );
  }
}

export async function checkApiHealth() {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error("The API is not responding.");
  }
  return readJsonBody(response, "The API health check failed.");
}

/**
 * Upload a PDF to the server for per-page text extraction.
 * Field name must be "document" to match multer on the server.
 */
export async function uploadDocument(pdfFile) {
  const formData = new FormData();
  formData.append("document", pdfFile);

  const response = await fetch("/api/document", {
    method: "POST",
    body: formData,
  });

  const data = await readJsonBody(
    response,
    "Could not upload the PDF (empty server response). Try Start Lesson again."
  );
  if (!response.ok) {
    throw new Error(data.error || "Could not process the PDF.");
  }
  return data;
}

/**
 * Ask the server to build a lesson plan.
 * The OpenAI key is sent only in the header for this request.
 */
export async function createLessonPlan({
  excerpts,
  teacherBrief,
  tutorLanguage,
  openAiApiKey,
}) {
  const response = await fetch("/api/lesson", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-openai-api-key": openAiApiKey,
    },
    body: JSON.stringify({ excerpts, teacherBrief, tutorLanguage }),
  });

  const data = await readJsonBody(
    response,
    "Could not build the lesson (empty server response). Try Start Lesson again."
  );
  if (!response.ok) {
    throw new Error(data.error || "Could not create the lesson plan.");
  }
  return data;
}

/**
 * Stream one tutor turn as NDJSON: delta text chunks, then done { advance }.
 * onDelta(text) is called as soon as each piece arrives.
 * Progression must wait for the returned done payload (or null if aborted).
 */
export async function streamTutorTurn({
  mode,
  teacherBrief,
  tutorLanguage,
  step,
  stepExcerpts,
  recentMessages,
  studentMessage,
  hasMoreSteps = true,
  openAiApiKey,
  signal,
  onDelta,
}) {
  const response = await fetch("/api/tutor", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-openai-api-key": openAiApiKey,
    },
    signal,
    body: JSON.stringify({
      mode,
      teacherBrief,
      tutorLanguage,
      step,
      stepExcerpts,
      recentMessages,
      studentMessage,
      hasMoreSteps,
    }),
  });

  if (!response.ok) {
    let errorMessage = "Tutor request failed.";
    try {
      const data = await response.json();
      errorMessage = data.error || errorMessage;
    } catch {
      // Non-JSON error body — keep the default message.
    }
    throw new Error(errorMessage);
  }

  if (!response.body) {
    throw new Error("Tutor stream is empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneEvent = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (event.type === "delta" && typeof event.text === "string") {
        onDelta(event.text);
      } else if (event.type === "done") {
        doneEvent = {
          advance: Boolean(event.advance),
          model: event.model || null,
          usedExcerptIds: Array.isArray(event.usedExcerptIds)
            ? event.usedExcerptIds.filter((id) => typeof id === "string")
            : [],
        };
      } else if (event.type === "error") {
        throw new Error(event.error || "Tutor stream failed.");
      }
    }
  }

  // No done event means the stream was cut (Stop / disconnect) — do not advance.
  return doneEvent;
}

/**
 * Mock is only for local development and automated checks.
 * Production builds must use a real OpenAI key.
 */
export function resolveOpenAiApiKeyForRequest(openAiApiKey) {
  const trimmedKey = openAiApiKey.trim();
  if (!trimmedKey) {
    throw new Error("OpenAI API key is required.");
  }

  if (trimmedKey === "mock") {
    if (!import.meta.env.DEV) {
      throw new Error(
        'Mock mode is only available in development. Enter a real OpenAI API key.'
      );
    }
    return "mock";
  }

  return trimmedKey;
}

export async function saveCourse({ title, fileName, fileContent, tutorLanguage }) {
  const response = await fetch("/api/course", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, fileName, fileContent, tutorLanguage }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not save the course.");
  }
  return data;
}

export async function fetchCourse() {
  const response = await fetch("/api/course");
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "No course available.");
  }
  return data.course;
}

export async function sendChatMessage(message) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Chat request failed.");
  }
  return data.reply;
}
