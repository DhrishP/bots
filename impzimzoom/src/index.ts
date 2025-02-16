import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Update } from "node-telegram-bot-api";
import { credentials, contexts } from "./schema";
import { eq, and } from "drizzle-orm";
import { db } from "./db";
import * as dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

export interface Env {
  DATABASE_URL: string;
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
    console.error(error);
    throw new Error("Decryption failed. Wrong key?");
  }
}

// Helper function to send Telegram messages
async function sendTelegramMessage(
  chatId: number,
  text: string,
  env: Env,
  deleteAfter: number = 0
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
    setTimeout(async () => {
      await deleteMessage(chatId, result.result.message_id, env);
    }, deleteAfter);
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
async function handleTelegramUpdate(update: TelegramUpdate, env: Env) {
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
      0
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
/context <title> <content> - Store new context
/getcontext <title> - Get AI insights based on stored context
/listcontext [search] - List all stored context entries (optionally filter by title)

ℹ️ Other Commands:
/start - Start the bot
/help - Show this help message`;

    await sendTelegramMessage(chatId, helpText, env, 0);
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
        5000
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
      0
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

      await db
        .insert(credentials)
        .values({
          chatId: chatId.toString(),
          userId,
          title: pendingData.title,
          username: pendingData.username,
          encryptedPassword,
        })
        .returning({ id: credentials.id })
        .execute();

      pendingEncryption.delete(`${chatId}-${userId}`);

      await sendTelegramMessage(
        chatId,
        "✅ Credentials stored successfully!",
        env,
        5000
      );
    } catch (error) {
      console.error(error);
      await sendTelegramMessage(
        chatId,
        "❌ Failed to store credentials.",
        env,
        5000
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
        5000
      );
      return;
    }

    const credResult = await db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.chatId, chatId.toString()),
          eq(credentials.userId, userId),
          eq(credentials.id, credId)
        )
      );

    const cred = credResult[0]; // Get first result
    if (!cred) {
      await sendTelegramMessage(chatId, "❌ Credential not found.", env, 5000);
      return;
    }

    await sendTelegramMessage(
      chatId,
      "🔑 Please provide the decryption key:",
      env,
      5000
    );
    await db.insert(credentials).values({
      chatId: chatId.toString(),
      userId,
      title: cred.title,
      username: cred.username,
      encryptedPassword: cred.encryptedPassword,
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

      const credResult = await db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.chatId, chatId.toString()),
            eq(credentials.userId, userId),
            eq(credentials.id, pendingDecryptData.credId)
          )
        );
      const cred = credResult[0];

      pendingDecryption.delete(`${chatId}-${userId}`);

      await sendTelegramMessage(
        chatId,
        `🔐 Credential Details:\nTitle: ${cred?.title}\nUsername: ${cred?.username}\nPassword: ${decryptedPassword}`,
        env,
        30000
      );
    } catch (error) {
      console.error(error);
      await sendTelegramMessage(
        chatId,
        "❌ Decryption failed. Wrong key?",
        env,
        5000
      );
    }
    return;
  }

  // Handle /context command
  if (text.startsWith("/context ")) {
    const parts = text.split(" ");
    if (parts.length < 3) {
      await sendTelegramMessage(
        chatId,
        "❌ Usage: /context <title> <content>",
        env,
        5000
      );
      return;
    }

    const title = parts[1];
    const contextText = parts.slice(2).join(" ");
    try {
      await db
        .insert(contexts)
        .values({
          chatId: chatId.toString(),
          userId,
          title,
          content: contextText,
          embedding: [],
        })
        .returning({ id: contexts.id })
        .execute();

      await sendTelegramMessage(
        chatId,
        "✅ Context stored successfully!",
        env,
        5000
      );
    } catch (error) {
      console.error(error);
      await sendTelegramMessage(
        chatId,
        "❌ Failed to store context.",
        env,
        5000
      );
    }
    return;
  }

  // Handle /getcontext command
  if (text.startsWith("/getcontext ")) {
    const prompt = text.slice(11);
    try {
      const contextResults = await db
        .select()
        .from(contexts)
        .where(
          and(
            eq(contexts.chatId, chatId.toString()),
            eq(contexts.userId, userId)
          )
        );

      if (!contextResults.length) {
        await sendTelegramMessage(
          chatId,
          "❌ No context found. Please add some context first using /context command.",
          env,
          5000
        );
        return;
      }

      const contextText = contextResults.map((c: any) => c.content).join("\n");

      // Initialize Gemini AI - Updated implementation
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const combinedPrompt = `Context:\n${contextText}\n\nPrompt: ${prompt}\n\nPlease provide insights based on the given context.`;
      const result = await model.generateContent(combinedPrompt);
      const response = result.response.text();

      await sendTelegramMessage(chatId, response, env, 0);
    } catch (error) {
      console.error(error);
      await sendTelegramMessage(
        chatId,
        "❌ Failed to process context with AI.",
        env,
        5000
      );
    }
    return;
  }

  // Handle /listcreds command
  if (text === "/listcreds") {
    try {
      const creds = await db
        .select()
        .from(credentials)
        .where(eq(credentials.userId, userId))
        .orderBy(credentials.id);

      if (!creds.length) {
        await sendTelegramMessage(
          chatId,
          "📭 No credentials stored yet.",
          env,
          5000
        );
        return;
      }

      const credList = creds
        .map((cred: any) => `${cred.id}. ${cred.title} (${cred.username})`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `🔐 Your stored credentials:\n${credList}\n\nUse /show <number> to view details.`,
        env,
        5000
      );
    } catch (error) {
      console.error(error);
      await sendTelegramMessage(
        chatId,
        "❌ Failed to fetch credentials.",
        env,
        5000
      );
    }
    return;
  }

  // Handle /listcontext command
  if (text.startsWith("/listcontext")) {
    try {
      const titleFilter = text.slice("/listcontext".length).trim();

      // Select content only if a filter is provided
      let query = titleFilter
        ? "SELECT title, content, created_at FROM contexts WHERE chat_id = ? AND user_id = ?"
        : "SELECT title, created_at FROM contexts WHERE chat_id = ? AND user_id = ?";

      let params = [chatId.toString(), userId];

      if (titleFilter) {
        query += " AND title LIKE ?";
        params.push(`%${titleFilter}%`);
      }

      query += " ORDER BY created_at DESC";

      const contextResults = await db
        .select()
        .from(contexts)
        .where(
          and(
            eq(contexts.chatId, chatId.toString()),
            eq(contexts.userId, userId)
          )
        );

      if (!contextResults.length) {
        const message = titleFilter
          ? `📭 No contexts found matching "${titleFilter}".`
          : "📭 No contexts stored yet.";
        await sendTelegramMessage(chatId, message, env, 5000);
        return;
      }

      const contextList = titleFilter
        ? contextResults
            .map((ctx: any) => `📌 ${ctx.title}\n${ctx.content}\n`)
            .join("\n")
        : contextResults.map((ctx: any) => `📌 ${ctx.title}`).join("\n");

      const message = titleFilter
        ? `📝 Contexts matching "${titleFilter}":\n${contextList}`
        : `📝 Your stored contexts:\n${contextList}\n\nUse /listcontext <title> to see the content of specific contexts.`;

      await sendTelegramMessage(chatId, message, env, 5000);
    } catch (error) {
      console.error(error);
      await sendTelegramMessage(
        chatId,
        "❌ Failed to fetch context.",
        env,
        5000
      );
    }
    return;
  }
}

// Global maps for pending operations
const pendingEncryption = new Map();
const pendingDecryption = new Map();

app.get("/", (req, res) => {
  res.status(200).send("Bot is running!");
});

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body as Update;
    await handleTelegramUpdate(update, {
      DATABASE_URL: process.env.DATABASE_URL!,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY!,
    });
    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("Error processing request");
  }
});

// Handle 404
app.use((req, res) => {
  res.status(404).send("Not Found");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
