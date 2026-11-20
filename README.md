# Teach Me This File

Turn a **PDF** into a short, step-by-step lesson. A **teacher** prepares the course; a **student** practices with a streaming AI tutor.

The OpenAI API key stays in the browser memory only for the session. It is sent to the server in a request header and is **never stored** on disk or in the repo.

---

## What the app does

1. **Teacher prepare** (`/`)
   - Enter a course title and teacher brief
   - Choose tutor language (default English)
   - Paste OpenAI API key in Settings
   - Select a PDF (max 5 MB, text-based)
   - Click **Start Lesson**

2. **Student lesson** (`/chat`)
   - Sees an **exercise panel** (goal + PDF excerpt)
   - Tutors streams a first question
   - Wrong answer → hint, same step
   - Correct answer → confirmation (no new question) + **Continue** to next step
   - Last step correct → “PDF lesson complete / available for next session”
   - **View source** shows the PDF excerpt used
   - **Stop** cancels an in-progress stream without advancing

---

## Requirements

- Node.js 18+ (20+ recommended)
- An OpenAI API key ([platform.openai.com](https://platform.openai.com))
- A **text-based** PDF (exported text, not a photo of handwriting — see `FUTURE_IDEAS.txt`)

---

## Install

From the project root:

```bash
npm run install:all
```

This installs root, `client/`, and `server/` dependencies.

---

## Run (development)

```bash
npm run dev
```

Then open: **http://localhost:5173/**

- Vite UI: port `5173` (proxies `/api` → Express)
- Express API: port `3001`

### Run (production-style)

```bash
npm run build
npm start
```

Open: **http://localhost:3001** (Express serves the built React app + API).

---

## How to use (step by step)

1. Start the app with `npm run dev`.
2. Open **Teacher prepare**.
3. Fill:
   - Course title (optional but useful)
   - Teacher brief (what to focus on)
   - Tutor language
   - OpenAI API key (`sk-…`) — kept in memory only
   - PDF file
4. Click **Start Lesson** once and wait (upload → plan).
5. You land on **Student lesson**:
   - Read the exercise panel
   - Answer in the tutor chat
   - Use **Continue** between steps when offered
6. When finished, use **Back to Teacher prepare** if you want another PDF.

### Dev-only mock key

In development you may type `mock` instead of a real key to test without OpenAI. This is blocked in production builds.

---

## API overview (for defenders / developers)

| Method | Path | Role |
|--------|------|------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/document` | Upload PDF → page excerpts `{ id, page, text }` |
| `POST` | `/api/lesson` | Excerpts + brief + language → lesson plan JSON (needs `x-openai-api-key`) |
| `POST` | `/api/tutor` | NDJSON stream: `delta` text chunks, then `done` with `advance` + `usedExcerptIds` |

Header for OpenAI routes: `x-openai-api-key: <key>`

Optional env on the server: `OPENAI_MODEL` (default `gpt-4o-mini`), `PORT` (default `3001`).

---

## Project layout

```
/
  client/          React + Vite + Tailwind (UI)
  server/          Express API + PDF extract + OpenAI
  FUTURE_IDEAS.txt Future features (time + cost estimates)
  README.md        This file
```

---

## Security notes (important for GitHub)

- **Do not commit** `.env` files or real API keys.
- The key is entered in the UI and held in React state only.
- `.gitignore` excludes `node_modules/`, `client/dist/`, and `.env*`.
- Test PDFs in `server/test-fixtures/` contain no secrets.

---

## Test PDFs

See `server/test-fixtures/`:

- `sample-text.pdf` — simple 2-page sample (quick smoke tests)
- `Math_Fractions_Extended.pdf` — extended fractions lesson
- `History_Industrial_Revolution.pdf` — industrial revolution reading lesson

Use these to defend / demo the full student flow.

---

## Future ideas

See **`FUTURE_IDEAS.txt`** for drag-and-drop, handwritten PDFs, session grading, and token-usage monitoring — including rough **time** and **cost** for each.

---

## Scripts

| Command | Meaning |
|---------|---------|
| `npm run install:all` | Install all packages |
| `npm run dev` | Client + server in watch mode |
| `npm run build` | Build the React client |
| `npm start` | Run Express (serves API + built client) |
