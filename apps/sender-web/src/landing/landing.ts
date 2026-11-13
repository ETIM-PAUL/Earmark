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
