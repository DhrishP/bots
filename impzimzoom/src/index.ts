import { Router } from "itty-router";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Update } from "node-telegram-bot-api";

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

interface TelegramResponse {
  ok: boolean;
  result: {
    message_id: number;
  };
}

// Helper function to encrypt text
async function encrypt(text: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const keyData = encoder.encode(key);

  // Generate a key from the password
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );

  // Generate encryption key
  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("salt"),
      iterations: 100000,
      hash: "SHA-256",
    },
    cryptoKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"]
  );

  // Generate IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt
  const encryptedContent = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    encryptionKey,
    data
  );

  // Combine IV and encrypted content
  const encryptedArray = new Uint8Array(
    iv.length + new Uint8Array(encryptedContent).length
  );
  encryptedArray.set(iv);
  encryptedArray.set(new Uint8Array(encryptedContent), iv.length);

  return btoa(String.fromCharCode(...encryptedArray));
}

// Helper function to decrypt text
async function decrypt(encryptedText: string, key: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const keyData = encoder.encode(key);

    // Convert base64 to array
    const encryptedArray = new Uint8Array(
      atob(encryptedText)
        .split("")
        .map((char) => char.charCodeAt(0))
    );

    // Extract IV and encrypted content
    const iv = encryptedArray.slice(0, 12);
    const encryptedContent = encryptedArray.slice(12);

    // Generate key from password
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "PBKDF2" },
      false,
      ["deriveBits", "deriveKey"]
    );

    // Generate decryption key
    const decryptionKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: encoder.encode("salt"),
        iterations: 100000,
        hash: "SHA-256",
      },
      cryptoKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["decrypt"]
    );

    // Decrypt
    const decryptedContent = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      decryptionKey,
      encryptedContent
    );

    return decoder.decode(decryptedContent);
  } catch (error) {
    throw new Error("Decryption failed. Wrong key?");
  }
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
      }),
    }
  );

  const result = (await response.json()) as TelegramResponse;

  if (result.ok && deleteAfter > 0) {
    ctx.waitUntil(
      new Promise<void>((resolve) => {
        setTimeout(async () => {
          await deleteMessage(chatId, result.result.message_id, env);
          resolve();
        }, deleteAfter);
      })
    );
  }
}

// Helper function to delete messages
async function deleteMessage(chatId: number, messageId: number, env: Env) {
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    }
  );
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
      `👋 Welcome! I can help you store encrypted credentials and manage context.\n\nUse /help to see available commands.`,
      env,
      0,
      ctx
    );
    return;
  }

  // Handle /help command
  if (text === "/help") {
    const helpText = `Available commands:

🔐 Credentials Management:
/creds <title> <username> <password> - Store new credentials
/show <number> - Show decrypted credentials
/listcreds - List all stored credentials

📝 Context Management:
/context <text> - Store new context
/getcontext <prompt> - Get AI insights based on stored context
/listcontext - List all stored context entries

ℹ️ Other Commands:
/start - Start the bot
/help - Show this help message`;

    await sendTelegramMessage(chatId, helpText, env, 0, ctx);
    return;
  }

  // Handle /creds command
  if (text.startsWith("/creds ")) {
    const parts = text.split(" ");
    if (parts.length < 4) {
      await sendTelegramMessage(
        chatId,
        "❌ Usage: /creds <title> <username> <password>",
        env,
        5000,
        ctx
      );
      return;
    }

    // Extract title, username, and password
    const title = parts[1];
    const username = parts[2];
    const password = parts.slice(3).join(" ");

    // Ask for encryption key
    await sendTelegramMessage(
      chatId,
      "🔑 Please provide the encryption key (send as a separate message):",
      env,
      0,
      ctx
    );

    // Store temporary data in KV or similar storage
    // For this example, we'll use a simple global map
    pendingEncryption.set(`${chatId}-${userId}`, {
      title,
      username,
      password,
      timestamp: Date.now(),
    });

    return;
  }

  // Check for pending encryption
  const pendingData = pendingEncryption.get(`${chatId}-${userId}`);
  if (pendingData && Date.now() - pendingData.timestamp < 60000) {
    // 1 minute timeout
    try {
      const encryptedPassword = await encrypt(pendingData.password, text);

      await env.DB.prepare(
        "INSERT INTO credentials (chat_id, user_id, title, username, encrypted_password) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(
          chatId.toString(),
          userId,
          pendingData.title,
          pendingData.username,
          encryptedPassword
        )
        .run();

      pendingEncryption.delete(`${chatId}-${userId}`);

      await sendTelegramMessage(
        chatId,
        "✅ Credentials stored successfully!",
        env,
        5000,
        ctx
      );
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to store credentials.",
        env,
        5000,
        ctx
      );
    }
    return;
  }

  // Handle /show command
  if (text.startsWith("/show ")) {
    const credId = parseInt(text.split(" ")[1]);
    if (isNaN(credId)) {
      await sendTelegramMessage(
        chatId,
        "❌ Please provide a valid credential number.",
        env,
        5000,
        ctx
      );
      return;
    }

    const cred = await env.DB.prepare(
      "SELECT * FROM credentials WHERE chat_id = ? AND user_id = ? AND id = ?"
    )
      .bind(chatId.toString(), userId, credId)
      .first();

    if (!cred) {
      await sendTelegramMessage(
        chatId,
        "❌ Credential not found.",
        env,
        5000,
        ctx
      );
      return;
    }

    await sendTelegramMessage(
      chatId,
      "🔑 Please provide the decryption key:",
      env,
      5000,
      ctx
    );

    pendingDecryption.set(`${chatId}-${userId}`, {
      credId,
      encryptedPassword: cred.encrypted_password,
      timestamp: Date.now(),
    });

    return;
  }

  // Check for pending decryption
  const pendingDecryptData = pendingDecryption.get(`${chatId}-${userId}`);
  if (pendingDecryptData && Date.now() - pendingDecryptData.timestamp < 60000) {
    try {
      const decryptedPassword = await decrypt(
        pendingDecryptData.encryptedPassword,
        text
      );

      const cred = await env.DB.prepare(
        "SELECT * FROM credentials WHERE chat_id = ? AND user_id = ? AND id = ?"
      )
        .bind(chatId.toString(), userId, pendingDecryptData.credId)
        .first();

      pendingDecryption.delete(`${chatId}-${userId}`);

      await sendTelegramMessage(
        chatId,
        `🔐 Credential Details:\nTitle: ${cred?.title}\nUsername: ${cred?.username}\nPassword: ${decryptedPassword}`,
        env,
        30000,
        ctx
      );
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Decryption failed. Wrong key?",
        env,
        5000,
        ctx
      );
    }
    return;
  }

  // Handle /context command
  if (text.startsWith("/context ")) {
    const contextText = text.slice(9);
    try {
      await env.DB.prepare(
        "INSERT INTO contexts (chat_id, user_id, content) VALUES (?, ?, ?)"
      )
        .bind(chatId.toString(), userId, contextText)
        .run();

      await sendTelegramMessage(
        chatId,
        "✅ Context stored successfully!",
        env,
        5000,
        ctx
      );
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to store context.",
        env,
        5000,
        ctx
      );
    }
    return;
  }

  // Handle /getcontext command
  if (text.startsWith("/getcontext ")) {
    const prompt = text.slice(11);
    try {
      const contexts = await env.DB.prepare(
        "SELECT content FROM contexts WHERE chat_id = ? AND user_id = ?"
      )
        .bind(chatId.toString(), userId)
        .all();

      if (!contexts.results?.length) {
        await sendTelegramMessage(
          chatId,
          "❌ No context found. Please add some context first using /context command.",
          env,
          5000,
          ctx
        );
        return;
      }

      const contextText = contexts.results
        .map((c: any) => c.content)
        .join("\n");

      // Initialize Gemini AI - Updated implementation
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const combinedPrompt = `Context:\n${contextText}\n\nPrompt: ${prompt}\n\nPlease provide insights based on the given context.`;
      const result = await model.generateContent(combinedPrompt);
      const response = result.response.text();

      await sendTelegramMessage(chatId, response, env, 0, ctx);
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to process context with AI.",
        env,
        5000,
        ctx
      );
    }
    return;
  }

  // Handle /listcreds command
  if (text === "/listcreds") {
    try {
      const creds = await env.DB.prepare(
        "SELECT id, title, username FROM credentials WHERE user_id = ? ORDER BY id"
      )
        .bind(userId)
        .all();

      if (!creds.results?.length) {
        await sendTelegramMessage(
          chatId,
          "📭 No credentials stored yet.",
          env,
          5000,
          ctx
        );
        return;
      }

      const credList = creds.results
        .map((cred: any) => `${cred.id}. ${cred.title} (${cred.username})`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `🔐 Your stored credentials:\n${credList}\n\nUse /show <number> to view details.`,
        env,
        5000,
        ctx
      );
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to fetch credentials.",
        env,
        5000,
        ctx
      );
    }
    return;
  }

  // Handle /listcontext command
  if (text === "/listcontext") {
    try {
      const contexts = await env.DB.prepare(
        "SELECT content FROM contexts WHERE chat_id = ? AND user_id = ? ORDER BY created_at DESC"
      )
        .bind(chatId.toString(), userId)
        .all();

      if (!contexts.results?.length) {
        await sendTelegramMessage(
          chatId,
          "📭 No context stored yet.",
          env,
          5000,
          ctx
        );
        return;
      }

      const contextList = contexts.results
        .map((ctx: any) => `• ${ctx.content}`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `📝 Your stored context:\n${contextList}`,
        env,
        5000,
        ctx
      );
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to fetch context.",
        env,
        5000,
        ctx
      );
    }
    return;
  }
}

// Global maps for pending operations
const pendingEncryption = new Map();
const pendingDecryption = new Map();

// Router setup
const router = Router();

// Add a root route handler
router.get("/", () => new Response("Bot is running!", { status: 200 }));

// Add webhook route
router.post(
  "/webhook",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    const update: TelegramUpdate = await request.json();
    await handleTelegramUpdate(update, env, ctx);
    return new Response("OK", { status: 200 });
  }
);

// Must be after all other routes
router.all("*", () => new Response("Not Found", { status: 404 }));

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (request.method === "POST") {
      try {
        const payload = (await request.json()) as Update;
        // Pass the context to handleUpdate
        return await handleUpdate(payload, env, ctx);
      } catch (e) {
        console.error(e);
        return new Response("Error processing request", { status: 500 });
      }
    }
    return new Response("OK", { status: 200 });
  },
};

// Add handleUpdate function
async function handleUpdate(
  update: Update,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!update.message?.text) {
    return new Response("OK", { status: 200 });
  }

  try {
    await handleTelegramUpdate(update, env, ctx);
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("Error handling command", { status: 500 });
  }
}
