# ImpZimZoom - Telegram Password Manager Bot

A secure Telegram bot that helps you manage and store your credentials safely. Built with Cloudflare Workers and D1 database.

## Features

- 🔒 Securely store usernames and passwords
- 🔑 Encrypt sensitive data
- 📝 Add context notes to your credentials
- 🤖 Easy-to-use Telegram interface
- ☁️ Powered by Cloudflare Workers

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

## Security

All passwords are encrypted before storage. The bot uses secure practices to handle sensitive information.

## License

MIT License
