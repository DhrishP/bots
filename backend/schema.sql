CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  task TEXT NOT NULL,
  is_done BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  task_order INTEGER NOT NULL
);

-- Updated index for user-specific ordering
CREATE INDEX IF NOT EXISTS idx_user_order ON todos(chat_id, user_id, task_order);