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
                message_id: (result as any).result.message_id,
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

  return result.meta.last_row_id;
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

  return result.meta.last_row_id;
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

// New function to process user messages
async function processUserMessage(
  chatId: number,
  userId: number,
  text: string,
  env: Env,
  ctx: ExecutionContext
) {
  try {
    const sessionId = await getActiveSession(chatId, userId, env);
    let history = await getChatHistory(sessionId, env);

    // Store the current user's message BEFORE the API call
    await storeMessage(sessionId, chatId, userId, "user", text, env);

    // For the API call, `history` for startChat should be prior messages.
    // The `text` (current user message) will be sent via chat.sendMessage()

    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const chat = model.startChat({
      history: history.map((msg) => ({
        // Use prior history here
        role: msg.role,
        parts: [{ text: msg.content }],
      })),
      generationConfig: {
        maxOutputTokens: 150,
      },
    });

    const result = await chat.sendMessage(text); // Send the current user's message
    const responseText = result.response.text();

    await storeMessage(sessionId, chatId, userId, "model", responseText, env);
    await sendTelegramMessage(chatId, responseText, env, 0, ctx);
  } catch (error) {
    console.error("Error in processUserMessage:", error);
    let errorMessage = "Sorry, I encountered an error processing your message.";
    if (error instanceof Error) {
      errorMessage += ` Details: ${error.message}`;
    }
    await sendTelegramMessage(chatId, errorMessage, env, 0, ctx);
  }
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
  let text = message.text.trim();

  if (text.startsWith('/')) {
    const parts = text.split(' ');
    const command = parts[0];
    if (command.includes('@')) {
      text = command.split('@')[0];
    }
  }

  // Handle /start command
  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      `Welcome! I'm your AI asap chat bot. Here are the available commands:

/ask <your question> - Ask me anything! (especially useful in groups)
/new - Start a new chat session
/history - Show current chat history
/help - Show this help message

Simply send any message to chat with me directly (in DMs)!`,
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

/ask <your question> - Ask me anything! (especially useful in groups)
/new - Start a new chat session
/history - Show current chat history
/help - Show this help message

Each chat session maintains its own history, allowing for contextual conversations. In DMs, you can also just send me a message directly without a command.`,
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
        "No chat history in current session. Start chatting or use /ask <your question>!",
        env,
        0,
        ctx
      );
      return;
    }

    const historyText = history
      .map(
        (msg) =>
          `*${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}*: ${
            msg.content
          }`
      ) // Capitalize role
      .join("\n\n---\n\n"); // Improved formatting

    await sendTelegramMessage(
      chatId,
      `📝 *Current Chat History*: (Session ID: ${sessionId})\n\n${historyText}`,
      env,
      0,
      ctx
    );
    return;
  }

  // Handle /ask command
  if (text.startsWith("/ask ")) {
    const question = text.substring(5).trim();
    if (question) {
      await processUserMessage(chatId, userId, question, env, ctx);
    } else {
      await sendTelegramMessage(
        chatId,
        "Please provide a question after /ask. Example: `/ask What is the capital of France?`",
        env,
        0,
        ctx
      );
    }
    return;
  }

  // If no command is matched, treat as a direct message to the AI
  // This is the part that needs to be careful in group chats.
  // For now, let's assume if it's not a command, it's a direct query.
  // We might need to check if the bot was mentioned in a group later.
  if (!text.startsWith("/")) {
    await processUserMessage(chatId, userId, text, env, ctx);
    return;
  }

  // If no known command is matched and it starts with /, send a default message.
  if (text.startsWith("/")) {
    await sendTelegramMessage(
      chatId,
      "Sorry, I didn't understand that command. Try /help for a list of commands.",
      env,
      5000, // Delete after 5 seconds
      ctx
    );
    return;
  }

  // Fallback for any other messages - though the above conditions should cover most.
  // The try-catch block for AI processing has been moved to processUserMessage
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
    if (request.method === "POST") {
      try {
        const update = (await request.json()) as TelegramUpdate;
        await handleTelegramUpdate(update, env, ctx);
        return new Response("OK", { status: 200 });
      } catch (e) {
        console.error(e);
        return new Response("Error processing request", { status: 500 });
      }
    }
    return router.handle(request, env, ctx);
  },
};
