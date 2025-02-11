import { Router } from "itty-router";
import { Update } from "node-telegram-bot-api";

interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
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
      `👋 Welcome to todo Asap! Any text you add will become a task.\n\nUse /help to see available commands.`,
      env,
      0,
      ctx
    );
    return;
  }

  // Handle /done command (updated task_order)
  if (text.startsWith("/done ")) {
    const taskNumber = parseInt(text.split(" ")[1]);
    try {
      const task = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND task_order = ?"
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

      await env.DB.prepare(
        `UPDATE todos 
         SET is_done = TRUE, 
             task_order = 5000 + task_order 
         WHERE chat_id = ? AND user_id = ? AND task_order = ?`
      )
        .bind(chatId.toString(), userId, taskNumber)
        .run();

      await sendTelegramMessage(
        chatId,
        `✅ Completed task #${taskNumber}: "${task.task}"`,
        env,
        5000,
        ctx
      );
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

      const winsList = wins.results
        .map((todo: any) => `• ${todo.task}`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `🎉 Your completed tasks:\n${winsList}`,
        env,
        50000,
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
      const todos = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND is_done = FALSE ORDER BY task_order"
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

      const taskList = todos.results
        .map((todo: any) => `${todo.task_order}. ${todo.task}`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `📋 Your tasks:\n${taskList}`,
        env,
        5000,
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
        "SELECT * FROM todos WHERE chat_id = ? AND user_id = ? AND task_order = ?"
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

      await env.DB.prepare(
        "DELETE FROM todos WHERE chat_id = ? AND user_id = ? AND task_order = ?"
      )
        .bind(chatId.toString(), userId, taskNumber)
        .run();

      // Reorder remaining tasks
      await env.DB.prepare(
        `UPDATE todos 
         SET task_order = task_order - 1 
         WHERE chat_id = ? AND user_id = ? AND task_order > ?`
      )
        .bind(chatId.toString(), userId, taskNumber)
        .run();

      await sendTelegramMessage(
        chatId,
        `🗑️ Deleted task #${taskNumber}: "${task.task}"`,
        env,
        5000,
        ctx
      );
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
      // Transaction for atomic updates
      await env.DB.batch([
        // Get current pending tasks in order
        env.DB.prepare(
          "SELECT task_order FROM todos WHERE chat_id = ? AND user_id = ? AND is_done = FALSE ORDER BY task_order"
        ).bind(chatId.toString(), userId),

        // Update task_order sequentially
        env.DB.prepare(
          `WITH sorted AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY task_order) as new_order
            FROM todos 
            WHERE chat_id = ? AND user_id = ? AND is_done = FALSE
          )
          UPDATE todos
          SET task_order = sorted.new_order
          FROM sorted
          WHERE todos.id = sorted.id`
        ).bind(chatId.toString(), userId),
      ]);

      await sendTelegramMessage(
        chatId,
        "🔢 Task order has been reorganized! Use /list to see the new order.",
        env,
        5000,
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
/done <number> - ✅ Mark task as completed
/list - 📋 Show pending tasks
/smallwins - 🎉 Show completed tasks
/delete <number> - 🗑️ Delete a task
/reorder - 🔄 Fix task numbering gaps
/dall - 🧹 Delete all pending tasks
/help - ℹ️ Show this help

📱 Examples:
Buy groceries
/done 1
/reorder`;
    await sendTelegramMessage(chatId, helpText, env, 5000, ctx);
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
        5000,
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

  // Handle adding tasks (with or without /add)
  let taskText = text;
  if (text.startsWith("/add ")) {
    taskText = text.substring(5);
  }

  try {
    // Get the highest task_order
    const maxOrder = await env.DB.prepare(
      "SELECT COALESCE(MAX(task_order), 0) as max_order FROM todos WHERE chat_id = ? AND user_id = ?"
    )
      .bind(chatId.toString(), userId)
      .first();

    const nextOrder = ((maxOrder?.max_order as number) || 0) + 1;

    await env.DB.prepare(
      "INSERT INTO todos (chat_id, user_id, task, is_done, task_order) VALUES (?, ?, ?, FALSE, ?)"
    )
      .bind(chatId.toString(), userId, taskText, nextOrder)
      .run();

    await sendTelegramMessage(
      chatId,
      `✅ Added task #${nextOrder}: "${taskText}"`,
      env,
      5000,
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
