/**
 * Streaming tutor turns for the student chat.
 * For replies we judge advance FIRST, then stream a matching message
 * so the tutor does not re-ask the same question after a correct answer.
 */

import { callOpenAiJson, OPENAI_MODEL, streamOpenAiText } from "./openaiClient.js";
import { limitExcerptText } from "./buildLessonPlan.js";

const MAX_RECENT_MESSAGES = 12;
const MOCK_CHUNK_DELAY_MS = 40;

function normalizeTutorLanguage(tutorLanguage) {
  if (typeof tutorLanguage === "string" && tutorLanguage.trim()) {
    return tutorLanguage.trim();
  }
  return "English";
}

function trimRecentMessages(recentMessages) {
  if (!Array.isArray(recentMessages)) {
    return [];
  }

  return recentMessages
    .filter(
      (message) =>
        message &&
        (message.role === "student" || message.role === "tutor") &&
        typeof message.text === "string"
    )
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => ({
      role: message.role,
      text: message.text.slice(0, 1_000),
    }));
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }

    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Keep only excerpt IDs that were actually provided for this tutor turn.
 * Unknown IDs from the model are dropped so "View source" never points at missing text.
 */
export function validateUsedExcerptIds(claimedIds, allowedExcerpts) {
  if (!Array.isArray(claimedIds) || claimedIds.length === 0) {
    return [];
  }

  const allowedIds = new Set(
    (allowedExcerpts || [])
      .map((excerpt) => excerpt?.id)
      .filter((id) => typeof id === "string" && id.length > 0)
  );

  const validIds = [];
  for (const claimedId of claimedIds) {
    if (typeof claimedId !== "string" || !claimedId.trim()) {
      continue;
    }
    if (!allowedIds.has(claimedId)) {
      continue;
    }
    if (validIds.includes(claimedId)) {
      continue;
    }
    validIds.push(claimedId);
  }

  return validIds;
}

/**
 * Mock tutor content + advance decision (same rules as before).
 * Includes a deliberate unknown ID so validation can be tested.
 */
export function buildMockTutorTurn({
  mode,
  studentMessage,
  step,
  stepExcerpts,
  tutorLanguage,
}) {
  const excerptPreview = stepExcerpts[0]?.text || "the source text";
  const firstId = stepExcerpts[0]?.id;
  const claimedSourceIds = firstId
    ? [firstId, "page-unknown"]
    : ["page-unknown"];

  if (mode === "open") {
    return {
      reply:
        `Welcome. In ${tutorLanguage}: let's begin with "${step.title}". ` +
        `${step.objective} From the text: "${excerptPreview}". ` +
        `Question: can you restate the main idea in your own words?`,
      advance: false,
      usedExcerptIds: claimedSourceIds,
    };
  }

  const text = (studentMessage || "").trim().toLowerCase();
  const looksWrong =
    text.length < 8 ||
    /^(no|nope|idk|i don't know|wrong|asdf|zzz)\b/.test(text);

  if (looksWrong) {
    return {
      reply:
        "Not quite. Hint: look at the key words in the excerpt, then try again in a full sentence.",
      advance: false,
      usedExcerptIds: claimedSourceIds,
    };
  }

  return {
    reply:
      "Yes — that shows you understood this step. Great work; we can move on.",
    advance: true,
    usedExcerptIds: claimedSourceIds,
  };
}

async function streamMockText(fullText, { signal, onDelta }) {
  const pieces = fullText.match(/\S+\s*/g) || [fullText];

  for (const piece of pieces) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
    onDelta(piece);
    await delay(MOCK_CHUNK_DELAY_MS, signal);
  }
}

function buildOpenStepPrompt(tutorLanguage) {
  return [
    "You are a clear, encouraging tutor for one lesson step.",
    `Write your entire reply in ${tutorLanguage}.`,
    "Reply with plain text only (no JSON).",
    "Show the exercise or idea from the excerpts in a readable way.",
    "For math: write the problem clearly and ask for the next useful step or the answer.",
    "For text subjects: summarize the key point briefly, then ask one focused question.",
    "Ask exactly one question. Do not invent numbers or facts missing from the excerpts.",
  ].join(" ");
}

function buildReplyStepPrompt(tutorLanguage, advance, hasMoreSteps) {
  if (advance && hasMoreSteps) {
    return [
      "You are a clear, encouraging tutor.",
      `Write your entire reply in ${tutorLanguage}.`,
      "Reply with plain text only (no JSON).",
      "The student ALREADY got this step right (advance=true).",
      "Confirm briefly what was correct.",
      "Tell them they can continue to the next step when ready.",
      "Do NOT ask any new question. Do NOT start the next exercise. No question mark at the end.",
      "Keep it short (2-3 sentences).",
    ].join(" ");
  }

  if (advance && !hasMoreSteps) {
    return [
      "You are a clear, encouraging tutor.",
      `Write your entire reply in ${tutorLanguage}.`,
      "Reply with plain text only (no JSON).",
      "The student finished the LAST step of this PDF lesson (advance=true, no more steps).",
      "Congratulate them and say the PDF lesson is complete.",
      "Say you are available for a next session if they want to learn another file.",
      "Do NOT ask any new question. No question mark at the end.",
      "Keep it warm and short.",
    ].join(" ");
  }

  return [
    "You are a clear, encouraging tutor.",
    `Write your entire reply in ${tutorLanguage}.`,
    "Reply with plain text only (no JSON).",
    "The student did NOT meet the criterion yet (advance=false).",
    "Give one short hint, then ask a DIFFERENT guiding question (not a copy of the previous one).",
    "For math: point to the next calculation step without spoiling the full answer unless needed.",
    "Do not invent excerpt text.",
  ].join(" ");
}

/**
 * Judge the student before writing the reply so speech and advance stay aligned.
 * Math-friendly: accept correct numeric results and equivalent reasoning.
 */
async function evaluateStudentAnswer({
  teacherBrief,
  tutorLanguage,
  step,
  limitedExcerpts,
  recentMessages,
  studentMessage,
  openAiApiKey,
  model,
  signal,
}) {
  const allowedIdList = limitedExcerpts.map((excerpt) => excerpt.id);

  const systemPrompt = [
    "You grade one student answer for a single lesson step.",
    'Return classic JSON only: { "advance": boolean, "usedExcerptIds": string[], "reason": string }.',
    "Set advance=true if the answer is good enough for this step: correct result, correct method, or a clear restatement that meets the criterion.",
    "For math, accept equivalent numeric forms (e.g. 1/2 and 0.5) and partial credit when the key step is right.",
    "Be fair, not pedantic. Only set advance=false when the answer is wrong, empty, or off-topic.",
    "usedExcerptIds: excerpt ids from the allowed list that the exercise relied on.",
    "Allowed ids: " + JSON.stringify(allowedIdList) + ".",
  ].join(" ");

  const result = await callOpenAiJson({
    openAiApiKey,
    model,
    systemPrompt,
    userPayload: {
      teacherBrief,
      tutorLanguage,
      step: {
        title: step.title,
        objective: step.objective,
        comprehensionCriterion: step.comprehensionCriterion,
      },
      stepExcerpts: limitedExcerpts,
      recentMessages,
      studentMessage,
    },
    temperature: 0.1,
    signal,
  });

  return {
    advance: Boolean(result.advance),
    usedExcerptIds: validateUsedExcerptIds(
      result.usedExcerptIds,
      limitedExcerpts
    ),
    reason: typeof result.reason === "string" ? result.reason : "",
  };
}

async function collectUsedExcerptIdsAfterOpen({
  teacherBrief,
  step,
  limitedExcerpts,
  openAiApiKey,
  model,
  signal,
}) {
  const allowedIdList = limitedExcerpts.map((excerpt) => excerpt.id);
  if (allowedIdList.length === 0) {
    return [];
  }

  const result = await callOpenAiJson({
    openAiApiKey,
    model,
    systemPrompt: [
      "Return JSON only: { \"usedExcerptIds\": string[] }.",
      "List excerpt ids from the allowed list that this open turn taught from.",
      "Allowed ids: " + JSON.stringify(allowedIdList) + ".",
    ].join(" "),
    userPayload: {
      teacherBrief,
      step: {
        title: step.title,
        objective: step.objective,
      },
      stepExcerpts: limitedExcerpts,
    },
    temperature: 0,
    signal,
  });

  const validated = validateUsedExcerptIds(
    result.usedExcerptIds,
    limitedExcerpts
  );
  // Fallback: if the model returns nothing, still enable View source on open turns.
  return validated.length > 0 ? validated : allowedIdList.slice(0, 1);
}

/**
 * Stream tutor text as deltas, then report advance + validated source IDs.
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
  model = OPENAI_MODEL,
  signal,
  onDelta,
  onDone,
}) {
  if (mode !== "open" && mode !== "reply") {
    throw new Error('mode must be "open" or "reply".');
  }

  if (!step || typeof step !== "object") {
    throw new Error("step is required.");
  }

  const language = normalizeTutorLanguage(tutorLanguage);
  const limitedExcerpts = limitExcerptText(
    Array.isArray(stepExcerpts) ? stepExcerpts : []
  );
  const trimmedMessages = trimRecentMessages(recentMessages);
  const modelLabel = openAiApiKey === "mock" ? "mock" : model;

  if (openAiApiKey === "mock") {
    const mockTurn = buildMockTutorTurn({
      mode,
      studentMessage,
      step,
      stepExcerpts: limitedExcerpts,
      tutorLanguage: language,
    });

    await streamMockText(mockTurn.reply, { signal, onDelta });

    const advance = mode === "open" ? false : mockTurn.advance;
    const usedExcerptIds = validateUsedExcerptIds(
      mockTurn.usedExcerptIds,
      limitedExcerpts
    );
    onDone({ advance, model: modelLabel, usedExcerptIds });
    return;
  }

  const basePayload = {
    mode,
    teacherBrief,
    tutorLanguage: language,
    step: {
      title: step.title,
      objective: step.objective,
      comprehensionCriterion: step.comprehensionCriterion,
    },
    stepExcerpts: limitedExcerpts,
    recentMessages: trimmedMessages,
    studentMessage: mode === "reply" ? studentMessage : null,
  };

  if (mode === "open") {
    await streamOpenAiText({
      openAiApiKey,
      model,
      systemPrompt: buildOpenStepPrompt(language),
      userPayload: basePayload,
      signal,
      onDelta,
    });

    const usedExcerptIds = await collectUsedExcerptIdsAfterOpen({
      teacherBrief,
      step,
      limitedExcerpts,
      openAiApiKey,
      model,
      signal,
    });

    onDone({ advance: false, model: modelLabel, usedExcerptIds });
    return;
  }

  // Reply mode: decide advance first, then speak consistently with that decision.
  const evaluation = await evaluateStudentAnswer({
    teacherBrief,
    tutorLanguage: language,
    step,
    limitedExcerpts,
    recentMessages: trimmedMessages,
    studentMessage,
    openAiApiKey,
    model,
    signal,
  });

  await streamOpenAiText({
    openAiApiKey,
    model,
    systemPrompt: buildReplyStepPrompt(
      language,
      evaluation.advance,
      Boolean(hasMoreSteps)
    ),
    userPayload: {
      ...basePayload,
      hasMoreSteps: Boolean(hasMoreSteps),
      evaluation: {
        advance: evaluation.advance,
        reason: evaluation.reason,
      },
    },
    signal,
    onDelta,
  });

  onDone({
    advance: evaluation.advance,
    model: modelLabel,
    usedExcerptIds:
      evaluation.usedExcerptIds.length > 0
        ? evaluation.usedExcerptIds
        : limitedExcerpts.slice(0, 1).map((excerpt) => excerpt.id),
  });
}
