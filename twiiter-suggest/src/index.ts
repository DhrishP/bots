import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import { Router } from "itty-router";
import { GoogleGenerativeAI } from "@google/generative-ai";

interface Env {
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

// Helper function to send Telegram messages (no types)
async function sendTelegramMessage(
  chatId: number,
  text: string,
  env: Env,
  ctx: ExecutionContext
) {
  await fetch(
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
}

// Generate suggestions using Vercel AI SDK (no types)
async function generateSuggestions(prompt: string, env: Env, chatId: number, ctx: ExecutionContext) {
  try {
    console.log(env.GEMINI_API_KEY, "key");
    const google = createGoogleGenerativeAI({
      apiKey: env.GEMINI_API_KEY,
    });
    const { object } = await generateObject({
      model: google("gemini-2.0-flash-001"),
      schema: z.object({
        suggestions: z.array(z.string()).length(4),
      }),
      prompt: prompt,
    });
    console.log(object);
    // Ensure it returns an array even if generation fails partially
    return Array.isArray(object?.suggestions) ? object.suggestions : [];
  } catch (error:any) {
    console.log(error);
    console.error("Error generating suggestions:", error);
    sendTelegramMessage(chatId, error?.message, env, ctx);
    return ["Sorry, I couldn't generate suggestions right now."];
  }
}

// Handle /post command (no types)
async function handlePostCommand(
  chatId: number,
  text: string,
  env: Env,
  ctx: ExecutionContext
) {
  if (!text) {
    await sendTelegramMessage(
      chatId,
      "Please provide the topic for the post after the command, e.g., `/post My amazing new project`",
      env,
      ctx
    );
    return;
  }
  console.log(env, "env");
  const prompt = `Generate 4 concise Twitter post suggestions based on this topic: "${text}"`;
  const suggestions = await generateSuggestions(prompt, env ,chatId, ctx);
  console.log("here");
  if (suggestions.length > 0) {
    await sendTelegramMessage(
      chatId,
      `Here are 4 post suggestions for "${text}":`,
      env,
      ctx
    );
    console.log(suggestions);
    for (const suggestion of suggestions) {
      await sendTelegramMessage(chatId, suggestion, env, ctx);
      // Optional delay
      // await new Promise(resolve => setTimeout(resolve, 200));
    }
  } else {
    // Handle case where suggestions array is empty or contains error message
    await sendTelegramMessage(
      chatId,
      suggestions[0] || "Failed to generate suggestions.",
      env,
      ctx
    );
  }
}

// Handle /replies command (no types)
async function handleRepliesCommand(
  chatId: number,
  text: string,
  env: Env,
  ctx: ExecutionContext
) {
  if (!text) {
    await sendTelegramMessage(
      chatId,
      "Please provide the tweet text to reply to after the command, e.g., `/replies Check out this cool AI!`",
      env,
      ctx
    );
    return;
  }

  const prompt = `Generate 4 concise Twitter reply suggestions for this tweet: "${text}"`;
  const suggestions = await generateSuggestions(prompt, env, chatId, ctx);

  if (
    suggestions.length > 0 &&
    suggestions[0] !== "Sorry, I couldn't generate suggestions right now."
  ) {
    await sendTelegramMessage(
      chatId,
      `Here are 4 reply suggestions for the tweet:`,
      env,
      ctx
    );
    console.log(suggestions);
    for (const suggestion of suggestions) {
      await sendTelegramMessage(chatId, suggestion, env, ctx);
      // Optional delay
      // await new Promise(resolve => setTimeout(resolve, 200));
    }
  } else {
    // Handle case where suggestions array is empty or contains error message
    await sendTelegramMessage(
      chatId,
      suggestions[0] || "Failed to generate suggestions.",
      env,
      ctx
    );
  }
}

// Handle Telegram webhook updates (no types)
async function handleTelegramUpdate(
  update: TelegramUpdate,
  env: Env,
  ctx: ExecutionContext
) {
  const message = update?.message;
  // Add more robust check for message structure
  if (!message?.text || !message?.chat?.id || !message?.from?.id) {
    console.log("Ignoring update with missing data:", update);
    return;
  }
  console.log(message, "message");

  const chatId = message.chat.id;
  const userId = message.from.id;
  const fullText = message.text.trim();

  const commandMatch = fullText.match(/^\/(\w+)(?:\s+(.*))?$/);

  if (!commandMatch) {
    await sendTelegramMessage(
      chatId,
      "Please use `/post <topic>` or `/replies <tweet>`.",
      env,
      ctx
    );
    return;
  }

  const command = commandMatch[1].toLowerCase(); // Normalize command
  const text = commandMatch[2] ? commandMatch[2].trim() : "";

  try {
    if (command === "post") {
      console.log("here2");
      await handlePostCommand(chatId, text, env, ctx);
    } else if (command === "replies") {
      console.log("here3");
      await handleRepliesCommand(chatId, text, env, ctx);
    } else {
      await sendTelegramMessage(
        chatId,
        `Unknown command: /${command}. Please use /post or /replies.`,
        env,
        ctx
      );
    }
  } catch (error) {
    console.error(`Error handling /${command} command:`, error);
    await sendTelegramMessage(
      chatId,
      "Sorry, I encountered an error processing your command.",
      env,
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
    // Log entry point
    console.log(
      `[${new Date().toISOString()}] Received request: ${request.method} ${
        request.url
      }`
    );
    console.log("[FETCH HANDLER] Request received.");

    // Handle POST requests directly (like ai-asap)
    if (request.method === "POST") {
      let update: TelegramUpdate | null = null;
      try {
        console.log("[FETCH HANDLER] Attempting to parse JSON body...");
        update = (await request.json()) as TelegramUpdate;
        console.log("[FETCH HANDLER] JSON body parsed successfully:", update);
        await handleTelegramUpdate(update, env, ctx);
        return new Response("OK", { status: 200 });
      } catch (e) {
        console.error("[FETCH HANDLER] Error processing POST request:", e);
        try {
          const rawBody = await request.text();
          console.error(
            "[FETCH HANDLER] Raw request body (potential parsing issue):",
            rawBody.substring(0, 500)
          );
        } catch (bodyError) {
          console.error(
            "[FETCH HANDLER] Could not read request body text:",
            bodyError
          );
        }

        const errorMessage =
          e instanceof Error
            ? e.message
            : "An unknown error occurred during POST processing";
        return new Response(`Error processing request: ${errorMessage}`, {
          status: 500,
        });
      }
    }

    // Delegate non-POST requests (e.g., GET /) to the router
    try {
      return await router.handle(request, env, ctx);
    } catch (error) {
      console.error("Router or handler error (non-POST):", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unknown error occurred via router";
      return new Response(`Internal Server Error: ${errorMessage}`, {
        status: 500,
      });
    }
  },
};
