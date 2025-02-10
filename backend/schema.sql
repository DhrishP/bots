CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not started',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  task_order INTEGER NOT NULL
);

-- Create an index for efficient ordering
CREATE INDEX IF NOT EXISTS idx_chat_order ON todos(chat_id, task_order);