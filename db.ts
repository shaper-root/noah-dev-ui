import { Database } from "bun:sqlite";
import { resolve } from "path";
import { mkdirSync } from "fs";

const DATA_DIR = resolve(import.meta.dir, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(resolve(DATA_DIR, "dev.db"));

// WAL mode for better concurrent read/write
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('positive', 'negative', 'flag')),
    category TEXT,
    correction_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_feedback_msg ON feedback(message_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    conversation_id UNINDEXED,
    message_id UNINDEXED
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT,
    path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    memory_status TEXT DEFAULT 'none' CHECK(memory_status IN ('none', 'loading', 'loaded', 'error')),
    memory_chunk_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS file_tags (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    auto_suggested INTEGER DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_file_tags ON file_tags(file_id);
  CREATE INDEX IF NOT EXISTS idx_files_category ON files(category, subcategory);

  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    content_text,
    original_name,
    file_id UNINDEXED
  );
`);

// Migration: add archived column to conversations if it doesn't exist
{
  const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "archived")) {
    db.exec("ALTER TABLE conversations ADD COLUMN archived INTEGER DEFAULT 0");
  }
}

// Prepared statements
const stmts = {
  createConversation: db.prepare(
    "INSERT INTO conversations (id, title) VALUES (?, ?)"
  ),
  updateConversationTime: db.prepare(
    "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
  ),
  listConversations: db.prepare(
    "SELECT id, title, created_at, updated_at, archived FROM conversations WHERE archived = ? ORDER BY updated_at DESC LIMIT ?"
  ),
  getConversation: db.prepare(
    "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?"
  ),
  deleteConversation: db.prepare(
    "DELETE FROM conversations WHERE id = ?"
  ),
  insertMessage: db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)"
  ),
  getMessages: db.prepare(
    "SELECT m.id, m.role, m.content, m.created_at, m.metadata FROM messages m WHERE m.conversation_id = ? ORDER BY m.created_at ASC"
  ),
  insertFts: db.prepare(
    "INSERT INTO messages_fts (content, conversation_id, message_id) VALUES (?, ?, ?)"
  ),
  insertFeedback: db.prepare(
    "INSERT INTO feedback (id, message_id, type, category, correction_text) VALUES (?, ?, ?, ?, ?)"
  ),
  getFeedbackForConversation: db.prepare(`
    SELECT f.id, f.message_id, f.type, f.category, f.correction_text, f.created_at
    FROM feedback f
    JOIN messages m ON f.message_id = m.id
    WHERE m.conversation_id = ?
    ORDER BY f.created_at ASC
  `),
  searchMessages: db.prepare(`
    SELECT fts.message_id, fts.conversation_id, snippet(messages_fts, 0, '<mark>', '</mark>', '...', 32) as snippet
    FROM messages_fts fts
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),

  // File management
  insertFile: db.prepare(
    `INSERT INTO files (id, original_name, filename, category, subcategory, path, mime_type, size, content_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  getFile: db.prepare("SELECT * FROM files WHERE id = ?"),
  listFiles: db.prepare(
    "SELECT * FROM files ORDER BY updated_at DESC LIMIT ?"
  ),
  listFilesByCategory: db.prepare(
    "SELECT * FROM files WHERE category = ? ORDER BY updated_at DESC"
  ),
  listFilesByCategorySub: db.prepare(
    "SELECT * FROM files WHERE category = ? AND subcategory = ? ORDER BY updated_at DESC"
  ),
  updateFileCategory: db.prepare(
    "UPDATE files SET category = ?, subcategory = ?, path = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateFileMemoryStatus: db.prepare(
    "UPDATE files SET memory_status = ?, memory_chunk_count = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  deleteFile: db.prepare("DELETE FROM files WHERE id = ?"),
  getCategoryTree: db.prepare(
    "SELECT category, subcategory, COUNT(*) as count FROM files GROUP BY category, subcategory ORDER BY category, subcategory"
  ),
  insertFileTag: db.prepare(
    "INSERT INTO file_tags (id, file_id, tag, auto_suggested) VALUES (?, ?, ?, ?)"
  ),
  getFileTags: db.prepare(
    "SELECT id, tag, auto_suggested FROM file_tags WHERE file_id = ?"
  ),
  deleteFileTag: db.prepare(
    "DELETE FROM file_tags WHERE file_id = ? AND tag = ?"
  ),
  deleteAllFileTags: db.prepare(
    "DELETE FROM file_tags WHERE file_id = ?"
  ),
  insertFileFts: db.prepare(
    "INSERT INTO files_fts (content_text, original_name, file_id) VALUES (?, ?, ?)"
  ),
  deleteFileFts: db.prepare(
    "DELETE FROM files_fts WHERE file_id = ?"
  ),
  searchFiles: db.prepare(`
    SELECT fts.file_id, snippet(files_fts, 0, '<mark>', '</mark>', '...', 48) as snippet,
           snippet(files_fts, 1, '<mark>', '</mark>', '...', 48) as name_snippet
    FROM files_fts fts
    WHERE files_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),

  // Chat management
  updateConversationTitle: db.prepare(
    "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  archiveConversation: db.prepare(
    "UPDATE conversations SET archived = ? WHERE id = ?"
  ),

  // Analytics
  messagesToday: db.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE created_at >= date('now')"
  ),
  avgResponseTime: db.prepare(
    "SELECT AVG(json_extract(metadata, '$.total_ms')) as avg_ms FROM messages WHERE role = 'assistant' AND created_at >= date('now') AND json_extract(metadata, '$.total_ms') IS NOT NULL"
  ),
  avgResponseTimeForConv: db.prepare(
    "SELECT AVG(json_extract(metadata, '$.total_ms')) as avg_ms FROM messages WHERE role = 'assistant' AND conversation_id = ? AND json_extract(metadata, '$.total_ms') IS NOT NULL"
  ),
  flagsToday: db.prepare(
    "SELECT COUNT(*) as count FROM feedback WHERE type = 'flag' AND created_at >= date('now')"
  ),
  memoryOpsToday: db.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE role = 'assistant' AND created_at >= date('now') AND (json_extract(metadata, '$.tool_calls') LIKE '%memory_store%' OR json_extract(metadata, '$.tool_calls') LIKE '%memory_forget%')"
  ),
};

function genId(): string {
  return crypto.randomUUID();
}

function truncateTitle(text: string, max = 80): string {
  if (text.length <= max) return text;
  const truncated = text.slice(0, max);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
  metadata: string;
}

export interface Feedback {
  id: string;
  message_id: string;
  type: string;
  category: string | null;
  correction_text: string | null;
  created_at: string;
}

export interface FileRecord {
  id: string;
  original_name: string;
  filename: string;
  category: string;
  subcategory: string | null;
  path: string;
  mime_type: string;
  size: number;
  content_text: string | null;
  created_at: string;
  updated_at: string;
  memory_status: string;
  memory_chunk_count: number;
}

export interface FileTag {
  id: string;
  tag: string;
  auto_suggested: number;
}

export interface CategoryNode {
  category: string;
  subcategory: string | null;
  count: number;
}

export const DB = {
  createConversation(firstMessage: string): Conversation {
    const id = genId();
    const title = truncateTitle(firstMessage);
    stmts.createConversation.run(id, title);
    return stmts.getConversation.get(id) as Conversation;
  },

  listConversations(limit = 50, archived = 0): Conversation[] {
    return stmts.listConversations.all(archived, limit) as Conversation[];
  },

  getConversation(id: string): Conversation | null {
    return (stmts.getConversation.get(id) as Conversation) || null;
  },

  deleteConversation(id: string): void {
    stmts.deleteConversation.run(id);
  },

  addMessage(
    conversationId: string,
    role: string,
    content: string,
    metadata: Record<string, unknown> = {}
  ): string {
    const id = genId();
    stmts.insertMessage.run(id, conversationId, role, content, JSON.stringify(metadata));
    stmts.updateConversationTime.run(conversationId);
    // Index in FTS
    if (role !== "system") {
      stmts.insertFts.run(content, conversationId, id);
    }
    return id;
  },

  getMessages(conversationId: string): Message[] {
    return stmts.getMessages.all(conversationId) as Message[];
  },

  addFeedback(
    messageId: string,
    type: string,
    category: string | null = null,
    correctionText: string | null = null
  ): string {
    const id = genId();
    stmts.insertFeedback.run(id, messageId, type, category, correctionText);
    return id;
  },

  getFeedback(conversationId: string): Feedback[] {
    return stmts.getFeedbackForConversation.all(conversationId) as Feedback[];
  },

  search(query: string, limit = 20): Array<{ message_id: string; conversation_id: string; snippet: string }> {
    return stmts.searchMessages.all(query, limit) as Array<{
      message_id: string;
      conversation_id: string;
      snippet: string;
    }>;
  },

  // --- File Management ---

  addFile(
    originalName: string,
    filename: string,
    category: string,
    subcategory: string | null,
    path: string,
    mimeType: string,
    size: number,
    contentText: string | null
  ): FileRecord {
    const id = genId();
    stmts.insertFile.run(id, originalName, filename, category, subcategory, path, mimeType, size, contentText);
    if (contentText) {
      stmts.insertFileFts.run(contentText, originalName, id);
    }
    return stmts.getFile.get(id) as FileRecord;
  },

  getFile(id: string): FileRecord | null {
    return (stmts.getFile.get(id) as FileRecord) || null;
  },

  listFiles(category?: string, subcategory?: string, limit = 100): FileRecord[] {
    if (category && subcategory) {
      return stmts.listFilesByCategorySub.all(category, subcategory) as FileRecord[];
    }
    if (category) {
      return stmts.listFilesByCategory.all(category) as FileRecord[];
    }
    return stmts.listFiles.all(limit) as FileRecord[];
  },

  updateFileCategory(id: string, category: string, subcategory: string | null, newPath: string): void {
    stmts.updateFileCategory.run(category, subcategory, newPath, id);
    // Update FTS if needed
  },

  updateFileMemoryStatus(id: string, status: string, chunkCount: number): void {
    stmts.updateFileMemoryStatus.run(status, chunkCount, id);
  },

  deleteFile(id: string): void {
    stmts.deleteFileFts.run(id);
    stmts.deleteFile.run(id);
  },

  getCategoryTree(): CategoryNode[] {
    return stmts.getCategoryTree.all() as CategoryNode[];
  },

  addFileTags(fileId: string, tags: string[], autoSuggested = true): void {
    for (const tag of tags) {
      stmts.insertFileTag.run(genId(), fileId, tag.toLowerCase().trim(), autoSuggested ? 1 : 0);
    }
  },

  getFileTags(fileId: string): FileTag[] {
    return stmts.getFileTags.all(fileId) as FileTag[];
  },

  removeFileTag(fileId: string, tag: string): void {
    stmts.deleteFileTag.run(fileId, tag);
  },

  searchFiles(query: string, limit = 20): Array<{ file_id: string; snippet: string; name_snippet: string }> {
    return stmts.searchFiles.all(query, limit) as Array<{
      file_id: string;
      snippet: string;
      name_snippet: string;
    }>;
  },

  // --- Chat Management ---

  updateConversationTitle(id: string, title: string): void {
    stmts.updateConversationTitle.run(title, id);
  },

  archiveConversation(id: string, archived: boolean): void {
    stmts.archiveConversation.run(archived ? 1 : 0, id);
  },

  // --- Analytics ---

  getAnalyticsStats(): { messages_today: number; avg_response_time_ms: number | null; flags_today: number; memory_operations_today: number } {
    const msgs = stmts.messagesToday.get() as { count: number };
    const avg = stmts.avgResponseTime.get() as { avg_ms: number | null };
    const flags = stmts.flagsToday.get() as { count: number };
    const memOps = stmts.memoryOpsToday.get() as { count: number };
    return {
      messages_today: msgs.count,
      avg_response_time_ms: avg.avg_ms,
      flags_today: flags.count,
      memory_operations_today: memOps.count,
    };
  },

  getConversationAvgResponseTime(conversationId: string): number | null {
    const result = stmts.avgResponseTimeForConv.get(conversationId) as { avg_ms: number | null };
    return result.avg_ms;
  },
};
