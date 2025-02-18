import {
  pgTable,
  serial,
  text,
  timestamp,
  index,
  vector,
} from "drizzle-orm/pg-core";

export const credentials = pgTable(
  "credentials",
  {
    id: serial("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    username: text("username").notNull(),
    encryptedPassword: text("encrypted_password").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => ({
    credUserIdx: index("idx_creds_user").on(table.chatId, table.userId),
  })
);

export const contexts = pgTable(
  "contexts",
  {
    id: serial("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    embedding: vector("embedding", { dimensions: 1536 }),
  },
  (table) => ({
    contextUserIdx: index("idx_context_user").on(table.chatId, table.userId),
    embeddingIdx: index("embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    ),
  })
);
