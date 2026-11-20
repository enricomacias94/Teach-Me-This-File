import { NavLink, Route, Routes } from "react-router-dom";
import { LessonProvider } from "./lessonContext.jsx";
import PrepareCoursePage from "./pages/PrepareCoursePage.jsx";
import StudentChatPage from "./pages/StudentChatPage.jsx";

/**
 * Shell of the app: brand + navigation between teacher and student screens.
 */
function App() {
  return (
    <LessonProvider>
      <div className="min-h-screen">
        <header className="border-b border-ink/10 bg-paper/70 backdrop-blur-sm">
          <div className="mx-auto flex max-w-5xl flex-col gap-4 px-5 py-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="font-display text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                Teach Me This File
              </p>
              <p className="mt-1 max-w-md text-sm text-ink-soft/80">
                Teacher prepares the PDF lesson; student practices in the chat.
              </p>
            </div>

            <nav className="flex gap-2" aria-label="Main navigation">
              <AppNavLink to="/">Teacher prepare</AppNavLink>
              <AppNavLink to="/chat">Student lesson</AppNavLink>
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-5 py-8">
          <Routes>
            <Route path="/" element={<PrepareCoursePage />} />
            <Route path="/chat" element={<StudentChatPage />} />
          </Routes>
        </main>
      </div>
    </LessonProvider>
  );
}

function AppNavLink({ to, children }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          "rounded-md px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-accent text-paper"
            : "bg-paper-deep text-ink-soft hover:bg-mist",
        ].join(" ")
      }
    >
      {children}
    </NavLink>
  );
}

export default App;
