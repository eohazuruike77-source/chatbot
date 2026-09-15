import { generateText } from "ai";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { regularPrompt } from "@/lib/ai/prompts";

export const maxDuration = 60;

const TELEGRAM_MESSAGE_LIMIT = 4096;

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: {
    id: number;
  };
  from?: {
    first_name?: string;
    username?: string;
  };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

function isAuthorizedWebhook(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedSecret) {
    return false;
  }

  return (
    request.headers.get("x-telegram-bot-api-secret-token") === expectedSecret
  );
}

function telegramReply(chatId: number, text: string) {
  const safeText =
    text.length > TELEGRAM_MESSAGE_LIMIT
      ? `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 16)}\n\n[truncated]`
      : text;

  return Response.json({
    method: "sendMessage",
    chat_id: chatId,
    text: safeText,
  });
}

function sanitizeError(error: unknown) {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown AI Gateway error";

  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(api[_-]?key|token|secret)\s*[:=]\s*[^,\s]+/gi,
      "$1=[redacted]"
    )
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .slice(0, 500);
}

export async function GET() {
  return Response.json({
    ok: true,
    service: "Bigdera Agent Telegram bridge",
  });
}

export async function POST(request: Request) {
  if (!isAuthorizedWebhook(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TelegramUpdate;

  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const message = update.message;
  const text = message?.text?.trim();

  if (!message || !text) {
    return Response.json({ ok: true });
  }

  if (text === "/start") {
    return telegramReply(
      message.chat.id,
      "Hey Dera💙, Satomi is online through Bigdera Agent. Send me a message."
    );
  }

  try {
    const userName =
      message.from?.first_name ?? message.from?.username ?? "Dera";

    const result = await generateText({
      model: DEFAULT_CHAT_MODEL,
      system: `${regularPrompt}

You are Satomi, the AI assistant inside Bigdera Agent.
Address the user as Dera💙 when natural.
Keep Telegram replies clear, useful, and reasonably concise.
The current Telegram user's display name is ${userName}.`,
      prompt: text,
      maxOutputTokens: 700,
      providerOptions: {
        gateway: {
          models: [
            "openai/gpt-oss-20b",
            "deepseek/deepseek-v3.2",
            "xai/grok-4.1-fast-non-reasoning",
          ],
        },
      },
    });

    return telegramReply(
      message.chat.id,
      result.text || "I couldn't generate a reply for that message."
    );
  } catch (error) {
    console.error("Telegram bridge AI error:", error);

    return telegramReply(
      message.chat.id,
      `AI backend error: ${sanitizeError(error)}`
    );
  }
}
