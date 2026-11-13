import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import "./ui/tokens.css";
import "./app/app.css";

// The sender app: passkey sign-in, family setup, approvals, rules, freeze
// and the activity feed. Talks to the bot's /api (VITE_API_URL).

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
