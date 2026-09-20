import { task } from "@trigger.dev/sdk";

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TELEGRAM_MAX_LENGTH = 4096;

const PROMPT = [
  "You are summarising a YouTube video from Malkansview, an Indian stock market education channel.",
  "The video may be in Hindi or English. Write your answer in English only.",
  "Give 5 to 8 key highlights as bullet points, each starting with '• '.",
  "Each bullet should be one or two sentences with concrete points (setups, levels, rules, examples).",
  "Use plain text only: no markdown, no asterisks, no headings, no intro or closing sentence.",
  "Only report what is said in the video. Do not add your own opinions or investment advice.",
].join(" ");

type SummarizePayload = {
  videoId: string;
  title: string;
  url: string;
};

type GeminiResponse = {
  steps?: Array<{
    type: string;
    content?: Array<{ text?: string }>;
  }>;
  output_text?: string;
};

// Gemini sometimes ignores "no markdown" — tidy up the common cases.
function toPlainText(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/^\s*[*-]\s+/gm, "• ")
    .trim();
}

// Telegram rejects messages over 4096 characters, so split on line breaks.
function splitMessage(text: string, limit = TELEGRAM_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
    while (current.length > limit) {
      chunks.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Telegram sendMessage failed: ${res.status} ${detail}`);
    }
  }
}

async function summarizeWithGemini(apiKey: string, videoUrl: string): Promise<string> {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: [
        { type: "text", text: PROMPT },
        { type: "video", uri: videoUrl },
      ],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Gemini request failed: ${res.status} ${detail}`);
  }

  const data = (await res.json()) as GeminiResponse;
  const fromSteps = (data.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .map((part) => part.text ?? "")
    .join("");
  const summary = toPlainText(fromSteps || data.output_text || "");
  if (!summary) throw new Error("Gemini returned no summary text");
  return summary;
}

export const summarizeVideo = task({
  id: "malkansview-summarize-video",
  maxDuration: 900, // long videos can take several minutes to process
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 30_000,
    maxTimeoutInMs: 120_000,
  },
  run: async (payload: SummarizePayload) => {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error("GEMINI_API_KEY is not set");
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");

    console.log(`Summarising "${payload.title}" (${payload.videoId})`);
    const summary = await summarizeWithGemini(geminiKey, payload.url);

    await sendTelegram(
      botToken,
      chatId,
      `🎬 New video: ${payload.title}\n${payload.url}\n\nKey highlights:\n${summary}`
    );
    return { videoId: payload.videoId, sent: true };
  },
  // After all retries fail (e.g. a multi-hour video or the free daily limit),
  // still tell the user about the video so it is never silently missed.
  onFailure: async ({ payload }) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    await sendTelegram(
      botToken,
      chatId,
      `🎬 New video: ${payload.title}\n${payload.url}\n\n⚠️ Couldn't summarise this one automatically — here's the link.`
    );
  },
});
