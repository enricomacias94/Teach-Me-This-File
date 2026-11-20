import { createContext, useContext, useMemo, useState } from "react";

const LessonContext = createContext(null);

/**
 * Holds the active lesson in React memory only.
 * The OpenAI key stays here too — never written to localStorage.
 */
export function LessonProvider({ children }) {
  const [courseTitle, setCourseTitle] = useState("");
  const [teacherBrief, setTeacherBrief] = useState("");
  const [tutorLanguage, setTutorLanguage] = useState("English");
  const [excerpts, setExcerpts] = useState([]);
  const [lessonPlan, setLessonPlan] = useState(null);
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [lessonComplete, setLessonComplete] = useState(false);
  const [openAiApiKey, setOpenAiApiKey] = useState("");

  function startActiveLesson({
    title,
    brief,
    language,
    documentExcerpts,
    plan,
  }) {
    setCourseTitle(title);
    setTeacherBrief(brief);
    setTutorLanguage(language || "English");
    setExcerpts(documentExcerpts);
    setLessonPlan(plan);
    setActiveStepIndex(0);
    setLessonComplete(false);
  }

  function hasMoreStepsAfter(index) {
    const stepCount = lessonPlan?.steps?.length || 0;
    return index < stepCount - 1;
  }

  function goToNextStep() {
    setActiveStepIndex((currentIndex) => {
      if (!hasMoreStepsAfter(currentIndex)) {
        return currentIndex;
      }
      return currentIndex + 1;
    });
  }

  function markLessonComplete() {
    setLessonComplete(true);
  }

  function clearActiveLesson() {
    setCourseTitle("");
    setTeacherBrief("");
    setTutorLanguage("English");
    setExcerpts([]);
    setLessonPlan(null);
    setActiveStepIndex(0);
    setLessonComplete(false);
  }

  const value = useMemo(
    () => ({
      courseTitle,
      teacherBrief,
      tutorLanguage,
      excerpts,
      lessonPlan,
      activeStepIndex,
      lessonComplete,
      openAiApiKey,
      setOpenAiApiKey,
      startActiveLesson,
      hasMoreStepsAfter,
      goToNextStep,
      markLessonComplete,
      clearActiveLesson,
    }),
    [
      courseTitle,
      teacherBrief,
      tutorLanguage,
      excerpts,
      lessonPlan,
      activeStepIndex,
      lessonComplete,
      openAiApiKey,
    ]
  );

  return (
    <LessonContext.Provider value={value}>{children}</LessonContext.Provider>
  );
}

export function useLesson() {
  const context = useContext(LessonContext);
  if (!context) {
    throw new Error("useLesson must be used inside LessonProvider.");
  }
  return context;
}
