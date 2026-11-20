import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Vite proxies /api to Express during development so the browser
 * can call relative URLs like fetch("/api/course") without CORS friction.
 * In production, Express serves both the API and the built React app.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        // Long OpenAI streams should not be cut by a short proxy timeout.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
