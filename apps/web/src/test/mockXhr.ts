/**
 * XMLHttpRequest falso para pruebas de subida: registra método, URL, cabeceras y
 * cuerpo, y permite simular progreso, respuesta, error de red y abort. Se instala
 * con vi.stubGlobal('XMLHttpRequest', MockXhr).
 */
type Handler = ((ev: ProgressEvent) => void) | null;

export class MockXhr {
  static instances: MockXhr[] = [];

  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = undefined;
  status = 0;
  aborted = false;
  withCredentials = false;
  readonly upload: { onprogress: Handler } = { onprogress: null };
  onload: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;

  constructor() {
    MockXhr.instances.push(this);
  }

  static last(): MockXhr {
    const xhr = MockXhr.instances[MockXhr.instances.length - 1];
    if (!xhr) throw new Error('no hay XHR');
    return xhr;
  }

  static reset() {
    MockXhr.instances = [];
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body?: unknown) {
    this.body = body;
  }

  abort() {
    this.aborted = true;
    this.onabort?.(new ProgressEvent('abort'));
  }

  /** Simula progreso de subida. */
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.(new ProgressEvent('progress', { loaded, total, lengthComputable }));
  }

  /** Simula la respuesta del servidor con el estado dado. */
  respond(status: number) {
    this.status = status;
    this.onload?.(new ProgressEvent('load'));
  }

  /** Simula un fallo de red (CORS, conexión cortada). */
  fail() {
    this.onerror?.(new ProgressEvent('error'));
  }
}
