import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Proxy WebSocket and REST calls to the FastAPI backend
      "/ws": { target: "ws://localhost:8000", ws: true },
      "/rooms": { target: "http://localhost:8000" },
      "/ice-servers": { target: "http://localhost:8000" },
      "/create-room": { target: "http://localhost:8000" },
      "/room": {
        target: "http://localhost:8000",
        bypass: (req) => {
          // Do not proxy browser page navigations (HTML) to backend
          if (req.headers.accept && req.headers.accept.includes("text/html")) {
            return req.url;
          }
        },
      },
    },
  },
});
