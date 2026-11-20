import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  resolveOpenAiApiKeyForRequest,
  streamTutorTurn,
} from "../api.js";
import { useLesson } from "../lessonContext.jsx";

/**
 * Student lesson screen.
 * Teacher prepare builds the plan; this page is where the student practices.
 * After a correct answer we pause for "Continue" instead of jumping to the next open.
 */
function StudentChatPage() {
  const {
    courseTitle,
    teacherBrief,
    tutorLanguage,
    excerpts,
    lessonPlan,
    activeStepIndex,
    lessonComplete,
    openAiApiKey,
    hasMoreStepsAfter,
    goToNextStep,
    markLessonComplete,
  } = useLesson();

  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  // After a correct mid-lesson answer, wait for the student to continue.
  const [showContinueButton, setShowContinueButton] = useState(false);
  const bottomRef = useRef(null);
  const hasOpenedRef = useRef(false);
  const openedStepRef = useRef(-1);
  const abortControllerRef = useRef(null);
  const messagesRef = useRef(messages);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const stepCount = lessonPlan?.steps?.length || 0;
  const currentStep = lessonPlan?.steps?.[activeStepIndex] || null;
  const exerciseType = lessonPlan?.exerciseType || "mixed";

  function excerptsForStep(step) {
    if (!step?.excerptIds?.length) {
      return [];
    }
    const idSet = new Set(step.excerptIds);
    return excerpts.filter((excerpt) => idSet.has(excerpt.id));
  }

  function resolveSourceExcerpts(usedExcerptIds) {
    if (!Array.isArray(usedExcerptIds) || usedExcerptIds.length === 0) {
      return [];
    }

    return usedExcerptIds
      .map((excerptId) => excerpts.find((excerpt) => excerpt.id === excerptId))
      .filter(Boolean);
  }

  function appendTutorDelta(textChunk) {
    setMessages((previous) => {
      const next = [...previous];
      const last = next[next.length - 1];
      if (last && last.role === "tutor" && last.streaming) {
        next[next.length - 1] = {
          ...last,
          text: `${last.text}${textChunk}`,
        };
        return next;
      }
      next.push({
        role: "tutor",
        text: textChunk,
        streaming: true,
        sourceExcerpts: [],
      });
      return next;
    });
  }

  function finishTutorMessage({
    stopped = false,
    usedExcerptIds = [],
  } = {}) {
    const sourceExcerpts = stopped
      ? []
      : resolveSourceExcerpts(usedExcerptIds);

    setMessages((previous) => {
      const next = [...previous];
      const last = next[next.length - 1];
      if (!last || last.role !== "tutor") {
        return previous;
      }

      let text = last.text;
      if (stopped) {
        text = text.trimEnd()
          ? `${text.trimEnd()} — Stopped`
          : "Stopped";
      }

      next[next.length - 1] = {
        role: "tutor",
        text,
        streaming: false,
        stopped,
        sourceExcerpts,
      };
      return next;
    });
  }

  async function runStreamedTutorTurn({
    mode,
    studentMessage,
    stepIndex,
    history,
  }) {
    const step = lessonPlan.steps[stepIndex];
    const apiKeyForRequest = resolveOpenAiApiKeyForRequest(openAiApiKey);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsStreaming(true);
    setErrorMessage("");

    try {
      const doneEvent = await streamTutorTurn({
        mode,
        teacherBrief,
        tutorLanguage,
        step,
        stepExcerpts: excerptsForStep(step),
        recentMessages: history,
        studentMessage,
        hasMoreSteps: hasMoreStepsAfter(stepIndex),
        openAiApiKey: apiKeyForRequest,
        signal: abortController.signal,
        onDelta: appendTutorDelta,
      });

      if (!doneEvent) {
        finishTutorMessage({ stopped: true });
        return null;
      }

      finishTutorMessage({
        stopped: false,
        usedExcerptIds: doneEvent.usedExcerptIds || [],
      });

      // Do not auto-open the next step — show Continue (or Lesson complete) instead.
      if (doneEvent.advance) {
        if (hasMoreStepsAfter(stepIndex)) {
          setShowContinueButton(true);
        } else {
          markLessonComplete();
        }
      }

      return doneEvent;
    } catch (error) {
      if (error.name === "AbortError") {
        finishTutorMessage({ stopped: true });
        return null;
      }
      finishTutorMessage({ stopped: false, usedExcerptIds: [] });
      throw error;
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      setIsStreaming(false);
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort();
  }

  async function handleContinueToNextStep() {
    if (isStreaming || !hasMoreStepsAfter(activeStepIndex)) {
      return;
    }

    setShowContinueButton(false);
    const nextIndex = activeStepIndex + 1;
    goToNextStep();
    openedStepRef.current = nextIndex;

    try {
      await runStreamedTutorTurn({
        mode: "open",
        stepIndex: nextIndex,
        history: messagesRef.current,
      });
    } catch (error) {
      if (error.name !== "AbortError") {
        setErrorMessage(error.message || "Could not open the next step.");
        openedStepRef.current = activeStepIndex;
        setShowContinueButton(true);
      }
    }
  }

  // Open step 1 once when the student lesson becomes available.
  useEffect(() => {
    if (!lessonPlan || lessonComplete || hasOpenedRef.current) {
      return;
    }
    if (!openAiApiKey.trim()) {
      setErrorMessage(
        "OpenAI API key is missing. Go back to Teacher prepare and enter it."
      );
      return;
    }

    hasOpenedRef.current = true;
    openedStepRef.current = 0;
    let cancelled = false;

    async function openFirstStep() {
      try {
        await runStreamedTutorTurn({
          mode: "open",
          stepIndex: 0,
          history: [],
        });
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message || "Could not open the tutor.");
          hasOpenedRef.current = false;
        }
      }
    }

    openFirstStep();
    return () => {
      cancelled = true;
      abortControllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonPlan, openAiApiKey, lessonComplete]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, lessonComplete, showContinueButton]);

  async function handleSend(event) {
    event.preventDefault();
    const text = draft.trim();
    if (
      !text ||
      isStreaming ||
      lessonComplete ||
      showContinueButton ||
      !currentStep
    ) {
      return;
    }

    setErrorMessage("");
    setDraft("");
    const historyWithStudent = [
      ...messages,
      { role: "student", text },
    ];
    setMessages(historyWithStudent);

    try {
      await runStreamedTutorTurn({
        mode: "reply",
        studentMessage: text,
        stepIndex: activeStepIndex,
        history: historyWithStudent,
      });
    } catch (error) {
      if (error.name !== "AbortError") {
        setErrorMessage(error.message || "Could not send your answer.");
      }
    }
  }

  if (!lessonPlan || !lessonPlan.steps?.length) {
    return (
      <section className="animate-rise space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">
          Student lesson
        </p>
        <h1 className="font-display text-3xl font-semibold text-ink">
          No lesson yet
        </h1>
        <p className="text-sm text-ink-soft">
          This is the student practice screen. First go to{" "}
          <Link
            to="/"
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            Teacher prepare
          </Link>
          , upload a PDF, then click Start Lesson.
        </p>
      </section>
    );
  }

  const stepNumber = activeStepIndex + 1;
  const stepExcerpts = currentStep ? excerptsForStep(currentStep) : [];
  const canTypeAnswer =
    !lessonComplete && !isStreaming && !showContinueButton;

  return (
    <section className="animate-rise flex min-h-[70vh] flex-col gap-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">
          Student lesson
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink">
          {courseTitle || "Untitled course"}
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          Answer the tutor here. The exercise panel shows the current problem.
        </p>
        <p className="mt-2 text-sm font-medium text-accent">
          {lessonComplete
            ? "Lesson complete"
            : `Step ${stepNumber} of ${stepCount}`}
        </p>
      </div>

      {!lessonComplete && currentStep && (
        <ExercisePanel
          exerciseType={exerciseType}
          step={currentStep}
          stepExcerpts={stepExcerpts}
        />
      )}

      {lessonComplete && (
        <div
          className="space-y-3 rounded-md border border-accent/30 bg-mist/50 px-4 py-4"
          role="status"
        >
          <p className="text-sm font-medium text-ink">
            Lesson complete — you finished every step.
          </p>
          <Link
            to="/"
            className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper hover:bg-accent-hover"
          >
            Back to Teacher prepare
          </Link>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden border-t border-ink/10 pt-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-soft">
          Tutor chat
        </h2>

        <div className="flex-1 space-y-3 overflow-y-auto pr-1">
          {messages.length === 0 && (
            <p className="text-sm text-ink-soft/70" role="status">
              {isStreaming
                ? "Starting the exercise with your tutor…"
                : "Waiting for the tutor to open this step…"}
            </p>
          )}

          {messages.map((message, index) => (
            <ChatBubble key={`${message.role}-${index}`} message={message} />
          ))}

          {/* Continue sits under the last tutor message, not at the page top. */}
          {showContinueButton && !lessonComplete && !isStreaming && (
            <div className="mr-auto flex max-w-[85%] flex-col gap-2 rounded-lg bg-paper-deep px-3.5 py-3">
              <p className="text-sm text-ink-soft">
                Ready for the next exercise when you are.
              </p>
              <button
                type="button"
                onClick={handleContinueToNextStep}
                className="w-fit rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper hover:bg-accent-hover"
              >
                Continue to step {stepNumber + 1}
              </button>
            </div>
          )}

          {isStreaming && messages.length > 0 && (
            <p className="text-sm text-ink-soft/70" role="status">
              Tutor is writing…
            </p>
          )}
          <div ref={bottomRef} />
        </div>

        <form
          onSubmit={handleSend}
          className="mt-4 flex flex-col gap-2 border-t border-ink/10 pt-4 sm:flex-row"
        >
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!canTypeAnswer}
            placeholder={
              lessonComplete
                ? "Lesson complete"
                : showContinueButton
                  ? "Click Continue to go to the next step"
                  : "Type your answer…"
            }
            className="flex-1 rounded-md border border-ink/15 bg-paper px-3 py-2.5 outline-none ring-accent focus:ring-2 disabled:opacity-60"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={handleStop}
              className="rounded-md border border-ink/20 bg-paper-deep px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-mist"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canTypeAnswer || !draft.trim()}
              className="rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-paper transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send
            </button>
          )}
        </form>

        {errorMessage && (
          <p className="mt-2 text-sm text-red-700" role="alert">
            {errorMessage}
          </p>
        )}
      </div>
    </section>
  );
}

function exerciseTypeLabel(exerciseType) {
  if (exerciseType === "math") {
    return "Math exercise";
  }
  if (exerciseType === "text") {
    return "Reading exercise";
  }
  return "Exercise";
}

function ExercisePanel({ exerciseType, step, stepExcerpts }) {
  return (
    <section className="rounded-md border border-ink/10 bg-paper-deep/50 px-4 py-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent">
        {exerciseTypeLabel(exerciseType)} · student view
      </p>
      <h2 className="mt-1 font-display text-xl font-semibold text-ink">
        {step.title}
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        <span className="font-medium text-ink">Goal: </span>
        {step.objective}
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        <span className="font-medium text-ink">You succeed when: </span>
        {step.comprehensionCriterion}
      </p>

      {stepExcerpts.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-ink/10 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
            From your PDF
          </p>
          {stepExcerpts.map((excerpt) => (
            <figure
              key={excerpt.id}
              className="rounded-md bg-paper px-3 py-2 text-sm text-ink"
            >
              <figcaption className="mb-1 text-xs font-semibold text-ink-soft">
                Page {excerpt.page}
              </figcaption>
              <blockquote className="whitespace-pre-wrap leading-relaxed">
                {excerpt.text}
              </blockquote>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}

function ChatBubble({ message }) {
  const isStudent = message.role === "student";
  const [isSourceOpen, setIsSourceOpen] = useState(false);

  const canViewSource =
    !isStudent &&
    !message.streaming &&
    !message.stopped &&
    Array.isArray(message.sourceExcerpts) &&
    message.sourceExcerpts.length > 0;

  return (
    <div
      className={[
        "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
        isStudent
          ? "ml-auto bg-accent text-paper"
          : "mr-auto bg-paper-deep text-ink",
      ].join(" ")}
    >
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">
        {isStudent ? "Student" : "Tutor"}
        {message.stopped ? " · Stopped" : ""}
      </p>
      <p className="whitespace-pre-wrap">{message.text}</p>

      {canViewSource && (
        <div className="mt-2 border-t border-ink/10 pt-2">
          <button
            type="button"
            onClick={() => setIsSourceOpen((open) => !open)}
            className="text-xs font-semibold text-accent underline-offset-2 hover:underline"
          >
            {isSourceOpen ? "Hide source" : "View source"}
          </button>

          {isSourceOpen && (
            <div className="mt-2 space-y-2">
              {message.sourceExcerpts.map((excerpt) => (
                <figure
                  key={excerpt.id}
                  className="rounded-md bg-paper/80 px-2.5 py-2 text-xs text-ink-soft"
                >
                  <figcaption className="mb-1 font-semibold text-ink">
                    Page {excerpt.page}
                  </figcaption>
                  <blockquote className="whitespace-pre-wrap">
                    {excerpt.text}
                  </blockquote>
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default StudentChatPage;
