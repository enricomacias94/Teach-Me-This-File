import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createLessonPlan,
  resolveOpenAiApiKeyForRequest,
  uploadDocument,
} from "../api.js";
import { useLesson } from "../lessonContext.jsx";

const TUTOR_LANGUAGES = ["English", "French", "Spanish", "German"];

/**
 * Screen 1 — teacher picks a PDF, brief, language, and API key,
 * then Start Lesson runs /api/document → /api/lesson.
 */
function PrepareCoursePage() {
  const navigate = useNavigate();
  const { openAiApiKey, setOpenAiApiKey, startActiveLesson } = useLesson();

  const [courseTitle, setCourseTitle] = useState("");
  const [teacherBrief, setTeacherBrief] = useState("");
  const [tutorLanguage, setTutorLanguage] = useState("English");
  const [pdfFile, setPdfFile] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isStartingLesson, setIsStartingLesson] = useState(false);

  function handlePdfChange(event) {
    const file = event.target.files?.[0] || null;
    setPdfFile(file);
    setErrorMessage("");
    setStatusMessage(file ? `Selected PDF: ${file.name}` : "");
  }

  async function handleStartLesson(event) {
    event.preventDefault();
    setErrorMessage("");
    setStatusMessage("");

    if (!pdfFile) {
      setErrorMessage("Please choose a PDF file before starting the lesson.");
      return;
    }

    if (!teacherBrief.trim()) {
      setErrorMessage("Please enter the teacher brief (instructions for the lesson).");
      return;
    }

    setIsStartingLesson(true);

    try {
      // Reject "mock" outside DEV before any network call.
      const apiKeyForRequest = resolveOpenAiApiKeyForRequest(openAiApiKey);

      setStatusMessage("Uploading PDF and extracting text…");
      const documentResult = await uploadDocument(pdfFile);

      setStatusMessage("Building lesson plan…");
      const lessonResult = await createLessonPlan({
        excerpts: documentResult.excerpts,
        teacherBrief: teacherBrief.trim(),
        tutorLanguage,
        openAiApiKey: apiKeyForRequest,
      });

      const title = courseTitle.trim() || "Untitled course";

      // Keep plan + excerpts + brief/language in shared React state, then open student view.
      startActiveLesson({
        title,
        brief: teacherBrief.trim(),
        language: tutorLanguage,
        documentExcerpts: documentResult.excerpts,
        plan: lessonResult.lessonPlan,
      });

      navigate("/chat");
    } catch (error) {
      setErrorMessage(error.message || "Could not start the lesson.");
      setStatusMessage("");
    } finally {
      setIsStartingLesson(false);
    }
  }

  const canStart =
    Boolean(pdfFile) &&
    teacherBrief.trim().length > 0 &&
    openAiApiKey.trim().length > 0 &&
    !isStartingLesson;

  return (
    <section className="animate-rise space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">
          Teacher prepare
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink">
          Prepare course
        </h1>
        <p className="mt-2 max-w-2xl text-ink-soft/85">
          This is the teacher screen only: brief, API key, PDF, then Start
          Lesson. The student practice (exercise + tutor chat) opens on the
          Student lesson screen.
        </p>
      </div>

      <form
        onSubmit={handleStartLesson}
        className="space-y-5 border-t border-ink/10 pt-6"
      >
        <label className="block space-y-2">
          <span className="text-sm font-medium text-ink-soft">Course title</span>
          <input
            type="text"
            value={courseTitle}
            onChange={(event) => setCourseTitle(event.target.value)}
            placeholder="e.g. Introduction to photosynthesis"
            className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2 outline-none ring-accent focus:ring-2"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-ink-soft">
            Teacher brief
          </span>
          <textarea
            value={teacherBrief}
            onChange={(event) => setTeacherBrief(event.target.value)}
            rows={4}
            placeholder="What should the lesson focus on?"
            className="w-full resize-y rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm leading-relaxed outline-none ring-accent focus:ring-2"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-ink-soft">
            Tutor response language
          </span>
          <select
            value={tutorLanguage}
            onChange={(event) => setTutorLanguage(event.target.value)}
            className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2 outline-none ring-accent focus:ring-2"
          >
            {TUTOR_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="space-y-2 rounded-md border border-ink/10 bg-paper-deep/40 px-4 py-3">
          <legend className="px-1 text-sm font-medium text-ink-soft">
            Settings
          </legend>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-ink-soft">
              OpenAI API key
            </span>
            <input
              type="password"
              value={openAiApiKey}
              onChange={(event) => setOpenAiApiKey(event.target.value)}
              autoComplete="off"
              placeholder="sk-… (kept in memory only)"
              className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2 outline-none ring-accent focus:ring-2"
            />
            <span className="block text-xs text-ink-soft/70">
              Sent only as the x-openai-api-key header for /api/lesson and
              /api/tutor. Never stored on disk.
              {import.meta.env.DEV
                ? ' In development you may use "mock".'
                : ""}
            </span>
          </label>
        </fieldset>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-ink-soft">PDF file</span>
          <input
            type="file"
            accept=".pdf,application/pdf"
            onChange={handlePdfChange}
            disabled={isStartingLesson}
            className="block w-full text-sm text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-mist file:px-3 file:py-2 file:font-medium file:text-ink hover:file:bg-accent hover:file:text-paper"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!canStart}
            className="rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-paper transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStartingLesson ? "Starting lesson…" : "Start Lesson"}
          </button>
        </div>
      </form>

      {statusMessage && (
        <p className="text-sm text-accent" role="status">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p className="text-sm text-red-700" role="alert">
          {errorMessage}
        </p>
      )}
    </section>
  );
}

export default PrepareCoursePage;
