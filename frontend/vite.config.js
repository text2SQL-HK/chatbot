import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "../app/static"),
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/chat": "http://localhost:8000",
      "/chat/history": "http://localhost:8000",
      "/api": "http://localhost:8000",
    },
  },
});
