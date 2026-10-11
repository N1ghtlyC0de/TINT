import { useParams, Link } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactionBar } from '../components/ReactionBar';
import { CopyButton } from '../components/CopyButton';
import { SyncedPlayer } from '../components/SyncedPlayer';
import { ChangeVideoPanel } from '../components/host/ChangeVideoPanel';
import { ParticipantsPanel } from '../components/host/ParticipantsPanel';
import { ReconnectStatus, SyncQualityIndicator } from '../components/sync/SyncStatus';
import { ToastStack } from '../components/sync/SyncToasts';
import { BackLink } from '../components/ui/BackLink';
import { Card } from '../components/ui/Primitives';
import { apiFetch } from '../lib/api';
import { toAbsoluteInviteLink, pickLatestActiveInvitation } from '../lib/invite';
import { formatChatTime, noticeText } from '../lib/socialSocket';
import { useRoomPlayback, type MediaStatus } from '../hooks/useRoomPlayback';
import { useSocialSocket } from '../hooks/useSocialSocket';
import { useSyncSocket } from '../hooks/useSyncSocket';
import { useSyncToasts } from '../hooks/useSyncToasts';

/** Texto y color del indicador de procesamiento (media-worker) por estado del vídeo. */
const MEDIA_STATUS_UI: Record<MediaStatus, { text: string; tone: string; dot: string }> = {
  pending: { text: 'Procesando vídeo (Ambilight)…', tone: 'text-amber-200', dot: 'bg-amber-300 animate-pulse motion-reduce:animate-none' },
  processing: { text: 'Procesando vídeo (Ambilight)…', tone: 'text-amber-200', dot: 'bg-amber-300 animate-pulse motion-reduce:animate-none' },
  ready: { text: 'Ambilight listo', tone: 'text-emerald-300', dot: 'bg-emerald-400' },
  failed: {
    text: 'No se pudo procesar el vídeo; la reproducción sigue disponible',
    tone: 'text-red-300',
    dot: 'bg-red-400',
  },
};

export default function WatchRoom() {
  const { roomId } = useParams();
  // Canal Social (/ws/social): el estado maestro del chat vive en social-core.
  const { messages, send, status } = useSocialSocket(roomId);
  const guestToken = localStorage.getItem('tint_guest_token');
  // Si hay sesión de host, manda el host aunque queden restos de invitado
  // (p. ej. guest token de una visita anterior al login). Coherente con
  // apiFetch, que prefiere el header de host.
  const isGuest = !localStorage.getItem('tint_token') && !!guestToken;
  const role = isGuest ? 'guest' : 'host';
  // Respaldo solo si la sala no tiene vídeo asignado en identity-api.
  const demoVideoUrl = import.meta.env.VITE_DEMO_VIDEO_URL || undefined;

  // Canal Sync (/ws/sync): el Reloj Maestro vive en sync-core.
  const videoRef = useRef<HTMLVideoElement>(null);
  const getPositionMs = useCallback(
    () => (videoRef.current ? videoRef.current.currentTime * 1000 : null),
    [],
  );
  const sync = useSyncSocket({ roomId: roomId ?? '', role, getPositionMs });
  const playback = useRoomPlayback(roomId ?? '', sync.state ? sync.state.media_id : undefined, {
    role,
    enabled: !sync.revoked,
  });
  const toasts = useSyncToasts(sync.lastBroadcast);
  // Los controles los habilita el servidor (STATE.can_control / CONTROL), no el rol local.
  const canControl = sync.canControl;
  const delegated = isGuest && canControl;
  const videoSrc = playback.url ?? (!playback.loading && !playback.error && !playback.mediaId ? demoVideoUrl : undefined);
  const emptyMessage = playback.url
    ? undefined
    : playback.loading
      ? 'Cargando vídeo…'
      : (playback.error ?? 'Sin video configurado');
  const mediaStatusUi = playback.status ? MEDIA_STATUS_UI[playback.status] : null;
  const { sendCommand } = sync;
  const loadMedia = useCallback(
    (mediaId: string) => sendCommand('LOAD', 0, { media_id: mediaId }) !== null,
    [sendCommand],
  );
  const [chat, setChat] = useState('');
  const [roomTitle, setRoomTitle] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const text = chat.trim();
    if (!text) return;
    if (send(text)) setChat('');
  };

  // Título y link de invitación: el host los pide al backend; el invitado
  // usa los guardados al canjear (su token no tiene auth de host).
  useEffect(() => {
    if (!roomId) return;
    if (isGuest) {
      setRoomTitle(localStorage.getItem('tint_room_title'));
      setInviteLink(localStorage.getItem('tint_invite_link'));
      return;
    }
    let cancelled = false;
    Promise.all([apiFetch(`/rooms/${roomId}`), apiFetch(`/rooms/${roomId}/invitations`)])
      .then(([roomRes, invRes]) => {
        if (cancelled) return;
        setRoomTitle(roomRes.room?.title ?? null);
        const list = (invRes.invitations ?? []) as { code: string; link?: string; expiresAt: string; createdAt?: string; revoked?: boolean }[];
        const latest = pickLatestActiveInvitation(
          list.filter((inv) => inv.link).map((inv) => ({ code: inv.code, link: inv.link as string, expiresAt: inv.expiresAt, createdAt: inv.createdAt, revoked: inv.revoked })),
        );
        setInviteLink(latest?.link ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setRoomTitle(null);
          setInviteLink(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, isGuest]);

  const heading = roomTitle?.trim() ? roomTitle : `Sala ${roomId}`;

  const chatStatus =
    status === 'open' ? 'Chat conectado' : status === 'closed' ? 'Chat desconectado' : 'Chat reconectando…';

  // Auto-scroll inteligente: baja al fondo solo si el usuario ya estaba abajo,
  // para no robar la lectura de mensajes antiguos cuando llegan nuevos.
  const listRef = useRef<HTMLUListElement | null>(null);
  const stickRef = useRef(true);

  const onListScroll = (e: React.UIEvent<HTMLUListElement>) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (sync.revoked) {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-tint-bg px-4 text-tint-muted">
        <Card className="max-w-md p-8 text-center">
          <p role="alert" className="text-lg font-semibold tracking-tight text-white">
            Fuiste retirado de la sala por el host
          </p>
          <p className="mt-2 text-sm leading-relaxed">
            Tu invitación ya no es válida. Si crees que es un error, pide al host un nuevo enlace.
          </p>
          <Link
            to="/"
            className="mt-6 inline-flex rounded-full bg-tint-accent px-5 py-2.5 text-sm font-semibold text-tint-bg transition hover:bg-tint-accentHover"
          >
            Volver al inicio
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-tint-bg text-tint-muted">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-tint-bg/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <BackLink />
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-white" title={heading}>
              {heading}
            </h1>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[12px] text-tint-muted">
              Rol: {isGuest ? 'participante (invitado)' : 'host (registrado)'}
            </span>
            {inviteLink && (
              <span className="hidden min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pl-3 pr-1 text-[12px] sm:inline-flex">
                <span className="max-w-[180px] truncate text-tint-muted" title={toAbsoluteInviteLink(inviteLink)}>
                  {toAbsoluteInviteLink(inviteLink)}
                </span>
                <CopyButton link={inviteLink} />
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {sync.connected && <SyncQualityIndicator rttMs={sync.rttMs} driftMs={sync.driftMs} />}
            <div role="status" aria-label="Estado de sincronía" aria-live="polite">
              <ReconnectStatus connected={sync.connected} reconnect={sync.reconnect} />
            </div>
            <p className="text-[12px]" role="status" aria-live="polite">
              {chatStatus}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1400px] gap-4 px-4 py-6 lg:grid-cols-[2fr_360px]">
        <section aria-label="Reproductor">
          <Card className="overflow-hidden">
            <SyncedPlayer
              src={videoSrc}
              canControl={canControl}
              delegated={delegated}
              sync={sync}
              videoRef={videoRef}
              emptyMessage={emptyMessage}
            />
            <div aria-hidden="true" className="h-1.5 bg-gradient-to-r from-tint-accentDark via-tint-accent to-tint-accentDark opacity-70 blur-[6px]" />
            <div className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <p className="text-sm font-medium text-white">Reproducción sincronizada</p>
                <p className="mt-0.5 text-[13px]">
                  {canControl ? 'Controlas la reproducción de la sala' : 'El host controla la reproducción'}
                </p>
              </div>
              <ReactionBar onReact={() => {}} />
            </div>
          </Card>

          {!isGuest && (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Card className="p-5">
                <h2 className="text-[15px] font-semibold text-white">Vídeo de la sala</h2>
                <p className="mb-4 mt-1 text-[13px] leading-relaxed">
                  Sube un vídeo desde tu equipo; todos lo cargarán en pausa al inicio.
                </p>
                <ChangeVideoPanel roomId={roomId ?? ''} onMediaAssigned={loadMedia} />
              </Card>
              <Card className="p-5">
                <ParticipantsPanel roomId={roomId ?? ''} />
              </Card>
            </div>
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card className="p-5">
              <h2 className="text-[15px] font-semibold text-white">Trivia</h2>
              <p className="mt-1 text-[13px] leading-relaxed">
                Las preguntas de social-core aparecerán aquí durante la reproducción.
              </p>
            </Card>
            <Card className="p-5">
              <h2 className="text-[15px] font-semibold text-white">Ambilight</h2>
              <p className="mt-1 text-[13px] leading-relaxed">
                Visualización lista para ambilight.json de media-worker.
              </p>
              <p
                role="status"
                aria-live="polite"
                aria-label="Estado del vídeo"
                className={`mt-2 flex items-center gap-2 text-[13px] ${mediaStatusUi?.tone ?? ''}`}
              >
                {mediaStatusUi && (
                  <>
                    <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${mediaStatusUi.dot}`} />
                    {mediaStatusUi.text}
                  </>
                )}
              </p>
              <div aria-hidden="true" className="mt-3 flex gap-1.5">
                {['#FF6B1A', '#C4520A', '#313338', '#B5BAC1', '#1E1F22'].map((c) => (
                  <span key={c} style={{ background: c }} className="h-6 flex-1 rounded-md border border-white/10" />
                ))}
              </div>
            </Card>
          </div>

        </section>

        <aside aria-label="Social" className="flex min-h-0 flex-col gap-4">
          <Card className="flex h-[560px] min-h-0 flex-col p-5 lg:h-[calc(100dvh-7rem)]">
            <h2 className="text-[15px] font-semibold text-white">Chat en vivo</h2>
            {messages.length === 0 ? (
              <p className="mt-3 flex-1 rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-4 text-[13px] leading-relaxed">
                Sin mensajes aún. Saluda y prueba la sincronía con tu grupo.
              </p>
            ) : (
              <ul
                ref={listRef}
                onScroll={onListScroll}
                className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto"
                aria-live="polite"
              >
                {messages.map((m) =>
                  m.type === 'notice' ? (
                    <li
                      key={m.event_id}
                      className="px-3 py-1 text-center text-[12px] italic text-tint-muted/80"
                    >
                      {noticeText(m)}
                    </li>
                  ) : (
                    <li key={m.event_id} className="rounded-xl bg-white/5 px-3 py-2 text-[13px]">
                      <span className="font-semibold text-white">{m.nick}: </span>
                      <span>{m.text}</span>{' '}
                      {formatChatTime(m.occurred_at) && (
                        <time dateTime={m.occurred_at} className="text-[11px] text-tint-muted/70">
                          {formatChatTime(m.occurred_at)}
                        </time>
                      )}
                    </li>
                  ),
                )}
              </ul>
            )}
            <form onSubmit={sendChat} className="mt-4 flex gap-2">
              <label htmlFor="chat-input" className="sr-only">
                Escribe un mensaje
              </label>
              <input
                id="chat-input"
                value={chat}
                onChange={(e) => setChat(e.target.value)}
                placeholder="Escribe un mensaje"
                maxLength={280}
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-tint-bg px-3 py-2 text-sm text-white placeholder:text-tint-muted/50 focus:border-tint-accent focus:outline-none"
              />
              <button
                type="submit"
                className="shrink-0 rounded-full bg-tint-accent px-4 py-2 text-sm font-semibold text-tint-bg transition hover:bg-tint-accentHover active:scale-[0.98]"
              >
                Enviar
              </button>
            </form>
          </Card>
        </aside>
      </main>

      <ToastStack toasts={toasts} className="fixed right-4 top-20 z-40" />
    </div>
  );
}
