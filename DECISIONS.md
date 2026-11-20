# Decisions — Teach Me This File

Architecture choices, known limitations, a short “four more hours” plan, and test scenarios with observed results.

---

## Architecture choices

### Split: React client + Express server
- **Client (`client/`):** Vite + React + Tailwind. Two screens — Teacher prepare (`/`) and Student lesson (`/chat`). Shared lesson state lives in React memory (`lessonContext.jsx`), including the OpenAI key (never `localStorage`).
- **Server (`server/`):** Express owns PDF extraction, lesson planning, and tutor turns. Keeps the API key off disk: it arrives only in the `x-openai-api-key` header per request.

### Why relative `/api` + Vite proxy
In development, Vite proxies `/api` to Express so the browser uses same-origin URLs. In production, Express serves `client/dist` and the API from one origin.

### PDF → excerpts → plan → tutor
1. `POST /api/document` — extract text per page (`pdfjs-dist`) into `{ id, page, text }`.
2. `POST /api/lesson` — OpenAI builds a validated JSON plan (steps with objectives, criteria, excerpt IDs).
3. `POST /api/tutor` — NDJSON stream: `delta` chunks for the reply, then `done` with `advance` and `usedExcerptIds`.

### Tutor: evaluate before streaming the reply
For student answers we grade first (`advance` true/false), then stream a reply that matches that decision. That avoids “correct” answers still being followed by the same question. Mid-lesson success shows a **Continue** control under the last message; the last step closes with a completion message (no new question).

### Citations
`usedExcerptIds` are validated against excerpts for that turn. Invalid or missing IDs → empty list → **View source** is hidden. We do **not** fall back to the first PDF page (that would mis-attribute sources).

### Streaming + Stop
Tutor text streams as it arrives. **Stop** uses `AbortController`; a cut stream sends no `done`, so the step does not advance. Partial text is kept and marked Stopped.

---

## Known limitations

- **Text-layer PDFs only.** Scanned or handwritten pages have no extractable text with the current pipeline (no OCR/vision yet).
- **No persistence.** Refresh clears the lesson, messages, and API key.
- **Key in the browser.** Fine for a local demo; a production app should keep the key on the server only.
- **In-memory course store** on the server is enough for one demo process, not multi-user production.
- **Sleep / tab background.** A stream interrupted by sleep is aborted on wake so the UI unlocks; the user may need to resend or Continue.
- **No public hosted demo** in this submission — run locally from the GitHub repo.
- **Model quality varies.** Grading and citations depend on OpenAI; we validate IDs and structure, but wording quality is model-dependent.

---

## If we had four more hours

1. **Server-side token usage logging** for `/api/lesson` and `/api/tutor` (prompt/completion totals) — quick win for cost control (see `FUTURE_IDEAS.txt`).
2. **Drag-and-drop** on Teacher prepare — small UX polish, no API change.
3. **Harden wake recovery** with a short “Retry last tutor turn” when a stream dies after sleep.
4. **One hosted demo** (e.g. Render/Fly for API + static client) and put that live URL at the top of the README.

Larger items (handwriting OCR, saved sessions + grading) need more than four hours — documented in `FUTURE_IDEAS.txt` with time/cost notes.

---

## Test scenarios and observed results

Labels: **[mock]** = `x-openai-api-key: mock` / no real OpenAI · **[OpenAI]** = real key · **[manual UI]** = exercised in the browser

### 1. PDF extract → excerpts
- **What:** Upload a text PDF to `POST /api/document`.
- **Observed:** Returns per-page excerpts with `id` / `page` / `text`.  
  - Sample fixture: 2 pages.  
  - `Math_Fractions_Extended.pdf` / `History_Industrial_Revolution.pdf`: 5 excerpts each (extract check).  
- **Label:** structural / local (no OpenAI)

### 2. Wrong then right answer (advance behavior)
- **What:** Tutor reply after a bad answer, then a good one.
- **Observed [mock]:** `idk` → hint, `advance: false`; full correct sentence → `advance: true`.  
- **Observed [OpenAI] [manual UI]:** Wrong answers stayed on the same step with hints; correct answers confirmed and offered **Continue** (or lesson complete on the last step), without jumping into a new question in the same bubble.
- **Label:** [mock] automated + [OpenAI] manual UI

### 3. Stop mid-stream does not advance
- **What:** Abort the tutor stream before `done`.
- **Observed [mock]:** After a few deltas, abort → no `done` → `advance` not applied.  
- **Observed [OpenAI] [manual UI]:** Stop kept partial text with Stopped; step did not advance.
- **Label:** [mock] automated + [OpenAI] manual UI

### 4. View source / citation honesty
- **What:** Only show View source when `usedExcerptIds` are valid for that turn.
- **Observed [mock]:** Valid `page-1` kept; unknown `page-unknown` dropped by validation.  
- **Observed [OpenAI] [manual UI]:** After removing the “first excerpt” fallback, replies with no valid ID no longer show a misleading View source to the wrong page; answers still display.
- **Label:** [mock] automated + [OpenAI] manual UI (post-fix)

### 5. Full lesson path (prepare → steps → complete)
- **What:** Teacher prepare with a real PDF + key → student chat through steps → completion.
- **Observed [OpenAI] [manual UI]:** Used custom PDFs (fractions / industrial revolution). Exercise panel visible; Continue under the last chat message; last success closed with completion-style message (not a new quiz question). Premature Start Lesson / empty proxy responses surfaced clearer errors after hardening JSON parsing.
- **Label:** [OpenAI] manual UI

### Extra check (not a full scenario): screen sleep
- **Observed:** Visibility recovery aborts a hung stream on wake so Send is not permanently locked.  
- **Label:** defensive fix verified in code path; treat as [manual] when demoing sleep/wake live.
