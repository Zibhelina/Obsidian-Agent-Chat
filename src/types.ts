export interface ChatSession {
  id: string;
  name: string;
  folderId: string | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  model: string;
  // Last time the user viewed this chat. Used by the sidebar to surface an
  // unread indicator for chats with a newer agent reply than the user has
  // seen. Optional for backwards compat with sessions saved before this
  // field existed — treated as "read up to createdAt" in that case.
  lastReadAt?: number;
}

export interface SessionFolder {
  id: string;
  name: string;
  parentId: string | null;
  collapsed: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  attachments: Attachment[];
  timestamp: number;
  metadata?: MessageMetadata;
  contextBundle?: ContextBundle;
  contextBundleRef?: ContextBundleRef;
  // Slash-skills invoked for this message (e.g. ["automation", "web"]).
  // User messages only. Rendered as chips in the bubble so there's a
  // visible trace of which skills were applied per-request. Capped at 3
  // by the composer UI.
  skillIds?: string[];
}

export interface Attachment {
  id: string;
  type: "image" | "file" | "pdf" | "audio";
  name: string;
  path: string;
  dataUrl?: string;
  mime?: string;
  sizeBytes?: number;
  source?: ContextItemSource | "layout";
  originalBytes?: ArrayBuffer;
  // For audio attachments only: the OpenAI-compat `input_audio.format` value
  // ("mp3", "wav", etc.) derived from the file extension. Not set for other
  // types.
  audioFormat?: string;
}

export type ContextItemSource = "mention" | "attachment" | "paste" | "drop" | "screenshot";

export type ContextItemKind =
  | "text"
  | "image"
  | "pdf"
  | "csv"
  | "audio"
  | "video"
  | "binary"
  | "folder"
  | "unknown";

export type ContextItemStatus =
  | "available_not_loaded"
  | "included_text"
  | "included_visual_proxy"
  | "included_audio"
  | "referenced_not_inlined"
  | "failed";

export interface ContextDerivative {
  id: string;
  role: "visual_proxy" | "thumbnail" | "transcription_source";
  localPath: string;
  vaultPath?: string;
  mime: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  maxEdge?: number;
  quality?: number;
  includedInRequest: boolean;
}

export interface ContextOriginal {
  localPath: string;
  vaultPath?: string;
  mime?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
}

export interface ContextItem {
  id: string;
  source: ContextItemSource;
  kind: ContextItemKind;
  name: string;
  localPath?: string;
  vaultPath?: string;
  mime?: string;
  sizeBytes?: number;
  status: ContextItemStatus;
  includedText?: string;
  error?: string;
  original?: ContextOriginal;
  derivatives?: ContextDerivative[];
}

export interface ContextBundle {
  version: 1;
  sessionId: string;
  messageId: string;
  createdAt: number;
  bundlePath?: string;
  error?: string;
  items: ContextItem[];
}

export interface ContextBundleRef {
  path: string;
  itemCount: number;
  createdAt: number;
}

export interface MessageMetadata {
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  tokensUsed?: number;
  tokensTotal?: number;
  durationMs?: number;
  thinking?: string;
  toolCalls?: ToolCall[];
  contextDebug?: ContextDebugSnapshot;
  traceRef?: TraceArtifactRef;
}

export interface TraceArtifactRef {
  path: string;
  createdAt: number;
  thinkingChars?: number;
  toolCallCount?: number;
  hasContextDebug?: boolean;
}

export type ContextDebugBlockType =
  | "system"
  | "developer"
  | "skill"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_schema"
  | "tool_result"
  | "attachment"
  | "mention_context"
  | "summary"
  | "unknown";

export interface ContextDebugBlock {
  id: string;
  type: ContextDebugBlockType;
  role?: string;
  source?: string;
  title?: string;
  content: string;
  tokenEstimate?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextDebugSnapshot {
  id: string;
  createdAt: number;
  requestSource?: "plugin_gateway_request" | "hermes_model_request";
  apiMode?: string;
  model?: string;
  provider?: string;
  sessionId?: string;
  hermesSessionId?: string;
  contextWindow?: number;
  estimatedTokens?: number;
  percentUsed?: number;
  compacted?: boolean | "unknown";
  compactionDetails?: string;
  messageCount?: number;
  omittedMessageCount?: number;
  warning?: string;
  blocks: ContextDebugBlock[];
  rawRequest: unknown;
}

export type LayoutPosition = "left" | "right" | "above" | "below" | "inline";

export interface LayoutBlock {
  type: "text" | "image" | "applet";
  content: string;
  position: LayoutPosition;
  width?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "pending" | "accepted" | "denied" | "running" | "completed" | "failed";
  result?: string;
}

export interface PendingPermission {
  toolCall: ToolCall;
  resolve: (decision: PermissionDecision) => void;
}

export type PermissionDecision =
  | { action: "accept" }
  | { action: "deny" }
  | { action: "explain"; reason: string };

export type ApprovalMode = "manual" | "smart" | "off";

export interface ObsidianAgentsSettings {
  agentName: string;
  // Legacy provider/model fields kept for settings compatibility. Hermes
  // routing is controlled by ~/.hermes/config.yaml; the plugin no longer sends
  // these values as the OpenAI-compatible `model` field.
  provider: string;
  model: string;
  effortLevel: "minimal" | "low" | "medium" | "high";
  hermesGatewayUrl: string;
  hermesApiKey: string;
  contextWindow: number;
  approvalMode: ApprovalMode;
  // Local callback server — lets scheduled/background jobs run by the gateway
  // deliver their results back into a specific chat, a new chat, a vault note,
  // or a toast. See src/callback/ for details.
  callbackEnabled: boolean;
  callbackHost: string;   // default "127.0.0.1"
  callbackPort: number;   // 0 = auto-pick an ephemeral port
  callbackToken: string;  // shared secret — auto-generated on first run
}

export const DEFAULT_SETTINGS: ObsidianAgentsSettings = {
  agentName: "Hermes",
  provider: "",
  model: "auto",
  effortLevel: "medium",
  hermesGatewayUrl: "",
  hermesApiKey: "",
  contextWindow: 128000,
  approvalMode: "manual",
  callbackEnabled: true,
  callbackHost: "127.0.0.1",
  callbackPort: 0,
  callbackToken: "",
};

// --- Delivery channels -----------------------------------------------------
// A channel is the destination a scheduled/background job writes its result
// to. The registry is open: anyone can drop a new channel into
// src/callback/channels/ and register it in src/callback/channels/index.ts.

export interface DeliveryPayload {
  // Primary body — markdown, rendered the same way as any agent message.
  content: string;
  // Optional short title for channels that need one (e.g. new-chat, note).
  title?: string;
  // Free-form metadata the channel may consume (jobId, scheduled time, etc).
  // Surfaced to the user so they can see what fired.
  metadata?: Record<string, unknown>;
}

export interface DeliveryRequest {
  channel: string;           // e.g. "chat", "new-chat", "note", "notice"
  // When channel === "chat" this is the session id the job should reply into.
  // Injected into the system prompt so the agent knows the current session.
  sessionId?: string;
  // Channel-specific target. For "note" this is a vault path. Ignored otherwise.
  target?: string;
  payload: DeliveryPayload;
}

export interface MentionItem {
  type: "file" | "folder";
  path: string;
  displayName: string;
}

export interface StreamHandlers {
  onStart?: (info: { userMsg: ChatMessage; agentMsg: ChatMessage }) => void;
  onContextDebug?: (snapshot: ContextDebugSnapshot) => void;
  onToken: (token: string) => void;
  onThinking: (thinking: string) => void;
  onToolCall: (toolCall: ToolCall) => void;
  onLayoutBlock: (block: LayoutBlock) => void;
  onComplete: (metadata: Partial<MessageMetadata>) => void;
  onError: (error: Error) => void;
}
