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

  const addMatch = text.match(/^\/add (.+)/);
  if (addMatch) {
    const task = addMatch[1];
    try {
      // First get the highest task_order for this chat_id
      const maxOrder = await env.DB.prepare(
        "SELECT COALESCE(MAX(task_order), 0) as max_order FROM todos WHERE chat_id = ?"
      )
        .bind(chatId.toString())
        .first();

      const nextOrder = ((maxOrder?.max_order as number) || 0) + 1;

      await env.DB.prepare(
        "INSERT INTO todos (chat_id, task, status, task_order) VALUES (?, ?, ?, ?)"
      )
        .bind(chatId.toString(), task, "not started", nextOrder)
        .run();

      await sendTelegramMessage(
        chatId,
        `✅ Added: "${task}" (#${nextOrder})`,
        env
      );
    } catch (error) {
      await sendTelegramMessage(chatId, "❌ Failed to add the task.", env);
    }
    return;
  }

  // Enhanced /list command with status filtering
  if (text.startsWith("/list")) {
    try {
      let query = "SELECT * FROM todos WHERE chat_id = ? ORDER BY task_order";
      let params = [chatId.toString()];

      // Check for status filter
      const statusMatch = text.match(/^\/list (.+)/);
      if (statusMatch) {
        const status = statusMatch[1].toLowerCase();
        const validStatuses = ["not started", "in progress", "completed"];
        if (validStatuses.includes(status)) {
          query =
            "SELECT * FROM todos WHERE chat_id = ? AND status = ? ORDER BY task_order";
          params.push(status);
        } else {
          await sendTelegramMessage(
            chatId,
            `❌ Invalid status. Please use one of: ${validStatuses.join(", ")}`,
            env
          );
          return;
        }
      }

      const todos = await env.DB.prepare(query)
        .bind(...params)
        .all();

      if (!todos.results?.length) {
        const message = statusMatch
          ? `📭 No tasks found with status "${statusMatch[1]}". Use /add to create a new task.`
          : "📭 No tasks found. Use /add to create a new task.";
        await sendTelegramMessage(chatId, message, env);
        return;
      }

      const taskList = todos.results
        .map(
          (todo: any, index: number) =>
            `${index + 1}. ${todo.task} - ${todo.status}`
        )
        .join("\n");

      const statusText = statusMatch ? ` (${statusMatch[1]})` : "";
      await sendTelegramMessage(
        chatId,
        `📋 Your tasks${statusText}:\n${taskList}`,
        env
      );
    } catch (error) {
      await sendTelegramMessage(chatId, "❌ Failed to fetch tasks.", env);
    }
    return;
  }

  // Edit task command: /edit <task_number> <new_text>
  const editMatch = text.match(/^\/edit (\d+) (.+)/);
  if (editMatch) {
    const taskNumber = parseInt(editMatch[1]);
    const newTask = editMatch[2];

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
        "UPDATE todos SET task = ? WHERE chat_id = ? AND task_order = ?"
      )
        .bind(newTask, chatId.toString(), taskNumber)
        .run();

      await sendTelegramMessage(
        chatId,
        `✅ Task #${taskNumber} updated to: "${newTask}"`,
        env
      );
    } catch (error) {
      await sendTelegramMessage(chatId, "❌ Failed to edit the task.", env);
    }
    return;
  }

  // Delete task command: /delete <task_number>
  const deleteMatch = text.match(/^\/delete (\d+)/);
  if (deleteMatch) {
    const taskNumber = parseInt(deleteMatch[1]);

    try {
      // First check if task exists
      const task = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND task_order = ?"
      )
        .bind(chatId.toString(), taskNumber)
        .first();

      if (!task) {
        await sendTelegramMessage(chatId, "❌ Invalid task number.", env);
        return;
      }

      // Delete the task
      await env.DB.prepare(
        "DELETE FROM todos WHERE chat_id = ? AND task_order = ?"
      )
        .bind(chatId.toString(), taskNumber)
        .run();

      // Reorder remaining tasks
      await env.DB.prepare(
        `
        UPDATE todos 
        SET task_order = task_order - 1 
        WHERE chat_id = ? AND task_order > ?
      `
      )
        .bind(chatId.toString(), taskNumber)
        .run();

      await sendTelegramMessage(chatId, `🗑️ Task #${taskNumber} deleted.`, env);
    } catch (error) {
      await sendTelegramMessage(chatId, "❌ Failed to delete the task.", env);
    }
    return;
  }

  // Change task status command: /status <task_number> <new_status>
  const statusMatch = text.match(/^\/status (\d+) (.+)/);
  if (statusMatch) {
    const taskNumber = parseInt(statusMatch[1]);
    const newStatus = statusMatch[2].toLowerCase();

    // Validate status
    const validStatuses = ["not started", "in progress", "completed"];
    if (!validStatuses.includes(newStatus)) {
      await sendTelegramMessage(
        chatId,
        `❌ Invalid status. Please use one of: ${validStatuses.join(", ")}`,
        env
      );
      return;
    }

    try {
      // Get task by task_order
      const task = await env.DB.prepare(
        "SELECT * FROM todos WHERE chat_id = ? AND task_order = ?"
      )
        .bind(chatId.toString(), taskNumber)
        .first();

      if (!task) {
        await sendTelegramMessage(chatId, "❌ Invalid task number.", env);
        return;
      }

      // Update the status
      const result = await env.DB.prepare(
        "UPDATE todos SET status = ? WHERE chat_id = ? AND task_order = ?"
      )
        .bind(newStatus, chatId.toString(), taskNumber)
        .run();

      if (result.success) {
        await sendTelegramMessage(
          chatId,
          `✅ Task "${task.task}" (#${taskNumber}) status updated to: ${newStatus}`,
          env
        );
      } else {
        throw new Error("Update operation failed");
      }
    } catch (error) {
      console.error("Status update error:", error);
      await sendTelegramMessage(
        chatId,
        "❌ Failed to update task status. Please try again.",
        env
      );
    }
    return;
  }

  // Help command with updated information
  if (text === "/help") {
    const helpText = `📝 Available commands:
/add <task> - ➕ Add a new task
/list - 📋 Show all tasks
/list <status> - 🔍 Show tasks with specific status (not started/in progress/completed)
/edit <number> <new_text> - ✏️ Edit a task
/delete <number> - 🗑️ Delete a task
/status <number> <status> - 🔄 Update task status (not started/in progress/completed)
/help - ℹ️ Show this help message

📱 Examples:
/add Buy groceries
/list
/list in progress
/edit 1 Buy groceries and milk
/status 1 completed
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
