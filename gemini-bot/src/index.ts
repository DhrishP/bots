import { Router } from "itty-router";
import { GoogleGenerativeAI } from "@google/generative-ai";

interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
}

interface TelegramUpdate {
  message?: {
    chat: {
      id: number;
    };
    from?: {
      id: number;
    };
    text?: string;
  };
}

// Helper function to send Telegram messages
async function sendTelegramMessage(
  chatId: number,
  text: string,
  env: Env,
  deleteAfter: number = 0,
  ctx: ExecutionContext
) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "Markdown",
      }),
    }
  );

  const result = await response.json();

  if (deleteAfter > 0) {
    ctx.waitUntil(
      new Promise<void>((resolve) => {
        setTimeout(async () => {
          await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                chat_id: chatId,
                message_id: result.result.message_id,
              }),
            }
          );
          resolve();
        }, deleteAfter);
      })
    );
  }
}

// Get or create active session
async function getActiveSession(
  chatId: number,
  userId: number,
  env: Env
): Promise<number> {
  const session = await env.DB.prepare(
    `SELECT id FROM chat_sessions 
     WHERE chat_id = ? AND user_id = ? 
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(chatId.toString(), userId)
    .first<{ id: number }>();

  if (session) {
    return session.id;
  }

  const result = await env.DB.prepare(
    `INSERT INTO chat_sessions (chat_id, user_id) VALUES (?, ?)`
  )
    .bind(chatId.toString(), userId)
    .run();

  return result.lastRowId!;
}

// Create new session
async function createNewSession(
  chatId: number,
  userId: number,
  env: Env
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO chat_sessions (chat_id, user_id) VALUES (?, ?)`
  )
    .bind(chatId.toString(), userId)
    .run();

  return result.lastRowId!;
}

// Get chat history
async function getChatHistory(
  sessionId: number,
  env: Env
): Promise<{ role: string; content: string }[]> {
  const history = await env.DB.prepare(
    `SELECT role, content FROM chat_history 
     WHERE session_id = ? 
     ORDER BY created_at ASC`
  )
    .bind(sessionId)
    .all();

  return history.results as { role: string; content: string }[];
}

// Store message in history
async function storeMessage(
  sessionId: number,
  chatId: number,
  userId: number,
  role: string,
  content: string,
  env: Env
) {
  await env.DB.prepare(
    `INSERT INTO chat_history (session_id, chat_id, user_id, role, content)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(sessionId, chatId.toString(), userId, role, content)
    .run();
}

// Handle Telegram webhook updates
async function handleTelegramUpdate(
  update: TelegramUpdate,
  env: Env,
  ctx: ExecutionContext
) {
  const message = update.message;
  if (!message?.text || !message.chat || !message.from) return;

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text.trim();

  // Handle /start command
  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      `Welcome! I'm your Gemini AI chat bot. Here are the available commands:

/new - Start a new chat session
/history - Show current chat history
/help - Show this help message

Simply send any message to chat with me!`,
      env,
      0,
      ctx
    );
    return;
  }

  // Handle /help command
  if (text === "/help") {
    await sendTelegramMessage(
      chatId,
      `Available commands:

/new - Start a new chat session
/history - Show current chat history
/help - Show this help message

Each chat session maintains its own history, allowing for contextual conversations.`,
      env,
      0,
      ctx
    );
    return;
  }

  // Handle /new command
  if (text === "/new") {
    const sessionId = await createNewSession(chatId, userId, env);
    await sendTelegramMessage(
      chatId,
      "Started a new chat session! How can I help you?",
      env,
      0,
      ctx
    );
    return;
  }

  // Handle /history command
  if (text === "/history") {
    const sessionId = await getActiveSession(chatId, userId, env);
    const history = await getChatHistory(sessionId, env);

    if (history.length === 0) {
      await sendTelegramMessage(
        chatId,
        "No chat history in current session.",
        env,
        0,
        ctx
      );
      return;
    }

    const historyText = history
      .map((msg) => `*${msg.role}*: ${msg.content}`)
      .join("\n\n");

    await sendTelegramMessage(
      chatId,
      `Current Chat History:\n\n${historyText}`,
      env,
      0,
      ctx
    );
    return;
  }

  // Handle regular messages
  try {
    const sessionId = await getActiveSession(chatId, userId, env);
    const history = await getChatHistory(sessionId, env);

    // Store user message
    await storeMessage(sessionId, chatId, userId, "user", text, env);

    // Initialize Gemini AI
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    // Create chat
    const chat = model.startChat({
      history: history.map((msg) => ({
        role: msg.role,
        parts: msg.content,
      })),
    });

    // Get response
    const result = await chat.sendMessage(text);
    const response = result.response.text();

    // Store AI response
    await storeMessage(sessionId, chatId, userId, "assistant", response, env);

    // Send response to user
    await sendTelegramMessage(chatId, response, env, 0, ctx);
  } catch (error) {
    console.error(error);
    await sendTelegramMessage(
      chatId,
      "Sorry, I encountered an error processing your message.",
      env,
      0,
      ctx
    );
  }
}

// Router setup
const router = Router();

router.get("/", () => new Response("Bot is running!", { status: 200 }));

router.post(
  "/webhook",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    const update: TelegramUpdate = await request.json();
    await handleTelegramUpdate(update, env, ctx);
    return new Response("OK", { status: 200 });
  }
);

router.all("*", () => new Response("Not Found", { status: 404 }));

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return router.handle(request, env, ctx);
  },
};
