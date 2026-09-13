import { generateText } from "ai";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { regularPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";

export const maxDuration = 60;

const TELEGRAM_MESSAGE_LIMIT = 4000;

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

function getTelegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  return token;
}

function isAuthorizedWebhook(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedSecret) {
    return true;
  }

  return (
    request.headers.get("x-telegram-bot-api-secret-token") === expectedSecret
  );
}

function splitTelegramMessage(text: string) {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);

    if (splitAt < TELEGRAM_MESSAGE_LIMIT / 2) {
      splitAt = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }

    if (splitAt < TELEGRAM_MESSAGE_LIMIT / 2) {
      splitAt = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendTelegramMessage(chatId: number, text: string) {
  const token = getTelegramToken();

  for (const chunk of splitTelegramMessage(text)) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
        }),
      }
    );

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Telegram sendMessage failed: ${details}`);
    }
  }
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

  try {
    if (text === "/start") {
      await sendTelegramMessage(
        message.chat.id,
        "Hey Dera💙, Satomi is online through Bigdera Agent. Send me a message."
      );

      return Response.json({ ok: true });
    }

    const userName =
      message.from?.first_name ?? message.from?.username ?? "Dera";

    const result = await generateText({
      model: getLanguageModel(DEFAULT_CHAT_MODEL),
      system: `${regularPrompt}

You are Satomi, the AI assistant inside Bigdera Agent.
Address the user as Dera💙 when natural.
Keep Telegram replies clear, useful, and reasonably concise.
The current Telegram user's display name is ${userName}.`,
      prompt: text,
    });

    await sendTelegramMessage(
      message.chat.id,
      result.text || "I couldn't generate a reply for that message."
    );

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Telegram bridge error:", error);

    try {
      await sendTelegramMessage(
        message.chat.id,
        "I hit a temporary backend error. Try that message again."
      );
    } catch {
      // Avoid masking the original backend error if Telegram itself is unavailable.
    }

    return Response.json({ ok: false }, { status: 500 });
  }
}
