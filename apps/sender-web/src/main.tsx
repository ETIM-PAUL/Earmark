import { CATEGORIES } from "@earmark/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Sender app skeleton. Owner: Apps. Phase 12 fills this in: sign-in,
// family setup, top-ups, the receipts feed, approvals and freeze.

function App() {
  return (
    <main
      style={{ fontFamily: "system-ui, sans-serif", maxWidth: 480, margin: "0 auto", padding: 16 }}
    >
      <h1>Earmark</h1>
      <p>Send money home with rules.</p>
      <p>Bills we pay: {CATEGORIES.join(", ")}.</p>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
