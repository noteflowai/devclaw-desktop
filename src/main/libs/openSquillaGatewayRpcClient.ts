type RpcResponse = {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: unknown;
};

type RpcEvent = {
  type?: string;
  event?: string;
  payload?: unknown;
  meta?: unknown;
  protocol?: unknown;
  policy?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type EventHandler = (payload: unknown, meta?: unknown) => void;

const OPEN_SQUILLA_RPC_PROTOCOL = 3;
const OPEN_SQUILLA_DEFAULT_WS_URL = 'ws://127.0.0.1:18791/ws';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const toError = (value: unknown, fallback: string): Error => {
  if (value instanceof Error) return value;
  if (typeof value === 'string' && value.trim()) return new Error(value);
  if (isRecord(value)) {
    const message = value.message || value.error || value.code;
    if (typeof message === 'string' && message.trim()) {
      return new Error(message);
    }
  }
  return new Error(fallback);
};

export class OpenSquillaGatewayRpcClient {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private helloPromise: Promise<void> | null = null;
  private helloResolve: (() => void) | null = null;
  private helloReject: ((error: Error) => void) | null = null;

  constructor(url = OPEN_SQUILLA_DEFAULT_WS_URL) {
    this.url = url;
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.helloPromise) {
      return this.helloPromise;
    }
    if (typeof WebSocket === 'undefined') {
      return Promise.reject(new Error('The current Electron runtime does not provide WebSocket.'));
    }

    this.helloPromise = new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
      try {
        this.ws = new WebSocket(this.url);
      } catch (error) {
        this.rejectHello(toError(error, 'Failed to open OpenSquilla gateway WebSocket.'));
        return;
      }

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };
      this.ws.onerror = () => {
        this.rejectHello(new Error('OpenSquilla gateway WebSocket connection failed.'));
      };
      this.ws.onclose = () => {
        const error = new Error('OpenSquilla gateway WebSocket closed.');
        this.rejectHello(error);
        for (const request of this.pending.values()) {
          request.reject(error);
        }
        this.pending.clear();
        this.ws = null;
      };
    });

    return this.helloPromise;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // Best effort only.
    }
    this.ws = null;
    this.helloPromise = null;
    this.helloResolve = null;
    this.helloReject = null;
    for (const request of this.pending.values()) {
      request.reject(new Error('OpenSquilla gateway WebSocket closed.'));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  on(event: string, handler: EventHandler): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)?.add(handler);
    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('OpenSquilla gateway WebSocket is not connected.');
    }
    const id = String(++this.nextRequestId);
    const payload = { type: 'req', id, method, params };
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.ws.send(JSON.stringify(payload));
    return result;
  }

  private handleMessage(raw: unknown): void {
    let data: RpcEvent | RpcResponse;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (data.type === 'event' && 'event' in data && data.event === 'connect.challenge') {
      this.sendConnectRequest();
      return;
    }

    if ('protocol' in data && data.protocol !== undefined) {
      this.resolveHello();
      return;
    }

    if (data.type === 'res') {
      this.handleResponse(data as RpcResponse);
      return;
    }

    if (data.type === 'event' && 'event' in data && typeof data.event === 'string') {
      const handlers = this.listeners.get(data.event);
      handlers?.forEach((handler) => handler(data.payload, data.meta));
      const wildcard = this.listeners.get('*');
      wildcard?.forEach((handler) => handler({ event: data.event, payload: data.payload }, data.meta));
    }
  }

  private sendConnectRequest(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = String(++this.nextRequestId);
    this.pending.set(id, {
      resolve: () => undefined,
      reject: (error) => this.rejectHello(error),
    });
    this.ws.send(JSON.stringify({
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: OPEN_SQUILLA_RPC_PROTOCOL,
        maxProtocol: OPEN_SQUILLA_RPC_PROTOCOL,
        client: { name: 'wesight' },
      },
    }));
  }

  private handleResponse(data: RpcResponse): void {
    const id = data.id;
    if (!id) return;
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    if (data.ok) {
      request.resolve(data.payload);
      return;
    }
    request.reject(toError(data.error, 'OpenSquilla gateway RPC failed.'));
  }

  private resolveHello(): void {
    const resolve = this.helloResolve;
    this.helloResolve = null;
    this.helloReject = null;
    resolve?.();
  }

  private rejectHello(error: Error): void {
    const reject = this.helloReject;
    this.helloPromise = null;
    this.helloResolve = null;
    this.helloReject = null;
    reject?.(error);
  }
}
