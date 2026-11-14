import { API_URL } from "../app/api.js";

// The hero's one moment: a family member asks for light, the assistant
// replies, and a receipt stub prints. It plays once on load and again on
// request. With reduced motion, the finished scene shows at once.

const SCRIPT: { from: "them" | "bot"; text: string; wait: number }[] = [
  { from: "them", text: "abeg buy 5k light for my meter", wait: 900 },
  {
    from: "bot",
    text: "Ikeja Electric prepaid. MAMA NGOZI ADEYEMI, meter 4503…4567. ₦5,000 (about $3.77). Reply YES to pay.",
    wait: 1500,
  },
  { from: "them", text: "yes", wait: 900 },
  { from: "bot", text: "Paying now.", wait: 1100 },
  { from: "bot", text: "Done! Light ₦5,000 paid. Your token: 2636 2054 4059 8275 7802", wait: 700 },
];

const chat = document.getElementById("chat") as HTMLOListElement;
const stub = document.getElementById("stub") as HTMLElement;
const replay = document.getElementById("replay") as HTMLButtonElement;
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
let run = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bubble(from: "them" | "bot", text: string) {
  const li = document.createElement("li");
  li.className = `bubble ${from}`;
  li.textContent = text;
  chat.append(li);
  chat.scrollTop = chat.scrollHeight;
}

async function play() {
  const mine = ++run;
  chat.replaceChildren();
  stub.hidden = true;
  stub.classList.remove("print");
  replay.hidden = true;
  for (const line of SCRIPT) {
    if (still) {
      bubble(line.from, line.text);
      continue;
    }
    await sleep(line.wait);
    if (mine !== run) return;
    bubble(line.from, line.text);
  }
  if (!still) await sleep(600);
  if (mine !== run) return;
  stub.hidden = false;
  // Next frame, so the print animation starts from its first keyframe.
  requestAnimationFrame(() => stub.classList.add("print"));
  replay.hidden = false;
}

replay.addEventListener("click", () => void play());
void play();

// "Try it now": the bot makes a ready-made demo family and answers with its
// judge view (the sender's app, the relative's chat and the chain). The
// hosted bot may be asleep, so say so while it wakes.
async function tryDemo(button: HTMLButtonElement, status: HTMLElement) {
  button.disabled = true;
  status.textContent = "Setting up a demo family…";
  const slow = setTimeout(() => {
    status.textContent = "Waking the demo up. On free hosting this can take about 30 seconds.";
  }, 4_000);
  try {
    const res = await fetch(`${API_URL}/demo/try`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { judge?: string; error?: string };
    if (res.ok && body.judge) {
      location.assign(body.judge);
      return;
    }
    status.textContent = body.error ?? "The demo couldn't start just now. Please try again.";
  } catch {
    status.textContent =
      "The demo couldn't be reached. Try again in a minute, or run it locally with make demo.";
  } finally {
    clearTimeout(slow);
    button.disabled = false;
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-try-demo]")) {
  const status = button
    .closest(".wrap, .hero-copy")
    ?.querySelector<HTMLElement>("[data-try-status]");
  if (status) button.addEventListener("click", () => void tryDemo(button, status));
}
