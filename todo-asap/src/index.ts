import { Router } from "itty-router";
import { Update } from "node-telegram-bot-api";

interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  API_SECRET: string;
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

const router = Router();

// Helper function to check if text is just a solo link (no other text)
function isSoloLink(text: string): boolean {
  const trimmed = text.trim();
  // Check if the entire text is just a URL (with optional whitespace)
  const urlPattern = /^https?:\/\/[^\s]+$/;
  return urlPattern.test(trimmed);
}

// Helper function to extract domain name from URL
function getDomainName(url: string): string {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname;
    
    // Remove www. prefix
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    
    // Extract main domain (e.g., youtube.com, dev.to)
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      // For domains like youtube.com, return "YouTube"
      const domain = parts[parts.length - 2] + '.' + parts[parts.length - 1];
      // Capitalize first letter
      const domainName = domain.split('.')[0];
      return domainName.charAt(0).toUpperCase() + domainName.slice(1);
    }
    
    return hostname;
  } catch (e) {
    // Fallback: try to extract from URL string
    const match = url.match(/https?:\/\/(?:www\.)?([^\/]+)/);
    if (match && match[1]) {
      const hostname = match[1].split('.')[0];
      return hostname.charAt(0).toUpperCase() + hostname.slice(1);
    }
    return "Link";
  }
}

// Helper function to format links in markdown
async function formatTaskWithMarkdown(task: string): Promise<string> {
  // Check if the task already contains markdown links (format: [text](url))
  const markdownLinkPattern = /\[([^\]]+)\]\(https?:\/\/[^\)]+\)/g;
  const existingMarkdownLinks = task.match(markdownLinkPattern);
  
  // If markdown links already exist, extract their URLs to avoid double-formatting
  const alreadyFormattedUrls = new Set<string>();
  if (existingMarkdownLinks) {
    existingMarkdownLinks.forEach(link => {
      const urlMatch = link.match(/\(https?:\/\/[^\)]+\)/);
      if (urlMatch) {
        const url = urlMatch[0].slice(1, -1); // Remove parentheses
        alreadyFormattedUrls.add(url);
      }
    });
  }
  
  // Pattern to match URLs (but not those already in markdown format)
  const urlPattern = /(https?:\/\/[^\s\)]+)/g;
  const urls = task.match(urlPattern);
  
  if (!urls) {
    return task; // No URLs found, return as is
  }
  
  let formattedTask = task;
  
  for (const url of urls) {
    // Skip if already formatted as markdown link
    if (alreadyFormattedUrls.has(url)) {
      continue;
    }
    
    let linkText = url;
    
    // Check if it's a Twitter/X link
    if (url.includes('x.com/') || url.includes('twitter.com/')) {
      // Check if there's text before the URL (from browser extension)
      const urlIndex = formattedTask.indexOf(url);
      if (urlIndex > 0) {
        const textBefore = formattedTask.substring(0, urlIndex).trim();
        // If there's meaningful text before the URL, format as [text](url)
        if (textBefore.length > 0 && !textBefore.endsWith('[') && !textBefore.match(/\[.*\]\(/)) {
          // Escape markdown in the text before
          const escapedText = textBefore
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/_/g, '\\_')
            .replace(/\*/g, '\\*')
            .replace(/`/g, '\\`');
          linkText = `[${escapedText}](${url})`;
          // Replace both the text and URL with the formatted link
          const textAndUrl = formattedTask.substring(0, urlIndex + url.length);
          formattedTask = formattedTask.replace(textAndUrl, linkText);
          continue; // Skip the normal replacement since we already did it
        } else {
          // No text before, just use domain name
          linkText = `[X](${url})`;
        }
      } else {
        linkText = `[X](${url})`;
      }
    }
    // Check if it's a ChatGPT link
    else if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
      linkText = `[ChatGPT](${url})`;
    }
    // For all other URLs, use domain name as link text (no title fetching)
    else {
      const domainName = getDomainName(url);
      linkText = `[${domainName}](${url})`;
    }
    
    // Replace the URL in the task text with the formatted link
    // Escape special regex characters in URL
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Replace only the first occurrence to avoid replacing URLs that are part of markdown links
    formattedTask = formattedTask.replace(escapedUrl, linkText);
  }
  
  return formattedTask;
}

// Helper function to send Telegram messages
async function sendTelegramMessage(
  chatId: number,
  text: string,
  env: Env,
  deleteAfter: number = 0,
  ctx: ExecutionContext,
  parseMode: "Markdown" | "MarkdownV2" | "HTML" | null = "Markdown",
  disableWebPagePreview: boolean = true
) {
  console.log("chatId", chatId);
  const payload: any = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: disableWebPagePreview,
  };
  
  if (parseMode) {
    payload.parse_mode = parseMode;
  }
  
  let response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  let result = (await response.json()) as any;
  
  // If sending failed (likely due to markdown parse error), try without parse_mode
  if (!result.ok && payload.parse_mode) {
    console.warn("Retrying without parse_mode due to error:", result.description);
    delete payload.parse_mode;
    response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    result = (await response.json()) as any;
  }

  if (result.ok && deleteAfter > 0) {
    // Schedule message deletion using waitUntil
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

// New helper function to delete messages
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

// Helper function for reordering tasks
async function reorderTasks(chatId: string, userId: number, env: Env) {
  await env.DB.prepare(
    `UPDATE todos 
     SET task_order = (
       SELECT COUNT(*) + 1 
       FROM todos t2 
       WHERE t2.chat_id = todos.chat_id 
       AND t2.user_id = todos.user_id 
       AND t2.is_done = FALSE 
       AND t2.task_order < todos.task_order
     )
     WHERE chat_id = ? 
     AND user_id = ? 
     AND is_done = FALSE`
  )
    .bind(chatId, userId)
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
  let text = message.text.trim();

  text = text.replace(/\s+/g, ' ');

  if (text.startsWith('/')) {
    const parts = text.split(' ');
    const command = parts[0];
    if (command.includes('@')) {
      text = command.split('@')[0];
    }
  }

  // Handle /chatid command
  if (text === "/chatid") {
    await sendTelegramMessage(
      chatId,
      `🆔 Chat ID: \`${chatId}\`\n👤 User ID: \`${userId}\``,
      env,
      60000, // 1 min
      ctx
    );
    return;
  }

      // Handle /start command
  if (text === "/start") {
    await sendTelegramMessage(
      chatId,
      `👋 Welcome to todo Asap! Any text you add will become a task.\n\nUse /help to see available commands.`,
      env,
      10000, // Delete after 10s
      ctx
    );
    return;
  }

  // Handle /top command - move task to position 1 (top of mind)
  if (text.startsWith("/top ")) {
    const taskNumber = parseInt(text.split(" ")[1]);
    try {
      const task = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND task_order = ? AND is_done = FALSE"
      )
        .bind(chatId.toString(), userId, taskNumber)
        .first();

      if (!task) {
        await sendTelegramMessage(
          chatId,
          "❌ Invalid task number.",
          env,
          5000,
          ctx
        );
        return;
      }

      // If already at top, do nothing
      if (task.task_order === 1) {
        await sendTelegramMessage(
          chatId,
          "✅ Task is already at the top.",
          env,
          5000,
          ctx
        );
        return;
      }

      // Shift all tasks that are currently above this one (1 to taskNumber-1) down by 1
      await env.DB.prepare(
        "UPDATE todos SET task_order = task_order + 1 WHERE chat_id = ? AND user_id = ? AND is_done = FALSE AND task_order < ?"
      )
        .bind(chatId.toString(), userId, taskNumber)
        .run();

      // Move this task to position 1
      await env.DB.prepare("UPDATE todos SET task_order = 1 WHERE id = ?")
        .bind(task.id)
        .run();

      // Reorder to close any gaps and normalize
      await reorderTasks(chatId.toString(), userId, env);

      const formattedTask = await formatTaskWithMarkdown(String(task.task));
      await sendTelegramMessage(
        chatId,
        `🚀 Rescued to top: "${formattedTask}"`,
        env,
        3000, // 3s
        ctx
      );
      return;
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to move task.",
        env,
        5000,
        ctx
      );
      return;
    }
  }

  // Handle /done command (updated task_order)
  if (text.startsWith("/done ")) {
    const taskNumber = parseInt(text.split(" ")[1]);
    try {
      const task = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND task_order = ? AND is_done = FALSE"
      )
        .bind(chatId.toString(), userId, taskNumber)
        .first();

      if (!task) {
        await sendTelegramMessage(
          chatId,
          "❌ Invalid task number.",
          env,
          5000,
          ctx
        );
        return;
      }

      // First, mark the task as done
      await env.DB.prepare("UPDATE todos SET is_done = TRUE WHERE id = ?")
        .bind(task.id)
        .run();

      // Then reorder remaining active tasks
      await env.DB.prepare(
        `UPDATE todos 
         SET task_order = (
           SELECT COUNT(*) + 1 
           FROM todos t2 
           WHERE t2.chat_id = todos.chat_id 
           AND t2.user_id = todos.user_id 
           AND t2.is_done = FALSE 
           AND t2.task_order < todos.task_order
         )
         WHERE chat_id = ? 
         AND user_id = ? 
         AND is_done = FALSE`
      )
        .bind(chatId.toString(), userId)
        .run();

      const formattedTask = await formatTaskWithMarkdown(String(task.task));
      await sendTelegramMessage(
        chatId,
        `✅ Completed task #${taskNumber}: "${formattedTask}"`,
        env,
        3000, // 3s
        ctx
      );
      
      // Automatically call /list after completion
      await new Promise(resolve => setTimeout(resolve, 500)); // Small delay
      
      // Reorder tasks
      await reorderTasks(chatId.toString(), userId, env);

      const todos = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND is_done = FALSE ORDER BY task_order DESC"
      )
        .bind(chatId.toString(), userId)
        .all();

      if (todos.results?.length) {
        const taskListPromises = todos.results.map(async (todo: any) => {
          const formattedTask = await formatTaskWithMarkdown(todo.task);
          return `${todo.task_order}. ${formattedTask}`;
        });
        
        const taskList = (await Promise.all(taskListPromises)).join("\n");

        await sendTelegramMessage(
          chatId,
          `📋 Your tasks:\n${taskList}`,
          env,
          60000, // 1 min for list
          ctx
        );
      }
      return;
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to mark task as done.",
        env,
        5000,
        ctx
      );
      return;
    }
  }

  if (text === "/smallwins") {
    try {
      const wins = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND is_done = TRUE ORDER BY created_at DESC"
      )
        .bind(chatId.toString(), userId)
        .all();

      if (!wins.results?.length) {
        await sendTelegramMessage(
          chatId,
          "📭 No completed tasks yet. Keep going!",
          env,
          5000,
          ctx
        );
        return;
      }

      const winsListPromises = wins.results.map(async (todo: any) => {
        const formattedTask = await formatTaskWithMarkdown(todo.task);
        return `• ${formattedTask}`;
      });
      
      const winsList = (await Promise.all(winsListPromises)).join("\n");

      await sendTelegramMessage(
        chatId,
        `🎉 Your completed tasks:\n${winsList}`,
        env,
        60000, // 1 min for list
        ctx
      );
      return;
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to fetch completed tasks.",
        env,
        5000,
        ctx
      );
      return;
    }
  }

  // Handle /list command
  if (text === "/list") {
    try {
      // First reorder tasks
      await reorderTasks(chatId.toString(), userId, env);

      const todos = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND is_done = FALSE ORDER BY task_order DESC"
      )
        .bind(chatId.toString(), userId)
        .all();

      if (!todos.results?.length) {
        await sendTelegramMessage(
          chatId,
          "📭 No pending tasks. Add some tasks!",
          env,
          50000,
          ctx
        );
        return;
      }

      // Format each task with markdown links
      const taskListPromises = todos.results.map(async (todo: any) => {
        const formattedTask = await formatTaskWithMarkdown(todo.task);
        return `${todo.task_order}. ${formattedTask}`;
      });
      
      const taskList = (await Promise.all(taskListPromises)).join("\n");

      await sendTelegramMessage(
        chatId,
        `📋 Your tasks:\n${taskList}`,
        env,
        60000, // 1 min for list
        ctx
      );
      return;
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to fetch tasks.",
        env,
        5000,
        ctx
      );
      return;
    }
  }

  // Handle /delete command
  if (text.startsWith("/delete")) {
    const taskNumber = parseInt(text.split(" ")[1]);
    try {
      const task = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND task_order = ? AND is_done = FALSE"
      )
        .bind(chatId.toString(), userId, taskNumber)
        .first();

      if (!task) {
        await sendTelegramMessage(
          chatId,
          "❌ Invalid task number or task already completed.",
          env,
          5000,
          ctx
        );
        return;
      }

      await env.DB.prepare(
        "DELETE FROM todos WHERE chat_id = ? AND user_id = ? AND task_order = ? AND is_done = FALSE"
      )
        .bind(chatId.toString(), userId, taskNumber)
        .run();

      // Reorder remaining active tasks
      await env.DB.prepare(
        `UPDATE todos 
         SET task_order = task_order - 1 
         WHERE chat_id = ? AND user_id = ? AND task_order > ? AND is_done = FALSE`
      )
        .bind(chatId.toString(), userId, taskNumber)
        .run();

      const formattedTask = await formatTaskWithMarkdown(String(task.task));
      await sendTelegramMessage(
        chatId,
        `🗑️ Deleted task #${taskNumber}: "${formattedTask}"`,
        env,
        3000, // 3s
        ctx
      );
      
      // Automatically call /list after deletion
      await new Promise(resolve => setTimeout(resolve, 500)); // Small delay
      
      // Reorder tasks
      await reorderTasks(chatId.toString(), userId, env);

      const todos = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND is_done = FALSE ORDER BY task_order DESC"
      )
        .bind(chatId.toString(), userId)
        .all();

      if (todos.results?.length) {
        const taskListPromises = todos.results.map(async (todo: any) => {
          const formattedTask = await formatTaskWithMarkdown(todo.task);
          return `${todo.task_order}. ${formattedTask}`;
        });
        
        const taskList = (await Promise.all(taskListPromises)).join("\n");

        await sendTelegramMessage(
          chatId,
          `📋 Your tasks:\n${taskList}`,
          env,
          60000, // 1 min for list
          ctx
        );
      } else {
        await sendTelegramMessage(
          chatId,
          "📭 No pending tasks. Add some tasks!",
          env,
          50000,
          ctx
        );
      }
      return;
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to delete task.",
        env,
        5000,
        ctx
      );
      return;
    }
  }

  // New /reorder command
  if (text === "/reorder") {
    try {
      await env.DB.prepare(
        `UPDATE todos 
         SET task_order = (
           SELECT COUNT(*) + 1 
           FROM todos t2 
           WHERE t2.chat_id = todos.chat_id 
           AND t2.user_id = todos.user_id 
           AND t2.is_done = FALSE 
           AND t2.task_order < todos.task_order
         )
         WHERE chat_id = ? 
         AND user_id = ? 
         AND is_done = FALSE`
      )
        .bind(chatId.toString(), userId)
        .run();

      await sendTelegramMessage(
        chatId,
        "🔢 Task order has been reorganized! Use /list to see the new order.",
        env,
        3000, // 3s
        ctx
      );
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to reorganize tasks.",
        env,
        5000,
        ctx
      );
    }
    return;
  }

  if (text === "/help") {
    const helpText = `📝 Available commands:
/start - 🎉 Initialize the bot
/add <task> - ➕ Add a new task
/addshort <text> - ✂️ Add a task with only first few characters
/top <number> - 🚀 Move task to #1 (Top of Mind)
/done <number> - ✅ Mark task as completed
/list - 📋 Show pending tasks
/smallwins - 🎉 Show completed tasks
/delete <number> - 🗑️ Delete a task
/reorder - 🔄 Fix task numbering gaps
/chatid - 🆔 Get your Chat & User ID
/dall - 🧹 Delete all pending tasks
/help - ℹ️ Show this help

📱 Examples:
Buy groceries
/done 1
/top 5`;
    await sendTelegramMessage(chatId, helpText, env, 60000, ctx); // 1 min for help
    return;
  }

  if (text === "/dall") {
    try {
      // Delete only pending tasks for this user
      await env.DB.prepare(
        "DELETE FROM todos WHERE chat_id = ? AND user_id = ? AND is_done = FALSE"
      )
        .bind(chatId.toString(), userId)
        .run();

      await sendTelegramMessage(
        chatId,
        "🧹 All your pending tasks in this chat have been deleted! Completed tasks remain in /smallwins.",
        env,
        3000, // 3s
        ctx
      );
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to delete pending tasks.",
        env,
        5000,
        ctx
      );
    }
    return;
  }

  // Handle /addshort command - takes text and keeps only first few characters
  if (text.startsWith("/addshort ")) {
    const inputText = text.substring(10).trim();
    if (!inputText) {
      await sendTelegramMessage(
        chatId,
        "❌ Please provide text after /addshort",
        env,
        5000,
        ctx
      );
      return;
    }

    // Extract first few characters (default to 50, but can be adjusted)
    // Try to find a natural break point (space, punctuation) near 50 chars
    let shortText = inputText.substring(0, 50);
    if (inputText.length > 50) {
      // Try to find a space or punctuation near the 50 char mark
      const breakPoints = ['.', '!', '?', ',', ';', ' '];
      for (let i = 49; i >= 30; i--) {
        if (breakPoints.includes(inputText[i])) {
          shortText = inputText.substring(0, i + 1);
          break;
        }
      }
      // If no break point found, just cut at 50 and add ellipsis
      if (shortText.length === 50) {
        shortText = inputText.substring(0, 47) + '...';
      }
    }

    try {
      // Shift all existing tasks down by 1 to make room at position 1
      await env.DB.prepare(
        "UPDATE todos SET task_order = task_order + 1 WHERE chat_id = ? AND user_id = ? AND is_done = FALSE"
      )
        .bind(chatId.toString(), userId)
        .run();

      // Insert new task at position 1 (top of mind)
      await env.DB.prepare(
        "INSERT INTO todos (chat_id, user_id, task, is_done, task_order) VALUES (?, ?, ?, FALSE, 1)"
      )
        .bind(chatId.toString(), userId, shortText)
        .run();

      const formattedTask = await formatTaskWithMarkdown(shortText);
      await sendTelegramMessage(
        chatId,
        `✅ Added short task #1: "${formattedTask}"`,
        env,
        3000, // 3s
        ctx
      );
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to add the task.",
        env,
        5000,
        ctx
      );
    }
    return;
  }

  // Handle adding tasks (with or without /add)
  let taskText = text;
  if (text.startsWith("/add ")) {
    taskText = text.substring(5);
  }

  // Validate: Don't allow solo links (must have text with the link)
  if (isSoloLink(taskText)) {
    await sendTelegramMessage(
      chatId,
      "❌ Please add some text with your link. Solo links are not allowed.\n\nExample: \"Check this out: https://example.com\"",
      env,
      10000, // 10s
      ctx
    );
    return;
  }

  try {
    // Shift all existing tasks down by 1 to make room at position 1
    await env.DB.prepare(
      "UPDATE todos SET task_order = task_order + 1 WHERE chat_id = ? AND user_id = ? AND is_done = FALSE"
    )
      .bind(chatId.toString(), userId)
      .run();

    // Insert new task at position 1 (top of mind)
    await env.DB.prepare(
      "INSERT INTO todos (chat_id, user_id, task, is_done, task_order) VALUES (?, ?, ?, FALSE, 1)"
    )
      .bind(chatId.toString(), userId, taskText)
      .run();

    const formattedTask = await formatTaskWithMarkdown(taskText);
    await sendTelegramMessage(
      chatId,
      `✅ Added task #1: "${formattedTask}"`,
      env,
      3000, // 3s
      ctx
    );
  } catch (error) {
    await sendTelegramMessage(
      chatId,
      "❌ Failed to add the task.",
      env,
      5000,
      ctx
    );
  }
}

// Endpoint for browser extension to add tasks
router.post("/api/task", async (request: Request, env: Env, ctx: ExecutionContext) => {
  const secret = request.headers.get("X-API-Secret");
  
  if (secret !== env.API_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { chat_id, user_id, text } = await request.json() as { chat_id: string, user_id: number, text: string };
    
    if (!chat_id || !user_id || !text) {
      return new Response("Missing required fields", { status: 400 });
    }

    // Validate: Don't allow solo links (must have text with the link)
    if (isSoloLink(text)) {
      // Notify user via Telegram about the rejection
      await sendTelegramMessage(
        parseInt(chat_id),
        "❌ Please add some text with your link. Solo links are not allowed.\n\nExample: \"Check this out: https://example.com\"",
        env,
        10000, // 10s
        ctx
      );
      return new Response(JSON.stringify({ ok: false, error: "Solo links not allowed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Shift all existing tasks down by 1 to make room at position 1
    await env.DB.prepare(
      "UPDATE todos SET task_order = task_order + 1 WHERE chat_id = ? AND user_id = ? AND is_done = FALSE"
    )
      .bind(chat_id, user_id)
      .run();

    // Insert task at position 1 (top of mind)
    await env.DB.prepare(
      "INSERT INTO todos (chat_id, user_id, task, is_done, task_order) VALUES (?, ?, ?, FALSE, 1)"
    )
      .bind(chat_id, user_id, text)
      .run();

    // Notify user via Telegram
    const formattedTask = await formatTaskWithMarkdown(text);
    await sendTelegramMessage(
      parseInt(chat_id),
      `📌 Saved from Browser: "${formattedTask}" (Task #1)`,
      env,
      0, // Don't delete this notification
      ctx
    );

    return new Response(JSON.stringify({ ok: true, task_id: 1 }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("API Error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
});

router.post(
  "/webhook",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    const update: TelegramUpdate = await request.json();
    await handleTelegramUpdate(update, env, ctx);
    return new Response("OK");
  }
);

router.all("*", () => new Response("Not Found.", { status: 404 }));

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
// Update handleUpdate to accept ctx parameter
async function handleUpdate(
  update: Update,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!update.message?.text) {
    return new Response("OK", { status: 200 });
  }

  try {
    // Pass the context to handleTelegramUpdate
    await handleTelegramUpdate(update, env, ctx);
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("Error handling command", { status: 500 });
  }
}

