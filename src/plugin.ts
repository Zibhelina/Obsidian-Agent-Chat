import {
  Plugin,
  WorkspaceLeaf,
  PluginSettingTab,
  Setting,
  App,
  Notice,
} from "obsidian";
import {
  getHermesConfigPath,
  hermesConfigExists,
  readActiveModel,
  readApprovalMode,
  readReasoningEffort,
  writeApprovalMode,
  writeReasoningEffort,
} from "./lib/hermesConfig";
import type { ApprovalMode } from "./types";
import {
  ObsidianAgentsSettings,
  ChatSession,
  ChatMessage,
  Attachment,
  ToolCall,
  PermissionDecision,
  StreamHandlers,
  SessionFolder,
  ContextItem,
  ContextBundle,
} from "./types";
import { loadSettings, saveSettings } from "./settings";
import { loadSessions, saveSessions, createSession, createFolder } from "./storage";
import { ChatView, CHAT_VIEW_TYPE } from "./ui/ChatView";
import { HermesInterface } from "./hermes";
import { buildContextBundle, renderContextBundleForPrompt } from "./features/contextBundle";
import { generateId } from "./lib/id";
import { ChannelRegistry } from "./callback/channels";
import type { DeliveryContext } from "./callback/channels/types";
import { startCallbackServer, type CallbackServer } from "./callback/server";
import type { DeliveryPayload } from "./types";
import { hasTracePayload } from "./traceArtifacts";

function stripRuntimeAttachment(attachment: Attachment): Attachment {
  const { originalBytes: _originalBytes, ...rest } = attachment;
  return rest;
}

function buildStoredAttachments(
  attachments: Attachment[],
  bundleItems: ContextItem[]
): Attachment[] {
  const attachmentItems = (bundleItems ?? []).filter((item) => item.source !== "mention");
  return attachments.map((attachment, index) => {
    const item = attachmentItems[index];
    const durablePath =
      item?.original?.vaultPath ??
      item?.vaultPath ??
      item?.derivatives?.[0]?.vaultPath ??
      attachment.path;
    const stored: Attachment = {
      ...stripRuntimeAttachment(attachment),
      name: item?.name ?? attachment.name,
      path: durablePath,
      mime: item?.mime ?? attachment.mime,
      sizeBytes: item?.sizeBytes ?? attachment.sizeBytes,
    };
    if (item?.original?.vaultPath || item?.vaultPath) {
      delete stored.dataUrl;
    }
    return stored;
  });
}

function hasPersistedAttachmentBlob(message: ChatMessage): boolean {
  return (message.attachments ?? []).some(
    (attachment) => typeof attachment.dataUrl === "string" && attachment.dataUrl.length > 0
  );
}

function contextBundleRefFromBundle(bundle: ContextBundle | undefined) {
  if (!bundle?.bundlePath) return undefined;
  return {
    path: bundle.bundlePath,
    itemCount: bundle.items.length,
    createdAt: bundle.createdAt,
  };
}

export default class ObsidianAgentsPlugin extends Plugin {
  settings!: ObsidianAgentsSettings;
  sessions: ChatSession[] = [];
  foldersList: SessionFolder[] = [];
  activeSessionId: string | null = null;
  private hermes: HermesInterface | null = null;
  chatView: ChatView | null = null;
  private pendingPermissions = new Map<
    string,
    { resolve: (d: PermissionDecision) => void; reject: (e: Error) => void }
  >();
  // Per-session stream state. Keyed by sessionId so multiple threads can
  // stream concurrently without clobbering each other.
  private activeStreams = new Map<
    string,
    { messageId: string; abort: AbortController; startTime: number }
  >();
  private channelRegistry = new ChannelRegistry();
  private callbackServer: CallbackServer | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    // Reconcile `approvalMode` with the live Hermes config on disk. The
    // config file is the source of truth for other Hermes clients (CLI, TUI,
    // Telegram), so mirror whatever it currently says.
    try {
      const onDisk = readApprovalMode();
      if (onDisk && onDisk !== this.settings.approvalMode) {
        this.settings.approvalMode = onDisk;
        await this.savePluginSettings();
      }
      const reasoningOnDisk = readReasoningEffort();
      if (reasoningOnDisk && reasoningOnDisk !== this.settings.effortLevel) {
        this.settings.effortLevel = reasoningOnDisk;
        await this.savePluginSettings();
      }
    } catch {
      /* config file unreadable — keep the stored value */
    }
    // The composer model picker writes ~/.hermes/config.yaml, and the Hermes
    // gateway routes from that file. Older plugin settings stored a separate
    // model slug; keeping it around makes the UI/reporting claim the wrong
    // model even when Hermes is routing correctly.
    if (this.settings.provider || this.settings.model !== "auto") {
      this.settings.provider = "";
      this.settings.model = "auto";
      await this.savePluginSettings();
    }
    this.hermes = new HermesInterface(this.settings);
    await this.loadSessionsData();

    this.registerView(CHAT_VIEW_TYPE, (leaf) => {
      const view = new ChatView(leaf, this);
      this.chatView = view;
      return view;
    });

    this.addRibbonIcon("message-circle", "Open Obsidian Agents", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-obsidian-agents",
      name: "Open Obsidian Agents",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new ObsidianAgentsSettingTab(this.app, this));

    await this.startCallbackServerIfEnabled();

    if (this.sessions.length === 0) {
      const session = createSession(null);
      session.name = "New Chat";
      this.sessions.push(session);
      this.activeSessionId = session.id;
      await this.saveSessionsData();
    } else {
      // Always land on a fresh greeting screen after Obsidian reloads.
      // Reuse an existing empty session if there is one; otherwise start
      // a new one. The previously-active session is still in the sidebar
      // and one click away.
      const emptySession =
        this.sessions.find((s) => s.folderId === null && s.messages.length === 0) ??
        (() => {
          const s = createSession(null);
          this.sessions.push(s);
          return s;
        })();
      this.activeSessionId = emptySession.id;
    }
  }

  onunload(): void {
    this.chatView = null;
    // Stop the callback server on unload. Obsidian will unload us on reload
    // and plugin-disable, so leaving the socket open leaks a port.
    if (this.callbackServer) {
      this.callbackServer.stop().catch(() => {});
      this.callbackServer = null;
    }
  }

  // --- Callback server --------------------------------------------------

  private buildDeliveryContext(): DeliveryContext {
    return {
      app: this.app,
      getSession: (id) => this.getSession(id),
      appendAgentMessage: (sessionId, payload) => {
        this.deliverToSession(sessionId, payload);
      },
      createSessionWithMessage: (name, payload) => {
        const s = createSession(null);
        s.name = name || s.name;
        this.sessions.push(s);
        this.deliverToSession(s.id, payload);
        // Surface a toast so the user can find the new session in the
        // sidebar — otherwise a scheduled result appearing in an unopened
        // chat is easy to miss.
        new Notice(`New chat "${s.name}" created from scheduled result`);
        this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
        return s;
      },
    };
  }

  private deliverToSession(sessionId: string, payload: DeliveryPayload): void {
    const session = this.getSession(sessionId);
    if (!session) return;

    const agentMsg: ChatMessage = {
      id: generateId(),
      role: "agent",
      content: payload.content,
      attachments: [],
      timestamp: Date.now(),
      metadata: payload.metadata
        ? { // Surface the scheduling metadata so the user can see what fired.
            ...(payload.title ? { model: `(delivered) ${payload.title}` } : {}),
          }
        : undefined,
    };
    session.messages.push(agentMsg);
    session.updatedAt = Date.now();
    this.saveSessionsData();

    // If the delivered-to session is the one currently open, rerender.
    if (this.activeSessionId === sessionId) {
      this.chatView?.loadSession(session);
    } else {
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  private async startCallbackServerIfEnabled(): Promise<void> {
    if (!this.settings.callbackEnabled) return;

    // Auto-generate a token on first run so out-of-the-box use is secure.
    if (!this.settings.callbackToken) {
      this.settings.callbackToken = generateId() + generateId();
      await this.savePluginSettings();
    }

    try {
      this.callbackServer = await startCallbackServer({
        host: this.settings.callbackHost || "127.0.0.1",
        port: this.settings.callbackPort || 0,
        token: this.settings.callbackToken,
        registry: this.channelRegistry,
        context: this.buildDeliveryContext(),
        onError: (err) => {
          // Non-fatal — log and keep the plugin usable.
          console.error("[obsidian-agents] callback server error", err);
        },
      });
    } catch (err) {
      console.error("[obsidian-agents] failed to start callback server", err);
      new Notice(
        `Obsidian Agents: callback server failed to start (${
          err instanceof Error ? err.message : String(err)
        }). Scheduled jobs won't be able to reply back until this is fixed in settings.`
      );
    }
  }

  async restartCallbackServer(): Promise<void> {
    if (this.callbackServer) {
      await this.callbackServer.stop();
      this.callbackServer = null;
    }
    await this.startCallbackServerIfEnabled();
  }

  getCallbackUrl(): string | null {
    return this.callbackServer?.url() ?? null;
  }

  getCallbackToken(): string {
    return this.settings.callbackToken;
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] as WorkspaceLeaf | undefined;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? undefined;
      if (!leaf) return;
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = await loadSettings(this);
  }

  async savePluginSettings(): Promise<void> {
    await saveSettings(this, this.settings);
  }

  async loadSessionsData(): Promise<void> {
    const data = await loadSessions(this.app);
    this.sessions = data.sessions;
    this.foldersList = data.folders;
    // Migrate: any pre-existing session from before the lastReadAt field
    // existed is treated as already-read up to its latest activity. Without
    // this, every historical chat would light up with the unread dot on
    // first launch of a build that has this feature.
    let shouldResave = false;
    for (const s of this.sessions) {
      if (s.lastReadAt == null) {
        s.lastReadAt = s.updatedAt;
        shouldResave = true;
      }
      if (s.messages.some((m) => hasTracePayload(m))) {
        shouldResave = true;
      }
    }
    if (await this.migrateLegacyAttachmentBlobs()) {
      shouldResave = true;
    }
    if (shouldResave) await this.saveSessionsData();
  }

  private async migrateLegacyAttachmentBlobs(): Promise<boolean> {
    let changed = false;
    for (const session of this.sessions) {
      for (const message of session.messages) {
        if (!hasPersistedAttachmentBlob(message)) continue;
        try {
          let bundle = message.contextBundle;
          if (!bundle || !bundle.items.some((item) => item.source !== "mention")) {
            const result = await buildContextBundle({
              app: this.app,
              sessionId: session.id,
              messageId: message.id,
              text: message.content,
              attachments: message.attachments,
            });
            bundle = result.bundle;
            if (bundle.items.length > 0) {
              message.contextBundle = bundle;
              message.contextBundleRef = contextBundleRefFromBundle(bundle);
            }
          } else if (!message.contextBundleRef) {
            message.contextBundleRef = contextBundleRefFromBundle(bundle);
          }

          const storedAttachments = buildStoredAttachments(
            message.attachments,
            bundle?.items ?? []
          );
          const strippedBlob = message.attachments.some(
            (attachment, index) => attachment.dataUrl && !storedAttachments[index]?.dataUrl
          );
          message.attachments = storedAttachments;
          if (strippedBlob) {
            changed = true;
          }
        } catch (error) {
          console.error("[obsidian-agents] failed to migrate attachment blobs", error);
        }
      }
    }
    return changed;
  }

  async saveSessionsData(): Promise<void> {
    // Only persist sessions that have at least one user message. Fresh,
    // unused "New Chat" sessions stay in memory but are not written to disk.
    const persistable = this.sessions.filter((s) =>
      s.messages.some((m) => m.role === "user")
    );
    await saveSessions(this.app, {
      sessions: persistable,
      folders: this.foldersList,
    });
  }

  getSession(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  createSession(folderId: string | null = null): ChatSession {
    // Reuse an existing empty session instead of piling up "New Chat" entries.
    const existingEmpty = this.sessions.find(
      (s) => s.folderId === folderId && s.messages.length === 0
    );
    if (existingEmpty) {
      this.activeSessionId = existingEmpty.id;
      this.chatView?.loadSession(existingEmpty);
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
      return existingEmpty;
    }

    const session = createSession(folderId);
    // Leave the name as "New Chat" — it'll be renamed from the first user
    // message. The session also won't show up in the sidebar until a message
    // is sent (see Sidebar.render filter).
    this.sessions.push(session);
    this.activeSessionId = session.id;
    this.chatView?.loadSession(session);
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    return session;
  }

  createFolder(parentId: string | null = null): void {
    const folder = createFolder(parentId);
    folder.name = `Folder ${this.foldersList.length + 1}`;
    this.foldersList.push(folder);
    this.saveSessionsData();
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  deleteSession(id: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeSessionId === id) {
      this.activeSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
      if (this.activeSessionId) {
        const session = this.getSession(this.activeSessionId);
        if (session) this.chatView?.loadSession(session);
      }
    }
    this.saveSessionsData();
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  renameSession(id: string, name: string): void {
    const session = this.getSession(id);
    if (session) {
      session.name = name;
      session.updatedAt = Date.now();
      this.saveSessionsData();
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  moveSession(id: string, folderId: string | null): void {
    const session = this.getSession(id);
    if (session) {
      session.folderId = folderId;
      session.updatedAt = Date.now();
      this.saveSessionsData();
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  deleteFolder(id: string): void {
    // Move child sessions to top level
    for (const session of this.sessions) {
      if (session.folderId === id) {
        session.folderId = null;
      }
    }
    // Move child folders to top level
    for (const folder of this.foldersList) {
      if (folder.parentId === id) {
        folder.parentId = null;
      }
    }
    this.foldersList = this.foldersList.filter((f) => f.id !== id);
    this.saveSessionsData();
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  moveFolder(id: string, parentId: string | null): void {
    const folder = this.foldersList.find((f) => f.id === id);
    if (!folder) return;
    // Guard against cycles: don't let a folder become a descendant of itself.
    let cursor: string | null = parentId;
    while (cursor) {
      if (cursor === id) return;
      const next: SessionFolder | undefined = this.foldersList.find((f) => f.id === cursor);
      cursor = next ? next.parentId : null;
    }
    folder.parentId = parentId;
    this.saveSessionsData();
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  renameFolder(id: string, name: string): void {
    const folder = this.foldersList.find((f) => f.id === id);
    if (folder) {
      folder.name = name;
      this.saveSessionsData();
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  toggleFolderCollapse(id: string): void {
    const folder = this.foldersList.find((f) => f.id === id);
    if (folder) {
      folder.collapsed = !folder.collapsed;
      this.saveSessionsData();
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  selectSession(id: string): void {
    this.activeSessionId = id;
    const session = this.getSession(id);
    if (session) {
      // Stamp the read cursor so the sidebar's unread-dot derivation
      // (lastReadAt vs latest agent message) knows the user has caught up.
      session.lastReadAt = Date.now();
      this.saveSessionsData();
      this.chatView?.loadSession(session);
    }
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
  }

  branchSession(sessionId: string, messageId: string): void {
    const parent = this.getSession(sessionId);
    if (!parent) return;
    const idx = parent.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    const now = Date.now();
    const branched: ChatSession = {
      id: generateId(),
      name: `Branch: ${parent.name}`,
      folderId: parent.folderId,
      messages: parent.messages.slice(0, idx + 1).map((m) => ({
        ...m,
        id: generateId(),
        attachments: m.attachments ? [...m.attachments] : [],
        metadata: m.metadata ? { ...m.metadata } : undefined,
        skillIds: m.skillIds ? [...m.skillIds] : undefined,
      })),
      createdAt: now,
      updatedAt: now,
      model: parent.model,
      lastReadAt: now,
    };

    this.sessions.push(branched);
    this.activeSessionId = branched.id;
    this.saveSessionsData();
    this.chatView?.loadSession(branched);
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    new Notice(`Branched into "${branched.name}"`);
  }

  isStreaming(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  // True when the session has an agent message newer than the user's
  // last-read cursor. The read cursor advances only on explicit
  // selectSession(), so a reply that arrives while the user is viewing
  // a chat still produces a dot — the dot clears the next time they
  // click the session. Sessions without a lastReadAt are treated as
  // read up to the session's latest activity so pre-existing chats
  // from before this feature shipped don't all light up.
  isSessionUnread(sessionId: string): boolean {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return false;
    // Fallback is 0 (not updatedAt!) — updatedAt is bumped on every onComplete,
    // so using it as the fallback would make the read cursor race ahead of
    // the agent message timestamp and permanently suppress the dot.
    // Historical sessions are handled by the loadSessionsData() migration,
    // which stamps lastReadAt once on first load.
    const readCursor = session.lastReadAt ?? 0;
    const latestAgent = session.messages
      .filter((m) => m.role === "agent")
      .reduce((acc, m) => Math.max(acc, m.timestamp), 0);
    return latestAgent > readCursor;
  }

  getStreamMessageId(sessionId: string): string | null {
    return this.activeStreams.get(sessionId)?.messageId ?? null;
  }

  getStreamStartTime(sessionId: string): number | null {
    return this.activeStreams.get(sessionId)?.startTime ?? null;
  }

  abortStream(sessionId: string): void {
    const stream = this.activeStreams.get(sessionId);
    if (stream) {
      stream.abort.abort();
      this.activeStreams.delete(sessionId);
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments: Attachment[],
    handlers: StreamHandlers,
    skillIds: string[] = []
  ): Promise<string | null> {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const userMsgId = generateId();

    // Build metadata-first context before storing the message so persisted
    // history can keep durable file refs instead of replaying base64 blobs.
    const contextResult = await buildContextBundle({
      app: this.app,
      sessionId,
      messageId: userMsgId,
      text,
      attachments,
    });

    const storedAttachments = buildStoredAttachments(attachments, contextResult.bundle.items);
    const contextBundleRef = contextResult.bundle.bundlePath
      ? {
          path: contextResult.bundle.bundlePath,
          itemCount: contextResult.bundle.items.length,
          createdAt: contextResult.bundle.createdAt,
        }
      : undefined;

    // Build user message — content stays as the raw user text for display.
    // Attachment bytes are stored in agent-vault and referenced by path.
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: "user",
      content: text,
      attachments: storedAttachments,
      timestamp: Date.now(),
      skillIds: skillIds.length > 0 ? skillIds : undefined,
      contextBundle: contextResult.bundle.items.length > 0 ? contextResult.bundle : undefined,
      contextBundleRef,
    };

    // Build an API-only message. Only this latest turn may carry optimized
    // multimodal derivatives; historical messages stay reference-only.
    const apiUserMsg: ChatMessage = {
      ...userMsg,
      content: renderContextBundleForPrompt(contextResult.text, contextResult.bundle),
      attachments: contextResult.apiAttachments,
      contextBundle: contextResult.bundle,
    };

    // Auto-name a fresh session from the first user message
    const wasEmpty = !session.messages.some((m) => m.role === "user");
    session.messages.push(userMsg);      // store clean version
    session.updatedAt = Date.now();
    if (wasEmpty) {
      const snippet = text.trim().replace(/\s+/g, " ").slice(0, 48);
      session.name = snippet || "New Chat";
      this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
    }
    // Build API payload: history up to (but not including) the last user msg,
    // then substitute the context-injected version for the API call only.
    const requestMessages = [
      ...session.messages.slice(0, -1), // everything before userMsg
      apiUserMsg,                        // context-injected, never stored
    ];

    // Build agent placeholder
    const agentMsgId = generateId();
    const agentMsg: ChatMessage = {
      id: agentMsgId,
      role: "agent",
      content: "",
      attachments: [],
      timestamp: Date.now(),
    };
    session.messages.push(agentMsg);

    const startTime = Date.now();
    const abort = new AbortController();
    this.activeStreams.set(sessionId, { messageId: agentMsgId, abort, startTime });

    handlers.onStart?.({ userMsg, agentMsg });
    // Refresh sidebar so the spinner shows up for this session.
    this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);

    // Stream handlers that update session + UI
    const wrappedHandlers: StreamHandlers = {
      onContextDebug: (snapshot) => {
        agentMsg.metadata = {
          ...agentMsg.metadata,
          contextDebug: snapshot,
        };
        handlers.onContextDebug?.(snapshot);
      },
      onToken: (token: string) => {
        agentMsg.content += token;
        handlers.onToken(token);
      },
      onThinking: (thinking: string) => {
        agentMsg.metadata = { ...agentMsg.metadata, thinking };
        handlers.onThinking(thinking);
      },
      onToolCall: (toolCall: ToolCall) => {
        const calls = agentMsg.metadata?.toolCalls ?? [];
        agentMsg.metadata = {
          ...agentMsg.metadata,
          toolCalls: [...calls, toolCall],
        };
        handlers.onToolCall(toolCall);
      },
      onLayoutBlock: (block) => {
        handlers.onLayoutBlock(block);
      },
      onComplete: (metadata) => {
        const durationMs = Date.now() - startTime;
        agentMsg.metadata = {
          ...agentMsg.metadata,
          ...metadata,
          durationMs,
        };
        session.updatedAt = Date.now();
        // Don't auto-stamp lastReadAt here. The unread dot is suppressed
        // for the currently-active session by isSessionUnread()'s guard,
        // but we still want the dot to appear the moment the user clicks
        // away — so we only advance the read cursor on an explicit
        // selectSession().
        this.activeStreams.delete(sessionId);
        this.saveSessionsData();
        handlers.onComplete({ ...metadata, durationMs });
        // Refresh the sidebar so the spinner disappears and (if off-screen)
        // the unread dot appears for this session.
        this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
      },
      onError: (error) => {
        agentMsg.content += `\n\n[Error: ${error.message}]`;
        this.activeStreams.delete(sessionId);
        this.saveSessionsData();
        handlers.onError(error);
        this.chatView?.renderSidebar(this.sessions, this.foldersList, this.activeSessionId);
      },
    };

    if (!this.hermes) {
      this.hermes = new HermesInterface(this.settings);
    }
    await this.hermes.sendMessage(requestMessages, wrappedHandlers, abort, {
      sessionId,
      callbackUrl: this.getCallbackUrl(),
      callbackToken: this.settings.callbackEnabled ? this.getCallbackToken() : null,
      skillIds,
    });
    return agentMsgId;
  }

  async requestPermission(toolCall: ToolCall): Promise<PermissionDecision> {
    return new Promise((resolve, reject) => {
      this.pendingPermissions.set(toolCall.id, { resolve, reject });
      this.chatView?.showPermissionWidget(toolCall);
    });
  }

  resolvePermission(toolCallId: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(toolCallId);
    if (pending) {
      pending.resolve(decision);
      this.pendingPermissions.delete(toolCallId);
    }
  }

  denyPermission(toolCallId: string): void {
    const pending = this.pendingPermissions.get(toolCallId);
    if (pending) {
      pending.resolve({ action: "deny" });
      this.pendingPermissions.delete(toolCallId);
    }
  }
}

class ObsidianAgentsSettingTab extends PluginSettingTab {
  plugin: ObsidianAgentsPlugin;

  constructor(app: App, plugin: ObsidianAgentsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian Agents Settings" });

    new Setting(containerEl)
      .setName("Agent name")
      .setDesc("The name displayed for the AI agent")
      .addText((text) =>
        text
          .setPlaceholder("Hermes")
          .setValue(this.plugin.settings.agentName)
          .onChange(async (value) => {
            this.plugin.settings.agentName = value || "Hermes";
            await this.plugin.savePluginSettings();
            this.plugin.chatView?.syncSettings();
          })
      );

    this.renderProviderAndModelSettings(containerEl);

    new Setting(containerEl)
      .setName("Effort level")
      .setDesc("Reasoning effort saved to ~/.hermes/config.yaml and applied on the next message")
      .addDropdown((drop) =>
        drop
          .addOption("minimal", "Minimal")
          .addOption("low", "Low")
          .addOption("medium", "Medium")
          .addOption("high", "High")
          .setValue(this.plugin.settings.effortLevel)
          .onChange(async (value) => {
            const effort = value as ObsidianAgentsSettings["effortLevel"];
            const previous = this.plugin.settings.effortLevel;
            this.plugin.settings.effortLevel = effort;
            try {
              writeReasoningEffort(effort);
              await this.plugin.savePluginSettings();
              this.plugin.chatView?.syncSettings();
              new Notice(`Reasoning effort set to "${effort}". Applies to the next message.`);
            } catch (err) {
              this.plugin.settings.effortLevel = previous;
              drop.setValue(previous);
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`Failed to write Hermes config: ${msg}`);
            }
          })
      );

    new Setting(containerEl)
      .setName("Hermes gateway URL")
      .setDesc("Optional override. Leave blank to auto-detect from ~/.hermes/.env")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8080/v1")
          .setValue(this.plugin.settings.hermesGatewayUrl)
          .onChange(async (value) => {
            this.plugin.settings.hermesGatewayUrl = value;
            await this.plugin.savePluginSettings();
          })
      );

    new Setting(containerEl)
      .setName("Hermes API key")
      .setDesc("Optional override. Leave blank to auto-detect from ~/.hermes/.env")
      .addText((text) =>
        text
          .setPlaceholder("API_SERVER_KEY from ~/.hermes/.env")
          .setValue(this.plugin.settings.hermesApiKey)
          .onChange(async (value) => {
            this.plugin.settings.hermesApiKey = value;
            await this.plugin.savePluginSettings();
          })
      );

    // --- Approvals ------------------------------------------------------
    containerEl.createEl("h3", { text: "Dangerous command approvals" });

    const approvalDesc = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    approvalDesc.createSpan({
      text:
        "How Hermes handles commands that could modify your system (rm -rf, " +
        "chmod 777, dd, DROP TABLE, etc). This writes to ",
    });
    approvalDesc.createEl("code", { text: "~/.hermes/config.yaml" });
    approvalDesc.createSpan({
      text: " and applies to every Hermes client (CLI, TUI, this plugin).",
    });

    if (!hermesConfigExists()) {
      const warn = containerEl.createEl("p", { cls: "setting-item-description" });
      warn.style.color = "var(--text-warning, var(--text-muted))";
      warn.setText(
        `No Hermes config found at ${getHermesConfigPath()}. ` +
          "Run `hermes setup` once, then this setting will take effect."
      );
    }

    new Setting(containerEl)
      .setName("Approval mode")
      .setDesc(
        "Manual: prompt for every dangerous command. " +
          "Smart: an LLM auto-approves low-risk commands and prompts for high-risk ones. " +
          "Off: skip all approval prompts (equivalent to --yolo)."
      )
      .addDropdown((drop) =>
        drop
          .addOption("manual", "Manual — prompt every time (safest)")
          .addOption("smart", "Smart — LLM auto-approves low-risk")
          .addOption("off", "Off — bypass all approvals (--yolo)")
          .setValue(this.plugin.settings.approvalMode)
          .onChange(async (value) => {
            const mode = value as ApprovalMode;
            const previous = this.plugin.settings.approvalMode;
            this.plugin.settings.approvalMode = mode;
            try {
              writeApprovalMode(mode);
              await this.plugin.savePluginSettings();
              new Notice(`Approval mode set to "${mode}".`);
            } catch (err) {
              // Roll back the in-memory value so the dropdown stays truthful.
              this.plugin.settings.approvalMode = previous;
              drop.setValue(previous);
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`Failed to write Hermes config: ${msg}`);
            }
          })
      );

    // --- Callback server -------------------------------------------------
    containerEl.createEl("h3", { text: "Background-job callback server" });

    const callbackDesc = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    callbackDesc.createSpan({
      text:
        "Lets scheduled/background jobs deliver their results back into a " +
        "chat, a new chat, a vault note, or a toast. The plugin runs a tiny " +
        "local HTTP server (default ",
    });
    callbackDesc.createEl("code", { text: "127.0.0.1" });
    callbackDesc.createSpan({
      text: ") that your Hermes gateway POSTs to when a job fires. Token-authed.",
    });

    const currentUrl = this.plugin.getCallbackUrl();
    const urlDisplay = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    urlDisplay.createSpan({ text: "Current endpoint: " });
    urlDisplay.createEl("code", {
      text: currentUrl ? `${currentUrl}/callback` : "(server not running)",
    });

    new Setting(containerEl)
      .setName("Enable callback server")
      .setDesc("Turn off to fully disable background-job delivery.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.callbackEnabled).onChange(async (value) => {
          this.plugin.settings.callbackEnabled = value;
          await this.plugin.savePluginSettings();
          await this.plugin.restartCallbackServer();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Bind host")
      .setDesc(
        '"127.0.0.1" (default) accepts only local connections. Use "0.0.0.0" to accept LAN connections — combine with the token for safety.'
      )
      .addText((text) =>
        text
          .setPlaceholder("127.0.0.1")
          .setValue(this.plugin.settings.callbackHost)
          .onChange(async (value) => {
            this.plugin.settings.callbackHost = value.trim() || "127.0.0.1";
            await this.plugin.savePluginSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bind port")
      .setDesc("0 = pick any free port. Set a fixed port if your gateway needs a stable URL.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.callbackPort))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.callbackPort = Number.isFinite(n) && n >= 0 ? n : 0;
            await this.plugin.savePluginSettings();
          })
      );

    new Setting(containerEl)
      .setName("Shared token")
      .setDesc(
        "Required in the Authorization: Bearer header (or ?token= query). Auto-generated on first run."
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.callbackToken)
          .onChange(async (value) => {
            this.plugin.settings.callbackToken = value.trim();
            await this.plugin.savePluginSettings();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Regenerate")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.callbackToken = Math.random()
              .toString(36)
              .slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
            await this.plugin.savePluginSettings();
            await this.plugin.restartCallbackServer();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Apply changes")
      .setDesc("Restart the server to pick up host/port/token changes.")
      .addButton((btn) =>
        btn
          .setButtonText("Restart server")
          .setCta()
          .onClick(async () => {
            await this.plugin.restartCallbackServer();
            new Notice("Callback server restarted.");
            this.display();
          })
      );

  }

  private renderProviderAndModelSettings(containerEl: HTMLElement): void {
    const active = readActiveModel();
    const value = `${active.provider || "gateway default"} / ${active.model || "gateway default"}`;
    const desc = active.baseUrl
      ? `Routing is controlled by ${getHermesConfigPath()}. Base URL: ${active.baseUrl}`
      : `Routing is controlled by ${getHermesConfigPath()}. Use the model picker in the chat composer to change it.`;

    new Setting(containerEl)
      .setName("Active Hermes model")
      .setDesc(desc)
      .addText((text) => text.setValue(value).setDisabled(true))
      .addButton((btn) =>
        btn
          .setButtonText("Reload")
          .onClick(() => {
            this.display();
          })
      );
  }
}
