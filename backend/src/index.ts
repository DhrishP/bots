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
    text?: string;
  };
}

const router = Router();

// Helper function to send Telegram messages
async function sendTelegramMessage(chatId: number, text: string, env: Env) {
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

// Handle Telegram webhook updates
async function handleTelegramUpdate(update: TelegramUpdate, env: Env) {
  const message = update.message;
  if (!message?.text || !message.chat) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  // Handle /done command
  if (text.startsWith("/done ")) {
    const taskNumber = parseInt(text.split(" ")[1]);
    try {
      const task = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND task_order = ?"
      )
        .bind(chatId.toString(), taskNumber)
        .first();

      if (!task) {
        await sendTelegramMessage(chatId, "❌ Invalid task number.", env);
        return;
      }

      await env.DB.prepare(
        "UPDATE todos SET is_done = TRUE WHERE chat_id = ? AND task_order = ?"
      )
        .bind(chatId.toString(), taskNumber)
        .run();

      await sendTelegramMessage(
        chatId,
        `✅ Completed task #${taskNumber}: "${task.task}"`,
        env
      );
      return;
    } catch (error) {
      await sendTelegramMessage(chatId, "❌ Failed to mark task as done.", env);
      return;
    }
  }

  // Handle /small-wins command
  if (text === "/small-wins") {
    try {
      const wins = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND is_done = TRUE ORDER BY created_at DESC"
      )
        .bind(chatId.toString())
        .all();

      if (!wins.results?.length) {
        await sendTelegramMessage(
          chatId,
          "📭 No completed tasks yet. Keep going!",
          env
        );
        return;
      }

      const winsList = wins.results
        .map((todo: any) => `• ${todo.task}`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `🎉 Your completed tasks:\n${winsList}`,
        env
      );
      return;
    } catch (error) {
      await sendTelegramMessage(
        chatId,
        "❌ Failed to fetch completed tasks.",
        env
      );
      return;
    }
  }

  // Handle /list command
  if (text === "/list") {
    try {
      const todos = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND is_done = FALSE ORDER BY task_order"
      )
        .bind(chatId.toString())
        .all();

      if (!todos.results?.length) {
        await sendTelegramMessage(
          chatId,
          "📭 No pending tasks. Add some tasks!",
          env
        );
        return;
      }

      const taskList = todos.results
        .map((todo: any) => `${todo.task_order}. ${todo.task}`)
        .join("\n");

      await sendTelegramMessage(chatId, `📋 Your tasks:\n${taskList}`, env);
      return;
    } catch (error) {
      await sendTelegramMessage(chatId, "❌ Failed to fetch tasks.", env);
      return;
    }
  }

  // Handle /delete command
  if (text.startsWith("/delete ")) {
    const taskNumber = parseInt(text.split(" ")[1]);
    try {
      const task = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND task_order = ?"
      )
        .bind(chatId.toString(), taskNumber)
        .first();

      if (!task) {
        await sendTelegramMessage(chatId, "❌ Invalid task number.", env);
        return;
      }

      await env.DB.prepare(
        "DELETE FROM todos WHERE chat_id = ? AND task_order = ?"
      )
        .bind(chatId.toString(), taskNumber)
        .run();

      // Reorder remaining tasks
      await env.DB.prepare(
        `UPDATE todos 
         SET task_order = task_order - 1 
         WHERE chat_id = ? AND task_order > ?`
      )
        .bind(chatId.toString(), taskNumber)
        .run();

      await sendTelegramMessage(
        chatId,
        `🗑️ Deleted task #${taskNumber}: "${task.task}"`,
        env
      );
      return;
    } catch (error) {
      await sendTelegramMessage(chatId, "❌ Failed to delete task.", env);
      return;
    }
  }

  // Handle adding tasks (with or without /add)
  let taskText = text;
  if (text.startsWith("/add ")) {
    taskText = text.substring(5);
  }

  try {
    // Get the highest task_order
    const maxOrder = await env.DB.prepare(
      "SELECT COALESCE(MAX(task_order), 0) as max_order FROM todos WHERE chat_id = ?"
    )
      .bind(chatId.toString())
      .first();

    const nextOrder = ((maxOrder?.max_order as number) || 0) + 1;

    await env.DB.prepare(
      "INSERT INTO todos (chat_id, task, is_done, task_order) VALUES (?, ?, FALSE, ?)"
    )
      .bind(chatId.toString(), taskText, nextOrder)
      .run();

    await sendTelegramMessage(
      chatId,
      `✅ Added task #${nextOrder}: "${taskText}"`,
      env
    );
  } catch (error) {
    await sendTelegramMessage(chatId, "❌ Failed to add the task.", env);
  }

  // Update help command
  if (text === "/help") {
    const helpText = `📝 Available commands:
Just type your task or use /add <task> - Add a new task
/done <number> - ✅ Mark a task as completed
/list - 📋 Show pending tasks
/small-wins - 🎉 Show completed tasks
/delete <number> - 🗑️ Delete a task
/help - ℹ️ Show this help message

📱 Examples:
Buy groceries
/add Buy groceries
/done 1
/delete 1`;

    await sendTelegramMessage(chatId, helpText, env);
    return;
  }

  // If no command matches, show help message
  await sendTelegramMessage(
    chatId,
    "❓ Unknown command. Use /help to see available commands.",
    env
  );
}

router.post("/webhook", async (request: Request, env: Env) => {
  const update: TelegramUpdate = await request.json();
  await handleTelegramUpdate(update, env);
  return new Response("OK");
});

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

        // Make sure we return the Promise from handleUpdate
        return await handleUpdate(payload, env);
      } catch (e) {
        console.error(e);
        return new Response("Error processing request", { status: 500 });
      }
    }
    return new Response("OK", { status: 200 });
  },
};

async function handleUpdate(update: Update, env: Env): Promise<Response> {
  if (!update.message?.text) {
    return new Response("OK", { status: 200 });
  }

  try {
    await handleTelegramUpdate(update, env);
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("Error handling command", { status: 500 });
  }
}
