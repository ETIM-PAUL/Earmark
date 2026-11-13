import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        landing: resolve(import.meta.dirname, "index.html"),
        app: resolve(import.meta.dirname, "app/index.html"),
        receipt: resolve(import.meta.dirname, "receipt.html"),
        judge: resolve(import.meta.dirname, "judge.html"),
      },
    },
  },
});
