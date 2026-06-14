import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import type {
  CoworkStore,
} from '../../coworkStore';
import { t } from '../../i18n';
import type {
  HermesEngineManager,
  HermesEngineStatus,
} from '../hermesEngineManager';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
  PermissionRequest,
} from './types';

const STREAMING_TEXT_MAX_CHARS = 120_000;
const HISTORY_MAX_MESSAGES = 32;
const HISTORY_MAX_MESSAGE_CHARS = 12_000;
const CONTENT_TRUNCATED_HINT = '\n...[truncated to prevent memory pressure]';
const HERMES_RUN_POLL_INTERVAL_MS = 1_500;
const HERMES_RUN_FETCH_TIMEOUT_MS = 30_000;
const HERMES_NO_VISIBLE_TIMEOUT_MS = 240_000;

type HermesRuntimeAdapterDeps = {
  store: CoworkStore;
  engineManager: HermesEngineManager;
  ensureRunning: () => Promise<HermesEngineStatus>;
};

type ActiveHermesSession = {
  sessionId: string;
  controller: AbortController;
  assistantMessageId: string | null;
  assistantContent: string;
  runId: string | null;
  sawVisibleEvent: boolean;
  pendingApprovalIds: Set<string>;
  terminalStatus: HermesTerminalStatus | null;
  terminalError: string | null;
  noVisibleTimer: ReturnType<typeof setTimeout> | null;
  stopEvents: (() => void) | null;
};

type OpenAIMessage =
  | { role: 'system' | 'assistant'; content: string }
  | { role: 'user'; content: string | Array<Record<string, unknown>> };

type HermesRunEvent = {
  event?: string;
  type?: string;
  event_type?: string;
  run_id?: string;
  runId?: string;
  delta?: string;
  content?: string;
  message?: string;
  output?: string;
  tool?: string;
  preview?: string;
  duration?: number;
  error?: string | boolean;
  text?: string;
  request_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | null;
  tool_use_id?: string | null;
  id?: string;
  choice?: string;
  resolved?: number;
  usage?: Record<string, number | null>;
  timestamp?: number;
};

type HermesTerminalStatus = 'completed' | 'failed' | 'cancelled';

const truncateLargeContent = (content: string, maxChars: number): string => {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}${CONTENT_TRUNCATED_HINT}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
};

export class HermesRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly store: CoworkStore;
  private readonly engineManager: HermesEngineManager;
  private readonly ensureRunning: () => Promise<HermesEngineStatus>;
  private readonly activeSessions = new Map<string, ActiveHermesSession>();
  private readonly stoppedSessions = new Set<string>();

  constructor(deps: HermesRuntimeAdapterDeps) {
    super();
    this.store = deps.store;
    this.engineManager = deps.engineManager;
    this.ensureRunning = deps.ensureRunning;
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(sessionId: string, prompt: string, options: CoworkStartOptions = {}): Promise<void> {
    await this.runTurn(sessionId, prompt, options, !options.skipInitialUserMessage);
  }

  async continueSession(sessionId: string, prompt: string, options: CoworkContinueOptions = {}): Promise<void> {
    await this.runTurn(sessionId, prompt, options, true);
  }

  stopSession(sessionId: string): void {
    this.stoppedSessions.add(sessionId);
    const active = this.activeSessions.get(sessionId);
    if (active) {
      this.detachActiveSession(active);
      void this.requestHermesStop(active).catch((error) => {
        console.warn('[HermesRuntimeAdapter] failed to stop Hermes run:', error);
      });
      this.activeSessions.delete(sessionId);
    }
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emit('sessionStopped', sessionId);
  }

  stopAllSessions(): void {
    for (const sessionId of Array.from(this.activeSessions.keys())) {
      this.stopSession(sessionId);
    }
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const active = Array.from(this.activeSessions.values())
      .find((candidate) => candidate.pendingApprovalIds.has(requestId));
    if (!active?.runId) {
      console.warn('[HermesRuntimeAdapter] approval response did not match an active Hermes request');
      return;
    }
    const choice = result.behavior === 'allow' ? 'once' : 'deny';
    void this.postHermesApproval(active, requestId, choice, false)
      .then((posted) => {
        if (posted) {
          active.pendingApprovalIds.delete(requestId);
        }
      })
      .catch((error) => {
        console.warn('[HermesRuntimeAdapter] failed to post Hermes approval:', error);
      });
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  getSessionConfirmationMode(_sessionId: string): 'modal' | 'text' | null {
    return null;
  }

  onSessionDeleted(sessionId: string): void {
    this.stopSession(sessionId);
    this.stoppedSessions.delete(sessionId);
  }

  private async runTurn(
    sessionId: string,
    prompt: string,
    options: CoworkStartOptions | CoworkContinueOptions,
    shouldAddUserMessage: boolean,
  ): Promise<void> {
    if (this.activeSessions.has(sessionId)) {
      throw new Error('This session is already running.');
    }
    this.stoppedSessions.delete(sessionId);
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    this.store.updateSession(sessionId, { status: 'running' });

    if (shouldAddUserMessage) {
      const metadata: Record<string, unknown> = {};
      if (options.skillIds?.length) {
        metadata.skillIds = options.skillIds;
      }
      if (options.imageAttachments?.length) {
        metadata.imageAttachments = options.imageAttachments;
      }
      const message = this.store.addMessage(sessionId, {
        type: 'user',
        content: prompt,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
      this.emit('message', sessionId, message);
    }

    const engineStatus = await this.ensureRunning();
    if (engineStatus.phase !== 'running') {
      this.handleError(sessionId, engineStatus.message || 'Hermes Agent gateway is not ready.');
      return;
    }

    const connection = this.engineManager.getConnectionInfo();
    if (!connection.url || !connection.token) {
      this.handleError(sessionId, 'Hermes Agent gateway connection info is unavailable.');
      return;
    }

    const controller = new AbortController();
    const active: ActiveHermesSession = {
      sessionId,
      controller,
      assistantMessageId: null,
      assistantContent: '',
      runId: null,
      sawVisibleEvent: false,
      pendingApprovalIds: new Set<string>(),
      terminalStatus: null,
      terminalError: null,
      noVisibleTimer: null,
      stopEvents: null,
    };
    this.activeSessions.set(sessionId, active);

    active.noVisibleTimer = setTimeout(() => {
      if (this.activeSessions.get(sessionId) !== active) return;
      if (active.sawVisibleEvent) return;
      this.addToolMessage(active, {
        type: 'tool_result',
        content: t('hermesNoVisibleOutput', {
          seconds: Math.round(HERMES_NO_VISIBLE_TIMEOUT_MS / 1000),
        }),
        metadata: {
          toolName: 'Hermes Agent',
          isStreaming: false,
        },
      });
      active.noVisibleTimer = null;
    }, HERMES_NO_VISIBLE_TIMEOUT_MS);

    const messages = this.buildMessages(
      sessionId,
      prompt,
      options.systemPrompt ?? session.systemPrompt,
      options.imageAttachments,
    );
    const runInput = this.buildRunInput(messages);
    const instructions = this.extractSystemPrompt(messages);
    const conversationHistory = this.buildConversationHistory(messages);

    try {
      const { runId, stopEvents } = await this.startHermesRun(
        active,
        connection.url,
        connection.token,
        runInput,
        instructions,
        conversationHistory,
      );
      active.runId = runId;
      active.stopEvents = stopEvents;
      const terminalStatus = await this.waitForRunCompletion(active, runId, connection.url, connection.token);
      if (terminalStatus) {
        active.terminalStatus = terminalStatus;
      }
    } catch (error) {
      this.detachActiveSession(active);
      this.activeSessions.delete(sessionId);
      if (this.stoppedSessions.has(sessionId)) {
        this.store.updateSession(sessionId, { status: 'idle' });
        this.emit('sessionStopped', sessionId);
        return;
      }
      this.handleError(sessionId, error instanceof Error ? error.message : String(error));
      return;
    }

    this.detachActiveSession(active);
    this.activeSessions.delete(sessionId);

    if (this.stoppedSessions.has(sessionId)) {
      this.store.updateSession(sessionId, { status: 'idle' });
      this.emit('sessionStopped', sessionId);
      return;
    }

    if (active.terminalStatus === 'failed') {
      this.handleError(sessionId, active.terminalError ?? 'Hermes Agent run failed.');
      return;
    }
    if (active.terminalStatus === 'cancelled') {
      this.handleError(sessionId, active.terminalError ?? 'Hermes Agent run was cancelled.');
      return;
    }

    if (!active.sawVisibleEvent) {
      this.handleError(sessionId, 'Hermes Agent returned no visible response. Check the Hermes Agent model provider and gateway logs for details.');
      return;
    }
    this.finalizeAssistant(active);
    this.store.updateSession(sessionId, { status: 'completed', claudeSessionId: active.runId ?? connection.version });
    this.emit('complete', sessionId, active.runId ?? connection.version);
  }

  private buildMessages(
    sessionId: string,
    prompt: string,
    systemPrompt: string,
    imageAttachments?: CoworkStartOptions['imageAttachments'],
  ): OpenAIMessage[] {
    const session = this.store.getSession(sessionId);
    const messages: OpenAIMessage[] = [];
    if (systemPrompt.trim()) {
      messages.push({ role: 'system', content: systemPrompt.trim() });
    }

    const history = [...(session?.messages ?? [])];
    const last = history[history.length - 1];
    if (last?.type === 'user' && last.content === prompt) {
      history.pop();
    }

    const selected = history
      .filter((message) => message.type === 'user' || message.type === 'assistant')
      .slice(-HISTORY_MAX_MESSAGES);
    for (const message of selected) {
      const content = truncateLargeContent(message.content, HISTORY_MAX_MESSAGE_CHARS);
      messages.push({
        role: message.type === 'assistant' ? 'assistant' : 'user',
        content,
      });
    }

    messages.push({
      role: 'user',
      content: this.buildCurrentUserContent(prompt, imageAttachments),
    });
    return messages;
  }

  private buildCurrentUserContent(
    prompt: string,
    imageAttachments?: CoworkStartOptions['imageAttachments'],
  ): string | Array<Record<string, unknown>> {
    if (!imageAttachments?.length) return prompt;
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: prompt },
    ];
    for (const image of imageAttachments) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType};base64,${image.base64Data}`,
          detail: 'auto',
        },
      });
    }
    return content;
  }

  private extractSystemPrompt(messages: OpenAIMessage[]): string {
    const systemMessages = messages.filter((message) => message.role === 'system');
    if (systemMessages.length === 0) return '';
    return systemMessages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .filter((content) => content.trim())
      .join('\n\n');
  }

  private buildConversationHistory(messages: OpenAIMessage[]): Array<{ role: string; content: string }> {
    const history: Array<{ role: string; content: string }> = [];
    for (const message of messages) {
      if (message.role === 'system') continue;
      if (typeof message.content !== 'string') continue;
      if (!message.content.trim()) continue;
      history.push({ role: message.role, content: message.content });
    }
    if (history.length === 0) return [];
    // Drop the trailing user message — it is sent as `input` on the run.
    return history.slice(0, -1);
  }

  private buildRunInput(messages: OpenAIMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
        return message.content;
      }
    }
    return '';
  }

  private async startHermesRun(
    active: ActiveHermesSession,
    gatewayUrl: string,
    token: string,
    input: string,
    instructions: string,
    conversationHistory: Array<{ role: string; content: string }>,
  ): Promise<{ runId: string; stopEvents: () => void }> {
    const requestId = randomUUID();
    const body: Record<string, unknown> = {
      input,
    };
    if (instructions.trim()) {
      body.instructions = instructions;
    }
    if (conversationHistory.length > 0) {
      body.conversation_history = conversationHistory;
    }
    const response = await fetch(`${gatewayUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-WeSight-Request-Id': requestId,
      },
      body: JSON.stringify(body),
      signal: active.controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch((): string => '');
      throw new Error(`Hermes Agent run failed to start (${response.status}): ${detail || response.statusText}`);
    }

    const payload = await response.json().catch((): null => null);
    const runId = isRecord(payload) ? firstString(payload.run_id, payload.runId, payload.id) : null;
    if (!runId) {
      throw new Error('Hermes Agent did not return a run identifier.');
    }

    const stopEvents = this.subscribeToRunEvents(active, gatewayUrl, token, runId);
    return { runId, stopEvents };
  }

  private subscribeToRunEvents(
    active: ActiveHermesSession,
    gatewayUrl: string,
    token: string,
    runId: string,
  ): () => void {
    const stopFlag = { stopped: false };
    const stop = () => {
      stopFlag.stopped = true;
    };

    void (async () => {
      let pollDelay = 0;
      while (!stopFlag.stopped) {
        if (pollDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, pollDelay));
          pollDelay = 0;
        }
        if (stopFlag.stopped) return;
        try {
          const completed = await this.consumeRunEventStream(active, gatewayUrl, token, runId, stopFlag);
          if (completed || stopFlag.stopped) return;
          pollDelay = HERMES_RUN_POLL_INTERVAL_MS;
        } catch (error) {
          if (stopFlag.stopped) return;
          if (active.controller.signal.aborted) return;
          console.warn('[HermesRuntimeAdapter] run event stream failed, will retry:', error);
          pollDelay = HERMES_RUN_POLL_INTERVAL_MS;
        }
      }
    })();

    return stop;
  }

  private async consumeRunEventStream(
    active: ActiveHermesSession,
    gatewayUrl: string,
    token: string,
    runId: string,
    stopFlag: { stopped: boolean },
  ): Promise<boolean> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    active.controller.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(`${gatewayUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch((): string => '');
        throw new Error(`Hermes run events stream returned ${response.status}: ${detail || response.statusText}`);
      }

      if (!response.body) {
        return true;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;
      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) {
          streamDone = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const completed = this.handleRunEventFrame(active, frame, stopFlag);
          if (completed) {
            try {
              await reader.cancel();
            } catch {
              // Reader may already be closed.
            }
            return true;
          }
          if (stopFlag.stopped) {
            try {
              await reader.cancel();
            } catch {
              // Reader may already be closed.
            }
            return true;
          }
        }
        if (!buffer.includes('\n\n') && !buffer.includes('\r\n\r\n') && !buffer.trimStart().startsWith('event:')) {
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const completed = this.handleRunEventFrame(active, line, stopFlag);
            if (completed) {
              try {
                await reader.cancel();
              } catch {
                // Reader may already be closed.
              }
              return true;
            }
          }
        }
      }
      if (buffer.trim()) {
        const completed = this.handleRunEventFrame(active, buffer, stopFlag);
        if (completed) return true;
      }
      return false;
    } finally {
      active.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private handleRunEventFrame(
    active: ActiveHermesSession,
    frame: string,
    stopFlag: { stopped: boolean },
  ): boolean {
    const parsed = this.parseRunEventFrame(frame);
    if (!parsed) return false;
    const { eventName: frameEventName, payload } = parsed;
    if (!payload || payload === '[DONE]') return false;

    let event: HermesRunEvent;
    try {
      event = JSON.parse(payload) as HermesRunEvent;
    } catch {
      return false;
    }
    if (!isRecord(event)) return false;

    const eventName = frameEventName
      ?? firstString(event.event, event.type, event.event_type)
      ?? '';

    if (eventName === 'message.delta') {
      const delta = firstString(event.delta, event.content, event.message);
      if (delta) {
        this.appendAssistant(active, delta);
      }
      return false;
    }
    if (eventName === 'tool.started') {
      this.markVisible(active);
      const toolName = firstString(event.tool) ?? 'Hermes Tool';
      const preview = firstString(event.preview);
      this.addToolMessage(active, {
        type: 'tool_use',
        content: preview ?? `Using tool: ${toolName}`,
        metadata: {
          toolName,
          toolInput: { preview: preview ?? '' },
          toolUseId: firstString((event as Record<string, unknown>).tool_use_id, event.id) ?? undefined,
        },
      });
      return false;
    }
    if (eventName === 'tool.completed') {
      this.markVisible(active);
      const toolName = firstString(event.tool) ?? 'Hermes Tool';
      const toolUseId = firstString((event as Record<string, unknown>).tool_use_id, event.id) ?? undefined;
      const isError = event.error === true;
      this.addToolMessage(active, {
        type: 'tool_result',
        content: isError
          ? `Hermes tool ${toolName} reported an error.`
          : `Hermes tool ${toolName} completed.`,
        metadata: {
          toolName,
          toolUseId,
          isError,
        },
      });
      return false;
    }
    if (eventName === 'reasoning.available') {
      this.markVisible(active);
      const text = firstString(event.text);
      if (text) {
        this.addToolMessage(active, {
          type: 'tool_result',
          content: text,
          metadata: {
            toolName: 'Hermes Think',
            isThinking: true,
            isStreaming: false,
          },
        });
      }
      return false;
    }
    if (eventName === 'approval.request') {
      this.markVisible(active);
      this.handleApprovalRequest(active, event);
      return false;
    }
    if (eventName === 'approval.responded') {
      return false;
    }
    if (eventName === 'run.completed' || eventName === 'run.failed' || eventName === 'run.cancelled') {
      this.handleTerminalRunEvent(active, event, eventName);
      stopFlag.stopped = true;
      return true;
    }
    return false;
  }

  private parseRunEventFrame(frame: string): { eventName: string | null; payload: string } | null {
    const trimmed = frame.trim();
    if (!trimmed || trimmed.startsWith(':')) return null;
    const lines = frame.split(/\r?\n/);
    let eventName: string | null = null;
    const dataLines: string[] = [];
    const rawLines: string[] = [];
    for (const line of lines) {
      const current = line.trimEnd();
      if (!current || current.startsWith(':')) continue;
      if (current.startsWith('event:')) {
        eventName = firstString(current.slice('event:'.length).trim());
        continue;
      }
      if (current.startsWith('data:')) {
        dataLines.push(current.slice('data:'.length).trimStart());
        continue;
      }
      if (current.startsWith('id:') || current.startsWith('retry:')) {
        continue;
      }
      rawLines.push(current.trim());
    }
    const payload = dataLines.length > 0 ? dataLines.join('\n').trim() : rawLines.join('\n').trim();
    if (!payload) return null;
    return { eventName, payload };
  }

  private handleApprovalRequest(active: ActiveHermesSession, event: HermesRunEvent): void {
    const requestId = firstString(event.request_id, event.id);
    if (!requestId) return;
    active.pendingApprovalIds.add(requestId);
    const toolName = firstString(event.tool_name, event.tool) ?? 'Hermes Tool';
    const toolInput = isRecord(event.tool_input) ? event.tool_input : {};
    const toolUseId = firstString(event.tool_use_id) ?? null;
    const permissionRequest: PermissionRequest = {
      requestId,
      toolName,
      toolInput,
      toolUseId,
    };
    this.emit('permissionRequest', active.sessionId, permissionRequest);
  }

  private handleTerminalRunEvent(
    active: ActiveHermesSession,
    event: HermesRunEvent,
    eventName: string,
  ): void {
    if (eventName === 'run.completed') {
      const output = firstString(event.output);
      if (output) {
        this.replaceAssistant(active, output, true);
      }
      this.markVisible(active);
      active.terminalStatus = 'completed';
      return;
    }
    const errorMessage = firstString(event.error) ?? 'Hermes Agent run failed.';
    active.terminalStatus = eventName === 'run.cancelled' ? 'cancelled' : 'failed';
    active.terminalError = errorMessage;
    this.appendAssistant(active, `\n\n[${errorMessage}]`);
    this.markVisible(active);
  }

  private async waitForRunCompletion(
    active: ActiveHermesSession,
    runId: string,
    gatewayUrl: string,
    token: string,
  ): Promise<HermesTerminalStatus | null> {
    // The event stream drives lifecycle transitions; this is a safety net for
    // the case where the SSE connection stalls mid-run.
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      if (active.terminalStatus) return active.terminalStatus;
      if (active.controller.signal.aborted) return null;
      if (this.stoppedSessions.has(active.sessionId)) return null;
      const status = await this.fetchRunStatus(gatewayUrl, token, runId);
      if (!status) {
        await new Promise((resolve) => setTimeout(resolve, HERMES_RUN_POLL_INTERVAL_MS));
        continue;
      }
      const phase = firstString(status.phase, status.status);
      if (phase === 'completed') {
        active.terminalStatus = 'completed';
        return 'completed';
      }
      if (phase === 'failed' || phase === 'cancelled') {
        active.terminalStatus = phase;
        active.terminalError = status.error ?? null;
        return phase;
      }
      await new Promise((resolve) => setTimeout(resolve, HERMES_RUN_POLL_INTERVAL_MS));
    }
    return null;
  }

  private async fetchRunStatus(
    gatewayUrl: string,
    token: string,
    runId: string,
  ): Promise<{ phase?: string; status?: string; error?: string } | null> {
    try {
      const response = await fetch(`${gatewayUrl}/v1/runs/${encodeURIComponent(runId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(HERMES_RUN_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const payload = await response.json().catch((): null => null);
      if (!isRecord(payload)) return null;
      return {
        phase: firstString(payload.phase) ?? undefined,
        status: firstString(payload.status) ?? undefined,
        error: firstString(payload.error, payload.message) ?? undefined,
      };
    } catch {
      return null;
    }
  }

  private async postHermesApproval(
    active: ActiveHermesSession,
    requestId: string,
    choice: 'once' | 'session' | 'always' | 'deny',
    all: boolean,
  ): Promise<boolean> {
    const runId = active.runId;
    if (!runId) return false;
    const connection = this.engineManager.getConnectionInfo();
    if (!connection.url || !connection.token) return false;
    try {
      const response = await fetch(`${connection.url}/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          request_id: requestId,
          id: requestId,
          choice,
          all,
        }),
        signal: AbortSignal.timeout(HERMES_RUN_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        const detail = await response.text().catch((): string => '');
        console.warn('[HermesRuntimeAdapter] approval request failed:', response.status, detail);
        return false;
      }
      return true;
    } catch (error) {
      console.warn('[HermesRuntimeAdapter] approval request errored:', error);
      return false;
    }
  }

  private async requestHermesStop(active: ActiveHermesSession): Promise<void> {
    const runId = active.runId;
    if (!runId) return;
    const connection = this.engineManager.getConnectionInfo();
    if (!connection.url || !connection.token) return;
    try {
      await fetch(`${connection.url}/v1/runs/${encodeURIComponent(runId)}/stop`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.token}`,
        },
        signal: AbortSignal.timeout(HERMES_RUN_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      console.warn('[HermesRuntimeAdapter] failed to stop Hermes run:', error);
    }
  }

  private appendAssistant(active: ActiveHermesSession, delta: string): void {
    if (!delta) return;
    this.markVisible(active);
    const next = truncateLargeContent(`${active.assistantContent}${delta}`, STREAMING_TEXT_MAX_CHARS);
    this.replaceAssistant(active, next, false);
  }

  private replaceAssistant(active: ActiveHermesSession, content: string, isFinal: boolean): void {
    const safeContent = truncateLargeContent(content, STREAMING_TEXT_MAX_CHARS);
    active.assistantContent = safeContent;
    if (!active.assistantMessageId) {
      const message = this.store.addMessage(active.sessionId, {
        type: 'assistant',
        content: safeContent,
        metadata: { isStreaming: !isFinal, isFinal },
      });
      active.assistantMessageId = message.id;
      this.emit('message', active.sessionId, message);
      return;
    }
    this.store.updateMessage(active.sessionId, active.assistantMessageId, {
      content: safeContent,
      metadata: { isStreaming: !isFinal, isFinal },
    });
    this.emit('messageUpdate', active.sessionId, active.assistantMessageId, safeContent);
  }

  private finalizeAssistant(active: ActiveHermesSession): void {
    if (!active.assistantMessageId) return;
    this.store.updateMessage(active.sessionId, active.assistantMessageId, {
      content: active.assistantContent,
      metadata: { isStreaming: false, isFinal: true },
    });
    this.emit('messageUpdate', active.sessionId, active.assistantMessageId, active.assistantContent);
  }

  private addToolMessage(
    active: ActiveHermesSession,
    message: {
      type: 'tool_use' | 'tool_result';
      content: string;
      metadata?: Record<string, unknown>;
    },
  ): void {
    const created = this.store.addMessage(active.sessionId, message);
    this.emit('message', active.sessionId, created);
  }

  private markVisible(active: ActiveHermesSession): void {
    if (active.sawVisibleEvent) return;
    active.sawVisibleEvent = true;
    if (active.noVisibleTimer) {
      clearTimeout(active.noVisibleTimer);
      active.noVisibleTimer = null;
    }
  }

  private detachActiveSession(active: ActiveHermesSession): void {
    if (active.noVisibleTimer) {
      clearTimeout(active.noVisibleTimer);
      active.noVisibleTimer = null;
    }
    if (active.stopEvents) {
      try {
        active.stopEvents();
      } catch (error) {
        console.warn('[HermesRuntimeAdapter] failed to stop event stream:', error);
      }
      active.stopEvents = null;
    }
    active.pendingApprovalIds.clear();
    if (!active.controller.signal.aborted) {
      active.controller.abort();
    }
  }

  private handleError(sessionId: string, error: string): void {
    if (this.stoppedSessions.has(sessionId)) return;
    if (this.store.getSession(sessionId)?.status === 'error') return;
    this.store.updateSession(sessionId, { status: 'error' });
    this.emit('error', sessionId, error);
  }

}
