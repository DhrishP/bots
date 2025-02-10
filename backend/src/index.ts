import dotenv from "dotenv";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const prisma = new PrismaClient();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN || "", {
  polling: true,
});

interface Message {
  chat: {
    id: number;
  };
}

// Command to start the bot
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "Welcome to your Todo Bot! Use /add, /list, /complete, or /progress to manage your tasks."
  );
});

// Command to add a new todo
bot.onText(
  /\/add (.+)/,
  async (msg: Message, match: RegExpExecArray | null) => {
    const chatId = msg.chat.id.toString();
    const task = match?.[1];

    if (!task) {
      bot.sendMessage(chatId, "Please provide a task description.");
      return;
    }

    try {
      await prisma.todo.create({
        data: {
          chatId,
          task,
          status: "not started",
        },
      });
      bot.sendMessage(chatId, `Added: "${task}"`);
    } catch (error) {
      console.error(error);
      bot.sendMessage(chatId, "Failed to add the task.");
    }
  }
);

// Command to list all todos
bot.onText(/\/list/, async (msg: Message) => {
  const chatId = msg.chat.id.toString();

  try {
    const todos = await prisma.todo.findMany({
      where: { chatId },
    });

    if (todos.length === 0) {
      bot.sendMessage(chatId, "No tasks found. Use /add to create a new task.");
      return;
    }

    const taskList = todos
      .map((todo, index) => `${index + 1}. ${todo.task} - ${todo.status}`)
      .join("\n");

    bot.sendMessage(chatId, `Your tasks:\n${taskList}`);
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, "Failed to fetch tasks.");
  }
});

// Command to mark a task as in progress
bot.onText(
  /\/progress (\d+)/,
  async (msg: Message, match: RegExpExecArray | null) => {
    const chatId = msg.chat.id.toString();
    const taskIndex = match ? parseInt(match[1]) - 1 : -1;

    if (taskIndex < 0) {
      bot.sendMessage(chatId, "Please provide a valid task number.");
      return;
    }

    try {
      const todos = await prisma.todo.findMany({
        where: { chatId },
      });

      if (todos[taskIndex]) {
        await prisma.todo.update({
          where: { id: todos[taskIndex].id },
          data: { status: "in progress" },
        });
        bot.sendMessage(
          chatId,
          `Task "${todos[taskIndex].task}" is now in progress.`
        );
      } else {
        bot.sendMessage(chatId, "Invalid task number.");
      }
    } catch (error) {
      console.error(error);
      bot.sendMessage(chatId, "Failed to update the task.");
    }
  }
);

// Command to mark a task as completed
bot.onText(
  /\/complete (\d+)/,
  async (msg: Message, match: RegExpExecArray | null) => {
    const chatId = msg.chat.id.toString();
    const taskIndex = match ? parseInt(match[1]) - 1 : -1;

    if (taskIndex < 0) {
      bot.sendMessage(chatId, "Please provide a valid task number.");
      return;
    }

    try {
      const todos = await prisma.todo.findMany({
        where: { chatId },
      });

      if (todos[taskIndex]) {
        await prisma.todo.update({
          where: { id: todos[taskIndex].id },
          data: { status: "completed" },
        });
        bot.sendMessage(
          chatId,
          `Task "${todos[taskIndex].task}" is now completed.`
        );
      } else {
        bot.sendMessage(chatId, "Invalid task number.");
      }
    } catch (error) {
      console.error(error);
      bot.sendMessage(chatId, "Failed to update the task.");
    }
  }
);

// Start the Express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
