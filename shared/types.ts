/** Types shared between the TRALIX server and web client. */

export type Role = 'user' | 'assistant';
export type MessageStatus = 'complete' | 'stopped' | 'error';

export interface Source {
  title: string;
  url: string;
  /** Short excerpt from the source, when available. */
  snippet?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  status: MessageStatus;
  sources: Source[];
  createdAt: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[];
}

export interface UserProfile {
  id: string;
  displayName: string;
  customInstructions: string;
}

export type CapabilityState = 'active' | 'unavailable' | 'coming_soon';

export interface Capability {
  state: CapabilityState;
  /** Human-readable, non-sensitive detail (e.g. provider name). */
  detail?: string;
}

export interface Capabilities {
  text: Capability;
  webSearch: Capability;
  weather: Capability;
  memory: Capability;
  imageGeneration: Capability;
  imageUnderstanding: Capability;
  voice: Capability;
  video: Capability;
}

export type ChatAction = 'send' | 'regenerate' | 'edit' | 'continue';

export interface ChatRequest {
  conversationId?: string;
  action: ChatAction;
  /** Required for `send` and `edit`. */
  content?: string;
  /** Required for `edit`: the user message being edited. */
  messageId?: string;
}

export type AiStatus = 'thinking' | 'searching' | 'writing';

/** Server-sent events emitted by POST /api/chat. */
export type StreamEvent =
  | { type: 'meta'; conversation: ConversationSummary; userMessage?: ChatMessage; assistantMessageId: string }
  | { type: 'status'; status: AiStatus; detail?: string }
  | { type: 'delta'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'title'; title: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; code: string; message: string; retryable: boolean };
