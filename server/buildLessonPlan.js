/**
 * Build and validate a lesson plan from document excerpts via OpenAI.
 * The API key is passed in per request and must never be stored or logged.
 */

import { callOpenAiJson, OPENAI_MODEL } from "./openaiClient.js";

// Cap how much source text we send to the model (cost + context control).
const MAX_TOTAL_EXCERPT_CHARS = 12_000;
const MAX_CHARS_PER_EXCERPT = 2_000;

// Re-export so existing imports of OPENAI_LESSON_MODEL keep working.
export const OPENAI_LESSON_MODEL = OPENAI_MODEL;

/**
 * Trim excerpts so the prompt stays within a fixed budget.
 * Earlier pages keep priority — usually where core definitions live.
 */
export function limitExcerptText(excerpts) {
  const limited = [];
  let usedChars = 0;

  for (const excerpt of excerpts) {
    if (usedChars >= MAX_TOTAL_EXCERPT_CHARS) {
      break;
    }

    const remainingBudget = MAX_TOTAL_EXCERPT_CHARS - usedChars;
    const maxForThis = Math.min(MAX_CHARS_PER_EXCERPT, remainingBudget);
    const rawText = typeof excerpt.text === "string" ? excerpt.text : "";
    const text =
      rawText.length > maxForThis
        ? `${rawText.slice(0, maxForThis)}…`
        : rawText;

    limited.push({
      id: excerpt.id,
      page: excerpt.page,
      text,
    });
    usedChars += text.length;
  }

  return limited;
}

function normalizeTutorLanguage(tutorLanguage) {
  if (typeof tutorLanguage === "string" && tutorLanguage.trim()) {
    return tutorLanguage.trim();
  }
  return "English";
}

/**
 * Ask OpenAI for a JSON lesson plan (shared openaiClient helper).
 */
async function callOpenAiForLessonPlan({
  limitedExcerpts,
  teacherBrief,
  tutorLanguage,
  openAiApiKey,
  model,
}) {
  const systemPrompt = [
    "You are a teaching assistant that designs short lesson plans from source excerpts.",
    `Write every string field in ${tutorLanguage}.`,
    "Reply with JSON only, matching this shape:",
    '{ "language": string, "exerciseType": "math"|"text"|"mixed", "steps": [ { "title": string, "objective": string, "comprehensionCriterion": string, "excerptIds": string[] } ] }',
    "exerciseType: math if the source is mostly problems/formulas, text for reading/explanations, mixed otherwise.",
    "Each step must reference at least one excerpt id from the provided list.",
    "Only use excerpt ids that appear in the input. Prefer 2 to 5 steps.",
    "For math: each step should focus on one problem or skill, with a checkable criterion (correct answer or correct method).",
    "For text: each step should teach one idea the student can restate.",
  ].join(" ");

  return callOpenAiJson({
    openAiApiKey,
    model,
    systemPrompt,
    userPayload: {
      teacherBrief,
      tutorLanguage,
      excerpts: limitedExcerpts,
    },
  });
}

/**
 * Simulated plan used when the header key is "mock" (local tests without OpenAI).
 */
export function buildMockLessonPlan(limitedExcerpts, teacherBrief, tutorLanguage) {
  const firstId = limitedExcerpts[0]?.id;
  const secondId = limitedExcerpts[1]?.id || firstId;

  return {
    language: tutorLanguage,
    exerciseType: "text",
    steps: [
      {
        title: "Understand the core idea",
        objective: `Introduce the main idea from the source, guided by: ${teacherBrief}`,
        comprehensionCriterion:
          "The student can restate the main idea in their own words.",
        excerptIds: firstId ? [firstId] : [],
      },
      {
        title: "Connect supporting details",
        objective: "Link a second excerpt to the core idea.",
        comprehensionCriterion:
          "The student can name one supporting detail from the text.",
        excerptIds: secondId ? [secondId] : [],
      },
    ],
  };
}

/**
 * Ensure every step has the required fields and only known excerpt IDs.
 */
export function validateLessonPlan(rawPlan, allowedExcerpts) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    throw new Error("Lesson plan must be a JSON object.");
  }

  if (!Array.isArray(rawPlan.steps) || rawPlan.steps.length === 0) {
    throw new Error("Lesson plan must include at least one step.");
  }

  const allowedIds = new Set(allowedExcerpts.map((excerpt) => excerpt.id));
  const validatedSteps = [];

  for (let index = 0; index < rawPlan.steps.length; index += 1) {
    const step = rawPlan.steps[index];
    const stepLabel = `Step ${index + 1}`;

    if (!step || typeof step !== "object") {
      throw new Error(`${stepLabel} is not a valid object.`);
    }

    const title = typeof step.title === "string" ? step.title.trim() : "";
    const objective =
      typeof step.objective === "string" ? step.objective.trim() : "";
    const comprehensionCriterion =
      typeof step.comprehensionCriterion === "string"
        ? step.comprehensionCriterion.trim()
        : "";

    if (!title) {
      throw new Error(`${stepLabel} is missing a title.`);
    }
    if (!objective) {
      throw new Error(`${stepLabel} is missing an objective.`);
    }
    if (!comprehensionCriterion) {
      throw new Error(`${stepLabel} is missing a comprehension criterion.`);
    }

    if (!Array.isArray(step.excerptIds) || step.excerptIds.length === 0) {
      throw new Error(`${stepLabel} must list at least one excerpt id.`);
    }

    const excerptIds = [];
    for (const excerptId of step.excerptIds) {
      if (typeof excerptId !== "string" || !excerptId.trim()) {
        throw new Error(`${stepLabel} contains an invalid excerpt id.`);
      }
      if (!allowedIds.has(excerptId)) {
        throw new Error(
          `${stepLabel} references unknown excerpt id "${excerptId}".`
        );
      }
      excerptIds.push(excerptId);
    }

    validatedSteps.push({
      title,
      objective,
      comprehensionCriterion,
      excerptIds,
    });
  }

  const language =
    typeof rawPlan.language === "string" && rawPlan.language.trim()
      ? rawPlan.language.trim()
      : "English";

  const allowedTypes = new Set(["math", "text", "mixed"]);
  const exerciseType = allowedTypes.has(rawPlan.exerciseType)
    ? rawPlan.exerciseType
    : "mixed";

  return {
    language,
    exerciseType,
    steps: validatedSteps,
  };
}

/**
 * Full pipeline: limit text → call model (or mock) → validate plan + IDs.
 */
export async function buildLessonPlan({
  excerpts,
  teacherBrief,
  tutorLanguage,
  openAiApiKey,
  model = OPENAI_LESSON_MODEL,
}) {
  const limitedExcerpts = limitExcerptText(excerpts);
  const language = normalizeTutorLanguage(tutorLanguage);

  // "mock" lets us verify the route without a real OpenAI key.
  // The key still arrives only via the request header and is never stored.
  const rawPlan =
    openAiApiKey === "mock"
      ? buildMockLessonPlan(limitedExcerpts, teacherBrief, language)
      : await callOpenAiForLessonPlan({
          limitedExcerpts,
          teacherBrief,
          tutorLanguage: language,
          openAiApiKey,
          model,
        });

  const lessonPlan = validateLessonPlan(rawPlan, limitedExcerpts);

  return {
    lessonPlan,
    model: openAiApiKey === "mock" ? "mock" : model,
    excerptIdsUsed: limitedExcerpts.map((excerpt) => excerpt.id),
  };
}
