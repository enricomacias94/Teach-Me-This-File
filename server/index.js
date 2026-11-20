/**
 * Teach Me This File — Express server
 *
 * Responsibilities for this step:
 * - Accept PDFs on POST /api/document and return per-page text excerpts
 * - Build a lesson plan on POST /api/lesson via OpenAI (key in request header)
 * - Drive the student tutor on POST /api/tutor with { reply, advance }
 * - In production, serve the React build from client/dist
 */

import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import multer from "multer";
import { extractTextExcerptsFromPdf } from "./extractPdfText.js";
import {
  buildLessonPlan,
  OPENAI_LESSON_MODEL,
} from "./buildLessonPlan.js";
import { streamTutorTurn } from "./tutorTurn.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_PDF_BYTES = 5 * 1024 * 1024; // 5 MB

// In development the React app runs on another port (Vite), so we allow CORS.
// In production everything is served from this same origin — CORS is unused then.
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Keep the PDF in memory — we only need the bytes for text extraction.
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter(_req, file, acceptFile) {
    const isPdfMime = file.mimetype === "application/pdf";
    const isPdfName = file.originalname.toLowerCase().endsWith(".pdf");
    if (isPdfMime || isPdfName) {
      acceptFile(null, true);
      return;
    }
    acceptFile(new Error("Only PDF files are accepted."));
  },
});

// --- In-memory course store (enough until a database is added) ---
let preparedCourse = {
  title: "",
  fileName: "",
  fileContent: "",
  tutorLanguage: "English",
  preparedAt: null,
};

/**
 * Health check — useful to verify the API is reachable through the Vite proxy.
 */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "Teach Me This File API is running" });
});

/**
 * Accept a PDF (max 5 MB), extract text per page, return excerpts.
 * Field name expected by multer: "document"
 */
app.post("/api/document", (req, res) => {
  pdfUpload.single("document")(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError) {
        if (uploadError.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({
            error: "PDF is too large. Maximum size is 5 MB.",
          });
        }
        return res.status(400).json({ error: uploadError.message });
      }
      return res.status(400).json({ error: uploadError.message });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "No PDF file was uploaded. Use form field name \"document\".",
      });
    }

    try {
      const excerpts = await extractTextExcerptsFromPdf(req.file.buffer);

      if (excerpts.length === 0) {
        return res.status(422).json({
          error:
            "This PDF has no extractable text. It may be scanned images only, or the text layer is empty.",
        });
      }

      return res.json({
        ok: true,
        fileName: req.file.originalname,
        excerptCount: excerpts.length,
        excerpts,
      });
    } catch (_error) {
      return res.status(422).json({
        error:
          "Could not read this PDF. The file may be damaged, encrypted, or not a valid PDF.",
      });
    }
  });
});

/**
 * Build a lesson plan from document excerpts + teacher brief.
 * OpenAI key arrives in header x-openai-api-key — never stored or logged.
 * Body: { excerpts, teacherBrief, tutorLanguage? }
 */
app.post("/api/lesson", async (req, res) => {
  const openAiApiKey = req.header("x-openai-api-key");
  if (!openAiApiKey || !openAiApiKey.trim()) {
    return res.status(401).json({
      error:
        'Missing OpenAI API key. Send it in the "x-openai-api-key" header.',
    });
  }

  const { excerpts, teacherBrief, tutorLanguage } = req.body || {};

  if (!Array.isArray(excerpts) || excerpts.length === 0) {
    return res.status(400).json({
      error: "excerpts must be a non-empty array from /api/document.",
    });
  }

  for (const excerpt of excerpts) {
    if (
      !excerpt ||
      typeof excerpt.id !== "string" ||
      typeof excerpt.text !== "string"
    ) {
      return res.status(400).json({
        error: "Each excerpt must include string fields id and text.",
      });
    }
  }

  if (!teacherBrief || typeof teacherBrief !== "string" || !teacherBrief.trim()) {
    return res.status(400).json({
      error: "teacherBrief is required (the teacher's instructions).",
    });
  }

  try {
    const result = await buildLessonPlan({
      excerpts,
      teacherBrief: teacherBrief.trim(),
      tutorLanguage,
      openAiApiKey: openAiApiKey.trim(),
      model: OPENAI_LESSON_MODEL,
    });

    return res.json({
      ok: true,
      model: result.model,
      lessonPlan: result.lessonPlan,
    });
  } catch (error) {
    // error.message is safe — we never put the API key into thrown errors.
    return res.status(422).json({
      error: error.message || "Could not build the lesson plan.",
    });
  }
});

/**
 * One tutor chat turn for the active lesson step (NDJSON stream).
 * Header: x-openai-api-key (never stored or logged).
 * Body: { mode: "open"|"reply", teacherBrief, tutorLanguage, step,
 *         stepExcerpts, recentMessages, studentMessage? }
 * Events: { type:"delta", text } … then
 *         { type:"done", advance, model, usedExcerptIds }
 */
app.post("/api/tutor", async (req, res) => {
  const openAiApiKey = req.header("x-openai-api-key");
  if (!openAiApiKey || !openAiApiKey.trim()) {
    return res.status(401).json({
      error:
        'Missing OpenAI API key. Send it in the "x-openai-api-key" header.',
    });
  }

  const {
    mode,
    teacherBrief,
    tutorLanguage,
    step,
    stepExcerpts,
    recentMessages,
    studentMessage,
    hasMoreSteps,
  } = req.body || {};

  if (mode !== "open" && mode !== "reply") {
    return res.status(400).json({
      error: 'mode must be "open" or "reply".',
    });
  }

  if (!teacherBrief || typeof teacherBrief !== "string") {
    return res.status(400).json({
      error: "teacherBrief is required.",
    });
  }

  if (!step || typeof step !== "object") {
    return res.status(400).json({
      error: "step is required (title, objective, comprehensionCriterion).",
    });
  }

  if (mode === "reply") {
    if (!studentMessage || typeof studentMessage !== "string") {
      return res.status(400).json({
        error: "studentMessage is required when mode is \"reply\".",
      });
    }
  }

  // Abort OpenAI when the response socket closes early (Stop / disconnect).
  // Listen on `res`, not `req` — `req` "close" fires when the body finishes parsing.
  const abortController = new AbortController();
  const abortFromClient = () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  };

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  res.on("close", abortFromClient);

  const writeEvent = (event) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  try {
    await streamTutorTurn({
      mode,
      teacherBrief: teacherBrief.trim(),
      tutorLanguage,
      step,
      stepExcerpts: Array.isArray(stepExcerpts) ? stepExcerpts : [],
      recentMessages: Array.isArray(recentMessages) ? recentMessages : [],
      studentMessage:
        typeof studentMessage === "string" ? studentMessage : "",
      // false on the last step so the tutor closes the PDF lesson (no new question).
      hasMoreSteps: hasMoreSteps !== false,
      openAiApiKey: openAiApiKey.trim(),
      model: OPENAI_LESSON_MODEL,
      signal: abortController.signal,
      onDelta: (text) => writeEvent({ type: "delta", text }),
      onDone: ({ advance, model, usedExcerptIds }) =>
        writeEvent({
          type: "done",
          advance,
          model,
          usedExcerptIds: usedExcerptIds || [],
        }),
    });

    if (!res.writableEnded) {
      res.end();
    }
  } catch (error) {
    if (error?.name === "AbortError" || abortController.signal.aborted) {
      // Client stopped or disconnected — no done event, so React will not advance.
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    if (!res.headersSent) {
      return res.status(422).json({
        error: error.message || "Could not run the tutor turn.",
      });
    }

    writeEvent({
      type: "error",
      error: error.message || "Could not run the tutor turn.",
    });
    if (!res.writableEnded) {
      res.end();
    }
  } finally {
    res.off("close", abortFromClient);
  }
});

/**
 * Save the course prepared by the teacher.
 * tutorLanguage controls the language the tutor should use (default English).
 */
app.post("/api/course", (req, res) => {
  const { title, fileName, fileContent, tutorLanguage } = req.body;

  if (!fileContent || typeof fileContent !== "string") {
    return res.status(400).json({
      error: "File content is required.",
    });
  }

  const language =
    typeof tutorLanguage === "string" && tutorLanguage.trim()
      ? tutorLanguage.trim()
      : "English";

  preparedCourse = {
    title: title?.trim() || "Untitled course",
    fileName: fileName?.trim() || "file.txt",
    fileContent,
    tutorLanguage: language,
    preparedAt: new Date().toISOString(),
  };

  res.json({
    ok: true,
    course: {
      title: preparedCourse.title,
      fileName: preparedCourse.fileName,
      tutorLanguage: preparedCourse.tutorLanguage,
      preparedAt: preparedCourse.preparedAt,
      // We do not echo the full content back — the client already has it.
      contentLength: preparedCourse.fileContent.length,
    },
  });
});

/**
 * Return the currently prepared course (metadata + content for the chat screen).
 */
app.get("/api/course", (_req, res) => {
  if (!preparedCourse.preparedAt) {
    return res.status(404).json({
      error: "No course has been prepared yet.",
    });
  }

  res.json({ course: preparedCourse });
});

/**
 * Build a short stub reply in the teacher's chosen language.
 * OpenAI will replace this; for now we cover a few common languages.
 */
function buildStubTutorReply(course) {
  const language = course.tutorLanguage || "English";
  const title = course.title;

  if (language === "French") {
    return (
      `Je suis prêt à t'aider avec « ${title} ». ` +
      `Je répondrai en français. L'intégration OpenAI arrivera bientôt — ceci est une réponse factice.`
    );
  }

  if (language === "Spanish") {
    return (
      `Estoy listo para ayudarte con « ${title} ». ` +
      `Responderé en español. La integración con OpenAI llegará pronto — esta es una respuesta provisional.`
    );
  }

  if (language === "German") {
    return (
      `Ich helfe dir gerne bei „${title}“. ` +
      `Ich antworte auf Deutsch. Die OpenAI-Anbindung kommt als Nächstes — dies ist eine Platzhalterantwort.`
    );
  }

  // Default: English (also used for any other custom language label for now).
  if (language !== "English") {
    return (
      `I'm ready to help you with "${title}". ` +
      `When AI is connected I will reply in ${language}. ` +
      `For now this is a placeholder reply in English.`
    );
  }

  return (
    `I'm ready to help you with "${title}". ` +
    `OpenAI integration comes next — for now this is a placeholder reply.`
  );
}

/**
 * Student chat stub.
 * The tutor replies in the language chosen by the teacher (English by default).
 */
app.post("/api/chat", (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "A message is required." });
  }

  if (!preparedCourse.preparedAt) {
    return res.status(400).json({
      error: "Prepare a course before starting the chat.",
    });
  }

  res.json({
    reply: buildStubTutorReply(preparedCourse),
  });
});

/**
 * Production: serve the Vite build as static files, then fall back to index.html
 * so React Router can handle client-side routes.
 */
const clientDistPath = path.join(__dirname, "..", "client", "dist");

app.use(express.static(clientDistPath));

app.get("*", (req, res, next) => {
  // Leave /api unmatched routes to Express's default 404.
  if (req.path.startsWith("/api")) {
    return next();
  }

  res.sendFile(path.join(clientDistPath, "index.html"), (err) => {
    if (err) {
      // Happens in development when client/dist does not exist yet.
      res
        .status(404)
        .send(
          "React build not found. Run `npm run build` at the project root, or use `npm run dev` for development."
        );
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
