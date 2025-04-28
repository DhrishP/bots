# Twitter Suggestion Bot

A Telegram bot that helps users craft better tweets and replies. Users can send text to the bot, and it will suggest 4 different ways to tweet or reply to it in different styles:

1. A thought-provoking, philosophical take
2. A practical, actionable insight
3. A witty, possibly humorous angle
4. An inspiring, motivational perspective

## Technology

- Built with Cloudflare Workers
- Uses AI SDK with Gemini model to generate suggestions
- Trained on popular tech Twitter styles
- Deployed with Wrangler

## Setup

1. Clone the repository
2. Install dependencies with `npm install`
3. Create a `.dev.vars` file with your API keys:
   ```
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   GEMINI_API_KEY=your_gemini_api_key
   ```
4. Run locally with `npm run dev`
5. Deploy with `npm run deploy`

## Commands

- `/start` - Start the bot and get a welcome message
- `/help` - Show available commands and usage information
