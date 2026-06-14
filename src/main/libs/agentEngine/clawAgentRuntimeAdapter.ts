import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

import type { CoworkMessage, CoworkStore } from '../../coworkStore';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
} from './types';

/**
 * ClawAgentRuntimeAdapter — connects WeSight to a remote, self-hosted DevClaw
 * Claw agent over its OpenClaw-compatible `/ws/openclaw` gateway.
 *
 * Unlike OpenClawRuntimeAdapter (which spawns + manages a LOCAL OpenClaw via
 * engineManager and loads OpenClaw's own GatewayClient), this adapter connects
 * to a CONFIGURED remote gateway URL with a plain WebSocket and speaks the
 * 3-frame v3 protocol directly. It consumes the Claw agent's NATIVE streaming
 * event vocabulary (`agent.stream` / `agent` / `agent.reasoning`, keyed by
 * `sessionId`) — NOT OpenClaw's `chat` delta/final shape — and translates it
 * into WeSight's CoworkRuntime message model. See
 * devclaw docs/rfcs/wesight-desktop-client.md §2.3.
 *
 * Config via env (for the integration test):
 *   CLAW_AGENT_GATEWAY_URL  e.g. ws://127.0.0.1:9820/ws/openclaw
 *   CLAW_AGENT_TOKEN        optional x-api-key (only if the agent sets ADMIN_PASS)
 */

type ClawAgentConfig = {
  gatewayUrl: string;
  token?: string;
};

type GatewayFrame = {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
  event?: string;
  seq?: number;
};

type ActiveTurn = {
  sessionId: string;
  assistantMessageId: string | null;
  currentText: string;
  reasoningMessageId: string | null;
  currentReasoning: string;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v));

const getStr = (v: unknown): string => (typeof v === 'string' ? v : '');

export function resolveClawAgentConfig(): ClawAgentConfig | null {
  const gatewayUrl = (process.env.CLAW_AGENT_GATEWAY_URL || '').trim();
  if (!gatewayUrl) return null;
  const token = (process.env.CLAW_AGENT_TOKEN || '').trim();
  return { gatewayUrl, token: token || undefined };
}

export class ClawAgentRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly store: CoworkStore;
  private readonly resolveConfig: () => ClawAgentConfig;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private helloOk = false;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  /** Maps the agent-returned sessionId (from chat.send) → local WeSight sessionId, so
   *  streamed events (keyed by the agent's sessionId) route to the right turn even when
   *  the agent uses a different session (e.g. its main session) than we requested. */
  private readonly agentSessionToLocal = new Map<string, string>();
  private readonly pendingReqs = new Map<
    string,
    { resolve: (payload: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();

  constructor(store: CoworkStore, resolveConfig: () => ClawAgentConfig) {
    super();
    this.store = store;
    this.resolveConfig = resolveConfig;
  }

  override on<U extends keyof CoworkRuntimeEvents>(event: U, listener: CoworkRuntimeEvents[U]): this {
    return super.on(event, listener);
  }
  override off<U extends keyof CoworkRuntimeEvents>(event: U, listener: CoworkRuntimeEvents[U]): this {
    return super.off(event, listener);
  }

  async startSession(sessionId: string, prompt: string, options: CoworkStartOptions = {}): Promise<void> {
    await this.runTurn(sessionId, prompt, options.skipInitialUserMessage);
  }

  async continueSession(sessionId: string, prompt: string, _options: CoworkContinueOptions = {}): Promise<void> {
    await this.runTurn(sessionId, prompt, false);
  }

  stopSession(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn && this.helloOk) {
      void this.request('chat.abort', { session_id: sessionId }).catch(() => {});
    }
    this.store.updateSession(sessionId, { status: 'idle' });
    this.settleTurn(sessionId, null);
    this.emit('sessionStopped', sessionId);
  }

  stopAllSessions(): void {
    for (const sessionId of Array.from(this.activeTurns.keys())) {
      this.stopSession(sessionId);
    }
  }

  // Claw agents auto-apply tool policy server-side; there is no exec.approval
  // round-trip on /ws/openclaw, so permission responses are a no-op here.
  respondToPermission(_requestId: string, _result: PermissionResult): void {}

  isSessionActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  getSessionConfirmationMode(_sessionId: string): 'modal' | 'text' | null {
    return null;
  }

  onSessionDeleted(sessionId: string): void {
    this.settleTurn(sessionId, null);
  }

  // ── core turn ──────────────────────────────────────────────────────────────

  private async runTurn(sessionId: string, prompt: string, skipInitialUserMessage?: boolean): Promise<void> {
    if (!prompt.trim()) throw new Error('Prompt is required.');
    if (this.activeTurns.has(sessionId)) throw new Error(`Session ${sessionId} is still running.`);
    if (!this.store.getSession(sessionId)) throw new Error(`Session ${sessionId} not found`);

    if (!skipInitialUserMessage) {
      const userMessage = this.store.addMessage(sessionId, { type: 'user', content: prompt });
      this.emit('message', sessionId, userMessage);
    }

    this.store.updateSession(sessionId, { status: 'running' });
    await this.ensureConnected();

    const completion = new Promise<void>((resolve, reject) => {
      this.activeTurns.set(sessionId, {
        sessionId,
        assistantMessageId: null,
        currentText: '',
        reasoningMessageId: null,
        currentReasoning: '',
        resolve,
        reject,
        settled: false,
      });
    });

    try {
      const sendResult = await this.request('chat.send', { session_id: sessionId, message: prompt });
      const agentSessionId = getStr(sendResult.sessionId).trim();
      if (agentSessionId && agentSessionId !== sessionId) {
        this.agentSessionToLocal.set(agentSessionId, sessionId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateSession(sessionId, { status: 'error' });
      this.failTurn(sessionId, message);
      throw error;
    }

    await completion;
  }

  // ── connection + handshake ──────────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.helloOk) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect();
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    const resolved = this.resolveConfig();
    const gatewayUrl = (resolved.gatewayUrl || '').trim();
    if (!gatewayUrl) {
      this.connectPromise = null;
      throw new Error('Claw agent gateway URL is not configured (set it in Settings or CLAW_AGENT_GATEWAY_URL).');
    }
    const token = (resolved.token || '').trim();
    let headers: Record<string, string> | undefined;
    try {
      headers = await this.buildAuthHeaders(gatewayUrl, token);
    } catch {
      headers = token ? { 'x-api-key': token } : undefined;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        reject(e);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      try {
        const ws = new WebSocket(gatewayUrl, headers ? { headers } : undefined);
        this.ws = ws;
        this.helloOk = false;

        const timeout = setTimeout(() => fail(new Error('Claw agent gateway handshake timeout')), 15_000);

        ws.onmessage = (ev) => {
          let frame: GatewayFrame;
          try {
            frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as GatewayFrame;
          } catch {
            return;
          }
          // Handshake phase 1: server sends connect.challenge → reply with connect req.
          if (frame.type === 'event' && frame.event === 'connect.challenge') {
            const connectId = randomUUID();
            this.pendingReqs.set(connectId, {
              resolve: () => {
                clearTimeout(timeout);
                this.helloOk = true;
                ok();
              },
              reject: (e) => {
                clearTimeout(timeout);
                fail(e);
              },
            });
            this.send({ type: 'req', id: connectId, method: 'connect', params: {} });
            return;
          }
          this.handleFrame(frame);
        };

        ws.onerror = () => fail(new Error('Claw agent gateway connection error'));
        ws.onclose = () => {
          clearTimeout(timeout);
          this.helloOk = false;
          this.ws = null;
          this.connectPromise = null;
          const disconnected = new Error('Claw agent gateway disconnected');
          for (const [, pending] of this.pendingReqs) pending.reject(disconnected);
          this.pendingReqs.clear();
          for (const sessionId of Array.from(this.activeTurns.keys())) {
            this.store.updateSession(sessionId, { status: 'error' });
            this.emit('error', sessionId, disconnected.message);
            this.failTurn(sessionId, disconnected.message);
          }
          fail(disconnected);
        };
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Authenticate against the Claw agent. Tries cookie login first
   * (POST /api/login {password} → claw_token cookie, the ADMIN_PASS model),
   * then falls back to an x-api-key header (the API_KEY model). Returns the WS
   * headers, or undefined for a no-auth agent.
   */
  private async buildAuthHeaders(
    gatewayUrl: string,
    token: string,
  ): Promise<Record<string, string> | undefined> {
    if (!token) return undefined;
    const httpBase = gatewayUrl.replace(/^ws/i, 'http').replace(/\/ws\/openclaw\/?$/i, '');
    try {
      const resp = await fetch(`${httpBase}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: token }),
      });
      if (resp.ok) {
        const h = resp.headers as Headers & { getSetCookie?: () => string[] };
        const setCookie =
          typeof h.getSetCookie === 'function' ? h.getSetCookie().join('; ') : h.get('set-cookie') || '';
        const match = setCookie.match(/claw_token=([^;]+)/);
        if (match) return { Cookie: `claw_token=${match[1]}` };
      }
    } catch {
      // network error → fall through to x-api-key
    }
    return { 'x-api-key': token };
  }

  private send(frame: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      this.pendingReqs.set(id, { resolve, reject });
      this.send({ type: 'req', id, method, params });
    });
  }

  // ── frame + event routing ─────────────────────────────────────────────────

  private handleFrame(frame: GatewayFrame): void {
    if (frame.type === 'res') {
      const id = getStr(frame.id);
      const pending = id ? this.pendingReqs.get(id) : undefined;
      if (!pending) return;
      this.pendingReqs.delete(id);
      if (frame.ok) {
        pending.resolve(isRecord(frame.payload) ? frame.payload : {});
      } else {
        pending.reject(new Error(frame.error?.message || frame.error?.code || 'Claw agent request failed'));
      }
      return;
    }
    if (frame.type === 'event') {
      this.handleEvent(getStr(frame.event), frame.payload);
    }
  }

  private handleEvent(event: string, payload: unknown): void {
    if (event === 'tick' || !isRecord(payload)) return;
    const eventSessionId = getStr(payload.sessionId);
    if (!eventSessionId) return;
    const sessionId = this.agentSessionToLocal.get(eventSessionId) || eventSessionId;
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    // agent.stream {sessionId, chunk} — incremental assistant text delta.
    if (event === 'agent.stream') {
      const chunk = getStr(payload.chunk);
      if (!chunk) return;
      turn.currentText += chunk;
      if (!turn.assistantMessageId) {
        const msg = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: turn.currentText,
          metadata: { isStreaming: true, isFinal: false },
        });
        turn.assistantMessageId = msg.id;
        this.emit('message', sessionId, msg);
      } else {
        this.store.updateMessage(sessionId, turn.assistantMessageId, {
          content: turn.currentText,
          metadata: { isStreaming: true, isFinal: false },
        });
        this.emit('messageUpdate', sessionId, turn.assistantMessageId, turn.currentText);
      }
      return;
    }

    // agent.reasoning {sessionId, chunk} — surfaced as a distinct thinking message.
    if (event === 'agent.reasoning') {
      const chunk = getStr(payload.chunk);
      if (!chunk) return;
      turn.currentReasoning += chunk;
      if (!turn.reasoningMessageId) {
        const msg = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: turn.currentReasoning,
          metadata: { isStreaming: true, isFinal: false, isThinking: true },
        });
        turn.reasoningMessageId = msg.id;
        this.emit('message', sessionId, msg);
      } else {
        this.store.updateMessage(sessionId, turn.reasoningMessageId, {
          content: turn.currentReasoning,
          metadata: { isStreaming: true, isFinal: false, isThinking: true },
        });
        this.emit('messageUpdate', sessionId, turn.reasoningMessageId, turn.currentReasoning);
      }
      return;
    }

    // agent {sessionId, content, status} — terminal frame (completed | error).
    if (event === 'agent') {
      const status = getStr(payload.status);
      const content = getStr(payload.content);
      const errorMessage = getStr(payload.error);

      if (status === 'error' || errorMessage) {
        const finalText = content || turn.currentText;
        if (finalText) this.finalizeAssistant(sessionId, turn, finalText);
        this.store.updateSession(sessionId, { status: 'error' });
        this.emit('error', sessionId, errorMessage || 'Claw agent run failed');
        this.failTurn(sessionId, errorMessage || 'Claw agent run failed');
        return;
      }

      if (status === 'completed') {
        const finalText = content || turn.currentText;
        this.finalizeReasoning(sessionId, turn);
        if (finalText) {
          this.finalizeAssistant(sessionId, turn, finalText);
        }
        this.store.updateSession(sessionId, { status: 'completed' });
        this.emit('complete', sessionId, null);
        this.settleTurn(sessionId, null);
      }
    }
  }

  private finalizeAssistant(sessionId: string, turn: ActiveTurn, finalText: string): void {
    if (turn.assistantMessageId) {
      this.store.updateMessage(sessionId, turn.assistantMessageId, {
        content: finalText,
        metadata: { isStreaming: false, isFinal: true },
      });
      this.emit('messageUpdate', sessionId, turn.assistantMessageId, finalText);
    } else {
      const msg = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: finalText,
        metadata: { isStreaming: false, isFinal: true },
      });
      turn.assistantMessageId = msg.id;
      this.emit('message', sessionId, msg);
    }
  }

  private finalizeReasoning(sessionId: string, turn: ActiveTurn): void {
    if (!turn.reasoningMessageId) return;
    this.store.updateMessage(sessionId, turn.reasoningMessageId, {
      metadata: { isStreaming: false, isFinal: true, isThinking: true },
    });
  }

  // ── turn lifecycle ──────────────────────────────────────────────────────────

  private settleTurn(sessionId: string, _unused: null): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    this.activeTurns.delete(sessionId);
    this.clearAgentSessionMapping(sessionId);
    if (!turn.settled) {
      turn.settled = true;
      turn.resolve();
    }
  }

  private failTurn(sessionId: string, message: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    this.activeTurns.delete(sessionId);
    this.clearAgentSessionMapping(sessionId);
    if (!turn.settled) {
      turn.settled = true;
      turn.reject(new Error(message));
    }
  }

  private clearAgentSessionMapping(localSessionId: string): void {
    for (const [agentId, localId] of this.agentSessionToLocal) {
      if (localId === localSessionId) this.agentSessionToLocal.delete(agentId);
    }
  }
}
