import { regularPrompt } from "@/lib/ai/prompts";

export const maxDuration = 60;

const TELEGRAM_MESSAGE_LIMIT = 4096;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "openrouter/free";

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

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
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
        : "Unknown AI backend error";

  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(api[_-]?key|token|secret)\s*[:=]\s*[^,\s]+/gi,
      "$1=[redacted]"
    )
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .slice(0, 500);
}

function extractAssistantText(data: OpenRouterResponse) {
  const content = data.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
  }

  return "";
}

async function generateOpenRouterReply(text: string, userName: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Bigdera Agent",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: "system",
            content: `${regularPrompt}\n\nYou are Satomi, the AI assistant inside Bigdera Agent.\nAddress the user as Dera💙 when natural.\nKeep Telegram replies clear, useful, and reasonably concise.\nThe current Telegram user's display name is ${userName}.`,
          },
          {
            role: "user",
            content: text,
          },
        ],
        max_tokens: 700,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    let data: OpenRouterResponse = {};

    try {
      data = (await response.json()) as OpenRouterResponse;
    } catch {
      // Keep a clean error below when the upstream response is not JSON.
    }

    if (!response.ok) {
      const upstreamMessage = data.error?.message;
      throw new Error(
        upstreamMessage
          ? `OpenRouter ${response.status}: ${upstreamMessage}`
          : `OpenRouter request failed with status ${response.status}`
      );
    }

    const reply = extractAssistantText(data);

    if (!reply) {
      throw new Error("OpenRouter returned an empty response");
    }

    return reply;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenRouter request timed out");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  return Response.json({
    ok: true,
    service: "Bigdera Agent Telegram bridge",
    ai: "OpenRouter Free",
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

    const reply = await generateOpenRouterReply(text, userName);

    return telegramReply(message.chat.id, reply);
  } catch (error) {
    console.error("Telegram bridge AI error:", error);

    return telegramReply(
      message.chat.id,
      `AI backend error: ${sanitizeError(error)}`
    );
  }
}
