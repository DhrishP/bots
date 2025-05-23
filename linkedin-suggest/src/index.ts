import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import { Router } from "itty-router";

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


interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

const LINKEDIN_CONTEXT = `
# NOTE : THESE ALL POST ARE JUST CONTEXT OF HOW I WANT MY LINKEIDN POSTS TO BE , DONT TAKE THE CONTEXT OF THE CONTENT BUT JUST THE STRUCTURE. MY FIELD OF POSTING IS MAINLY AI , REASONING , TECH RELATED TO WEB 
### POST ABOUT MCP
MCP (Model Context Protocol) is here to make your AI agents & Agentic applications even more powerful 💪  
...
## GOOD HOOK MEDIUM POST 

Buyers don't buy the way you think.  
...
This is your sign to start publishing content now.
`; // Truncated for brevity, includes the full context read earlier

// Helper function to send Telegram messages
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
      }),
    }
  );
}

// Generate suggestions using Vercel AI SDK
async function generateSuggestions(prompt: string, env: Env) {
  try {
    // Ensure GEMINI_API_KEY is available (though not directly used by Vercel SDK helper)
    if (!env.GEMINI_API_KEY) {
      console.error(
        "GEMINI_API_KEY is not configured in environment variables."
      );
      return ["API Key is missing. Cannot generate suggestions."];
    }
    const google = createGoogleGenerativeAI({
      apiKey: env.GEMINI_API_KEY,
    });

    const { object } = await generateObject({
      model: google("gemini-2.0-flash-001"), // Using google helper for Gemini
      schema: z.object({
        suggestions: z.array(z.string()).length(4),
      }),
      prompt: prompt,
    });
    // Ensure it returns an array even if generation fails partially
    return Array.isArray(object?.suggestions) ? object.suggestions : [];
  } catch (error) {
    console.error("Error generating suggestions:", error);
    // Provide a more informative error if possible
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return [`Sorry, I couldn't generate suggestions: ${errorMessage}`];
  }
}

// Handle /post command
async function handlePostCommand(
  chatId: number,
  text: string,
  env: Env,
  ctx: ExecutionContext
) {
  if (!text) {
    await sendTelegramMessage(
      chatId,
      "Please provide the topic for the LinkedIn post after the command, e.g., `/post Latest advancements in AI reasoning`",
      env,
      ctx
    );
    return;
  }

  // Construct the prompt incorporating the context and the user's topic
  const prompt = `Based on the following LinkedIn post examples and structure guidelines, generate 4 concise LinkedIn post suggestions about "${text}". Focus on AI, reasoning, or web tech topics. Use a professional but engaging tone, good hooks, and clear structure like the examples.

Context Examples:
${LINKEDIN_CONTEXT}

Generate 4 post suggestions about: "${text}"`;

  const suggestions = await generateSuggestions(prompt, env);

  if (suggestions.length > 0 && !suggestions[0].startsWith("Sorry")) {
    await sendTelegramMessage(
      chatId,
      `Here are 4 LinkedIn post suggestions for "${text}":`,
      env,
      ctx
    );
    for (const suggestion of suggestions) {
      // Add extra newline for readability between suggestions
      await sendTelegramMessage(chatId, suggestion + "\n--- \n", env, ctx);
    }
  } else {
    await sendTelegramMessage(
      chatId,
      suggestions[0] || "Failed to generate post suggestions.",
      env,
      ctx
    );
  }
}

// Handle /replies command
async function handleRepliesCommand(
  chatId: number,
  text: string, // This 'text' is the original post to reply to
  env: Env,
  ctx: ExecutionContext
) {
  if (!text) {
    await sendTelegramMessage(
      chatId,
      "Please provide the text of the LinkedIn post you want to reply to after the command, e.g., `/replies Fascinating article on AI ethics!`",
      env,
      ctx
    );
    return;
  }

  // Generic but relevant prompt for LinkedIn replies
  const prompt = `Generate 4 concise, professional, and engaging LinkedIn reply suggestions for the following post. The replies should add value, ask a question, or share a relevant perspective. Avoid generic replies.

Original Post: "${text}"`;

  const suggestions = await generateSuggestions(prompt, env);

  if (suggestions.length > 0 && !suggestions[0].startsWith("Sorry")) {
    await sendTelegramMessage(
      chatId,
      `Here are 4 reply suggestions for the post:`,
      env,
      ctx
    );
    for (const suggestion of suggestions) {
      // Add extra newline for readability between suggestions
      await sendTelegramMessage(chatId, suggestion + "\n--- \n", env, ctx);
    }
  } else {
    await sendTelegramMessage(
      chatId,
      suggestions[0] || "Failed to generate reply suggestions.",
      env,
      ctx
    );
  }
}

// Handle Telegram webhook updates
async function handleTelegramUpdate(
  update: TelegramUpdate,
  env: Env,
  ctx: ExecutionContext
) {
  const message = update?.message;
  if (!message?.text || !message?.chat?.id || !message?.from?.id) {
    console.log("Ignoring update with missing data:", update);
    return;
  }

  const chatId = message.chat.id;
  // const userId = message.from.id; // Keep if needed later
  const fullText = message.text.trim();

  // Simple command parsing
  const commandMatch = fullText.match(/^\/(\w+)(?:\s+(.*))?$/s); // Added 's' flag for multiline text

  if (!commandMatch) {
    await sendTelegramMessage(
      chatId,
      "Please use `/post <topic>` for LinkedIn post ideas or `/replies <original post text>` for reply suggestions.",
      env,
      ctx
    );
    return;
  }

  const command = commandMatch[1].toLowerCase();
  const text = commandMatch[2] ? commandMatch[2].trim() : "";

  try {
    if (command === "post") {
      await handlePostCommand(chatId, text, env, ctx);
    } else if (command === "replies") {
      await handleRepliesCommand(chatId, text, env, ctx);
    } else {
      await sendTelegramMessage(
        chatId,
        `Unknown command: /${command}. Use /post or /replies.`, // Simplified message
        env,
        ctx
      );
    }
  } catch (error) {
    console.error(`Error handling /${command} command:`, error);
    await sendTelegramMessage(
      chatId,
      "Sorry, an error occurred while processing your command.", // Simplified error
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
    ctx.waitUntil(handleTelegramUpdate(update, env, ctx));
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
        const update: TelegramUpdate = await request.json();
        ctx.waitUntil(handleTelegramUpdate(update, env, ctx));
        return new Response("OK", { status: 200 });
      } catch (e) {
        console.error("Error parsing webhook:", e);
        return new Response("Error processing request", { status: 500 });
      }
    }
    return router.handle(request, env, ctx);
  },
};
