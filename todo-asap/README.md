# Todo ASAP - Telegram Task Manager Bot

A fast and efficient Telegram bot for managing your to-do lists. Built with Cloudflare Workers and D1 database.

## Features

- ✅ Create and manage tasks
- 📋 Organize tasks with custom ordering
- ✨ Mark tasks as complete/incomplete
- 🤖 Simple Telegram interface
- ☁️ Powered by Cloudflare Workers
- 🚀 Fast and responsive

## Prerequisites

- [Bun](https://bun.sh) v1.1.8 or later
- Cloudflare account with Workers and D1 enabled
- Telegram Bot Token

## Setup

1. Install dependencies:
```bash
bun install
```

2. Configure environment variables in `.dev.vars`:
```
TELEGRAM_BOT_TOKEN=your_bot_token
```

3. Set up your D1 database:
```bash
wrangler d1 execute DB --local --file=./schema.sql
```

## Development

Run locally:
```bash
bun run dev
```

## Deployment

Deploy to Cloudflare Workers:
```bash
bun run deploy
```

## Commands

- `/start` - Initialize the bot
- `/add` - Add a new task
- `/list` - Show your tasks
- `/done` - Mark a task as complete
- `/undone` - Mark a task as incomplete
- `/clear` - Clear completed tasks

## License

MIT License
