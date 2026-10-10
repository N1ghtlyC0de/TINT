/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IDENTITY_API_URL?: string;
  /** WebSocket del Canal Sync de sync-core (p. ej. ws://localhost:8082/ws/sync). */
  readonly VITE_SYNC_WS_URL?: string;
  /** URL del vídeo de demostración para la sala. */
  readonly VITE_DEMO_VIDEO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
