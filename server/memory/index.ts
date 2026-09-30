import type { MemoryItem } from '../../shared/types.js';
import type { Repository } from '../db.js';
import type { TextProvider } from '../providers/types.js';

export interface MemoryStore {
  readonly enabled: boolean;
  recall(userId: string, query: string, limit?: number): Promise<string[]>;
  remember(userId: string, fact: string): Promise<boolean>;
  forget(userId: string, memoryId: string): Promise<boolean>;
  list(userId: string): Promise<MemoryItem[]>;
  update(userId: string, memoryId: string, content: string): Promise<MemoryItem | null>;
  clearAll(userId: string): Promise<number>;
  extractAndSave(
    textProvider: TextProvider,
    userId: string,
    exchange: { userText: string; assistantText: string },
    signal?: AbortSignal,
  ): Promise<string[]>;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'what', 'when', 'where', 'who', 'why', 'how', 'i', 'my', 'me',
  'you', 'your', 'we', 'our', 'they', 'them', 'this', 'these', 'those', 'can', 'do',
]);

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

export class DbMemoryStore implements MemoryStore {
  readonly enabled = true;
  private repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  async list(userId: string): Promise<MemoryItem[]> {
    return this.repo.listMemories(userId);
  }

  async remember(userId: string, fact: string): Promise<boolean> {
    const clean = fact.trim();
    if (!clean || clean.length > 1000) return false;

    // Check duplicate
    const existing = await this.repo.listMemories(userId);
    const lower = clean.toLowerCase();
    if (existing.some((m) => m.content.toLowerCase() === lower)) {
      return false;
    }

    await this.repo.addMemory(userId, clean);
    return true;
  }

  async update(userId: string, memoryId: string, content: string): Promise<MemoryItem | null> {
    return this.repo.updateMemory(userId, memoryId, content);
  }

  async forget(userId: string, memoryId: string): Promise<boolean> {
    return this.repo.deleteMemory(userId, memoryId);
  }

  async clearAll(userId: string): Promise<number> {
    return this.repo.deleteAllMemories(userId);
  }

  /**
   * Retrieve relevant memories for a query (ranking by keyword relevance and recency,
   * capped at a small size budget to prevent prompt bloat).
   */
  async recall(userId: string, query: string, limit = 6): Promise<string[]> {
    const all = await this.repo.listMemories(userId);
    if (!all.length) return [];

    const queryTokens = tokenize(query);

    const scored = all.map((m) => {
      const memTokens = tokenize(m.content);
      let matchCount = 0;
      for (const token of queryTokens) {
        if (memTokens.has(token)) matchCount++;
      }
      // Score based on keyword overlap + recency weighting
      const recencyDays = (Date.now() - m.updatedAt) / (1000 * 60 * 60 * 24);
      const recencyScore = Math.max(0, 5 - recencyDays * 0.1);
      const score = matchCount * 10 + recencyScore;
      return { memory: m, score, matchCount };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Keep top memories, capped at character budget (~1000 chars)
    let totalChars = 0;
    const kept: string[] = [];

    for (const item of scored) {
      if (kept.length >= limit) break;
      if (totalChars + item.memory.content.length > 1000 && kept.length > 0) break;
      kept.push(item.memory.content);
      totalChars += item.memory.content.length;
    }

    return kept;
  }

  async extractAndSave(
    textProvider: TextProvider,
    userId: string,
    exchange: { userText: string; assistantText: string },
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!textProvider.isConfigured()) return [];

    const prompt = `You are a memory extractor for an AI assistant.
Analyze this user-assistant conversation exchange:
User: "${exchange.userText.slice(0, 1500)}"
Assistant: "${exchange.assistantText.slice(0, 1500)}"

Extract any NEW durable personal facts and preferences about the user.
Examples: user's name, role, projects/apps they are building, technical stack preferences, interests, or style preferences.

RULES:
- NEVER extract secrets, passwords, credentials, tokens, API keys, private URLs, or sensitive data.
- NEVER extract temporary or ephemeral requests (e.g. weather queries, shopping searches, transient math problems).
- NEVER extract facts about the assistant or general world knowledge.
- Format: Return ONLY a valid JSON array of strings, e.g. ["User is developing an iOS app with React Native", "User prefers concise answers"]. If there are no new durable facts, return [].`;

    try {
      const raw = await textProvider.complete({
        messages: [{ role: 'system', content: prompt }],
        maxTokens: 256,
        temperature: 0.1,
        signal,
      });

      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      const saved: string[] = [];
      for (const item of parsed) {
        if (typeof item !== 'string') continue;
        const fact = item.trim();
        // Sensitive string safety check
        if (
          !fact ||
          fact.length > 500 ||
          /\b(password|secret|bearer|token|api[_-]?key|nvapi|sk-)\b/i.test(fact)
        ) {
          continue;
        }

        const wasSaved = await this.remember(userId, fact);
        if (wasSaved) saved.push(fact);
      }

      return saved;
    } catch {
      return [];
    }
  }
}

export class DisabledMemoryStore implements MemoryStore {
  readonly enabled = false;
  async recall(): Promise<string[]> {
    return [];
  }
  async remember(): Promise<boolean> {
    return false;
  }
  async forget(): Promise<boolean> {
    return false;
  }
  async list(): Promise<MemoryItem[]> {
    return [];
  }
  async update(): Promise<MemoryItem | null> {
    return null;
  }
  async clearAll(): Promise<number> {
    return 0;
  }
  async extractAndSave(): Promise<string[]> {
    return [];
  }
}

export function createMemoryStore(repo?: Repository): MemoryStore {
  if (repo) return new DbMemoryStore(repo);
  return new DisabledMemoryStore();
}
