import { API_URL } from "./api.js";

// The recipient's chat, as the local demo exposes it. A real family chats on
// Telegram or WhatsApp, and the bot doesn't keep or serve those messages, so
// outside the demo `loadChat` answers null and the app says so.

export type Line = { from: "recipient" | "bot"; text: string; at: string };

export async function loadChat(familyId: string): Promise<Line[] | null> {
  try {
    const res = await fetch(`${API_URL}/demo/family?family=${familyId}`);
    if (!res.ok) return null;
    return ((await res.json()) as { transcript: Line[] }).transcript;
  } catch {
    return null;
  }
}

export async function say(familyId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/demo/say`, {
      method: "POST",
      body: JSON.stringify({ family: familyId, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
