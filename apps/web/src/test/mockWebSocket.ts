/**
 * WebSocket falso para pruebas: registra instancias, mensajes enviados y permite
 * simular apertura (con subprotocolo negociado), mensajes del servidor (texto o
 * binarios) y cierres con código. Se instala con vi.stubGlobal.
 */
export type SentFrame = string | ArrayBufferLike | ArrayBufferView;

export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  /** Subprotocolo aceptado por el "servidor" (se fija en open()). */
  protocol = '';
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  readyState = MockWebSocket.CONNECTING;
  sent: SentFrame[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  static reset() {
    MockWebSocket.instances = [];
  }

  static last(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  send(data: SentFrame) {
    this.sent.push(data);
  }

  /** Cierre (del cliente o simulado del servidor) con código y razón opcionales. */
  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  /** Simula el handshake exitoso, opcionalmente aceptando un subprotocolo. */
  open(protocol = '') {
    this.protocol = protocol;
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** Simula un mensaje JSON (o texto crudo) del servidor. */
  receive(payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Simula un frame binario del servidor. */
  receiveBinary(data: ArrayBuffer) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Mensajes de texto enviados, parseados como JSON. */
  sentJson(): Record<string, unknown>[] {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}
