import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_DISCONNECTED,
  TRANSPORT_STATE_RECONNECTING,
  TRANSPORT_STATE_REJECTED,
  WS_CLOSE_UNAUTHORIZED,
} from '../../../core/src/constants.js';
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport, TransportState } from './types.js';

/**
 * WebSocket transport for standalone browser mode.
 * Connects to the pixelmates server via WebSocket for bidirectional messaging.
 * Includes automatic reconnection with exponential backoff and message queuing.
 * A close with WS_CLOSE_UNAUTHORIZED is terminal (`rejected`): the server refused the
 * token, and every retry would send the same one.
 */
export class WebSocketTransport implements MessageTransport {
  private ws: WebSocket | null = null;
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private stateHandlers: Array<(state: TransportState) => void> = [];
  private reconnectHandlers: Array<() => void> = [];
  private url: string;
  private reconnectAttempts = 0;
  /** Opens in this page session: every one after the first is a reconnect. */
  private openCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private warnedDroppedSend = false;
  private pendingMessages: ClientMessage[] = [];
  private _state: TransportState = TRANSPORT_STATE_CONNECTING;
  private readonly _ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(url: string) {
    this.url = url;
    this._ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  get state(): TransportState {
    return this._state;
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  private setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    for (const handler of this.stateHandlers) handler(next);
  }

  connect(): void {
    if (this.disposed) return;

    // First attempt is "connecting"; any retry after a drop is "reconnecting".
    this.setState(
      this.reconnectAttempts > 0 ? TRANSPORT_STATE_RECONNECTING : TRANSPORT_STATE_CONNECTING,
    );

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.openCount++;
      this.reconnectAttempts = 0;
      console.log('[Transport] WebSocket connected');
      this.setState(TRANSPORT_STATE_CONNECTED);
      this.resolveReady();
      // Flush any messages queued while connecting, before what a reconnect handler sends:
      // they were meant to reach the server first.
      for (const msg of this.pendingMessages) {
        this.ws!.send(JSON.stringify(msg));
      }
      this.pendingMessages = [];
      if (this.openCount > 1) {
        for (const handler of this.reconnectHandlers) handler();
      }
    };

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        for (const handler of this.handlers) handler(msg);
      } catch {
        // Malformed JSON, ignore
      }
    };

    this.ws.onclose = (e: CloseEvent) => {
      if (this.disposed) return;
      if (e.code === WS_CLOSE_UNAUTHORIZED) {
        // A server restarted with another token. Only the link the CLI printed helps.
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.pendingMessages = [];
        this.setState(TRANSPORT_STATE_REJECTED);
        return;
      }
      this.setState(TRANSPORT_STATE_RECONNECTING);
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
    };
  }

  send(message: ClientMessage): void {
    if (this._state === TRANSPORT_STATE_REJECTED) {
      // Nothing will ever carry it: queueing would only grow.
      if (!this.warnedDroppedSend) {
        this.warnedDroppedSend = true;
        console.warn('[Transport] The server refused this page; outgoing messages are dropped');
      }
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue messages while connecting (flushed in onopen)
      this.pendingMessages.push(message);
    }
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /**
   * Deliver an externally-sourced message to all handlers, as if it had arrived
   * over the socket. Used in Vite dev mode to bridge `browserMock`'s injected
   * `window` messages (there is no real server to connect to in dev).
   */
  deliver(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter((h) => h !== handler);
    };
  }

  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.push(handler);
    return () => {
      this.reconnectHandlers = this.reconnectHandlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.handlers = [];
    this.reconnectHandlers = [];
    this.pendingMessages = [];
    this.setState(TRANSPORT_STATE_DISCONNECTED);
    this.stateHandlers = [];
  }

  private scheduleReconnect(): void {
    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;
    console.log(
      `[Transport] WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
