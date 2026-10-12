import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { BackLink } from '../components/ui/BackLink';
import { Card, EmptyState, ErrorAlert, Skeleton } from '../components/ui/Primitives';
import { ReactionBars } from '../components/analytics/ReactionBars';
import { ReactionHeatmap } from '../components/analytics/ReactionHeatmap';
import { ViewersChart } from '../components/analytics/ViewersChart';
import { apiFetch, loginRedirectPath } from '../lib/api';
import {
  AnalyticsError,
  createAnalyticsClient,
  type ReactionHeatmap as Heatmap,
  type RoomKpis,
  type RoomTimeline,
} from '../lib/analytics';
import { formatNumber } from '../lib/chartScale';
import { errorStatus } from '../lib/errorStatus';

interface AnalyticsData {
  kpis: RoomKpis;
  heatmap: Heatmap;
  timeline: RoomTimeline;
}

const DEFAULT_TITLE = 'Análisis de la sala';

function errorMessage(err: unknown): string {
  const status = errorStatus(err);
  if (status === 403) return 'No tienes acceso a la analítica de esta sala.';
  if (status === 404 || status === 410) return 'La sala no existe.';
  if (err instanceof AnalyticsError) {
    if (status === 401) return 'Tu acceso a la analítica caducó o fue revocado. Vuelve a intentarlo.';
    return 'El servicio de analítica no está disponible en este momento.';
  }
  return err instanceof Error ? err.message : 'No se pudo cargar la analítica.';
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}

function hasActivity({ kpis, heatmap, timeline }: AnalyticsData): boolean {
  return (
    kpis.peak_users > 0 ||
    kpis.messages > 0 ||
    kpis.reactions > 0 ||
    kpis.playback_commands > 0 ||
    kpis.buffering_events > 0 ||
    heatmap.buckets.length > 0 ||
    timeline.points.length > 0
  );
}

function KpiTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <li>
      <Card className="flex h-full flex-col gap-1 p-4">
        <p className="text-[13px] text-tint-muted">{label}</p>
        <p className="text-2xl font-semibold tracking-tight text-white">{value}</p>
        {hint && <p className="text-[12px] text-tint-muted">{hint}</p>}
      </Card>
    </li>
  );
}

function StatusBadge({ kpis }: { kpis: RoomKpis }) {
  if (kpis.live && !kpis.closed_at) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-tint-success/30 bg-tint-success/10 px-3 py-1 text-[12px] font-medium text-white">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-tint-success motion-safe:animate-pulse" />
        En vivo
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[12px] font-medium text-white">
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-tint-muted" />
      Sesión cerrada
      {kpis.closed_at && <span className="font-normal text-tint-muted">· {formatDateTime(kpis.closed_at)}</span>}
    </span>
  );
}

/**
 * Analítica de una sala para su host (`/rooms/:id/analytics`): KPIs, espectadores en
 * el tiempo, reacciones por emoji y heatmap de reacciones por posición del vídeo.
 * Los datos vienen de la API de lectura de analytics con un analytics-ticket.
 */
export default function RoomAnalytics() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const client = useMemo(() => createAnalyticsClient(id), [id]);
  const [title, setTitle] = useState('');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  /** La sesión de host ya no sirve (como en Dashboard): se limpia y se vuelve al login. */
  const sessionExpired = useCallback(() => {
    localStorage.removeItem('tint_token');
    navigate(loginRedirectPath(`/rooms/${id}/analytics`));
  }, [id, navigate]);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/rooms/${encodeURIComponent(id)}`)
      .then((res: { room?: { title?: string } }) => {
        if (!cancelled) setTitle(res.room?.title ?? '');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Una sala ya cerrada puede no estar en identity-api: se usa un título genérico.
        if (errorStatus(err) === 401) sessionExpired();
      });

    return () => {
      cancelled = true;
    };
  }, [id, sessionExpired]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([client.kpis(), client.heatmap(), client.timeline()])
      .then(([kpis, heatmap, timeline]) => {
        if (cancelled) return;
        setData({ kpis, heatmap, timeline });
        setError('');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // El 401 del ticket viene de identity-api: la sesión de host ya no sirve.
        if (!(err instanceof AnalyticsError) && errorStatus(err) === 401) {
          sessionExpired();
          return;
        }
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, sessionExpired, reload]);

  const kpis = data?.kpis;

  return (
    <AppShell
      actions={
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          disabled={loading}
          className="rounded-full px-4 py-2.5 text-sm text-tint-muted transition hover:bg-white/5 hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tint-accent"
        >
          Actualizar
        </button>
      }
    >
      <div className="pt-8">
        <BackLink />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tighter text-white md:text-4xl">{title || DEFAULT_TITLE}</h1>
          {kpis && <StatusBadge kpis={kpis} />}
        </div>
        <p className="mt-2 max-w-[65ch] text-sm leading-relaxed">
          {loading && !data
            ? 'Cargando analítica…'
            : kpis
              ? `Datos actualizados el ${formatDateTime(kpis.computed_at)}.`
              : 'Analítica de la sesión.'}
        </p>

        {error && (
          <div className="mt-6 max-w-2xl">
            <ErrorAlert message={error} />
          </div>
        )}

        {loading && !data && (
          <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4" aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
            <Skeleton className="col-span-2 h-64 md:col-span-4" />
          </div>
        )}

        {data && !hasActivity(data) && (
          <div className="mt-8 max-w-2xl">
            <EmptyState
              title="Aún no hay actividad registrada"
              body="Cuando tus invitados se conecten, chateen o reaccionen, aquí verás cuántos estuvieron, cómo se sincronizó la reproducción y en qué momentos del vídeo reaccionaron."
            />
          </div>
        )}

        {data && kpis && hasActivity(data) && (
          <div className={`mt-8 flex flex-col gap-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
            <ul aria-label="Indicadores de la sesión" className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <KpiTile label="Pico de espectadores" value={formatNumber(kpis.peak_users, 0)} />
              <KpiTile label="Promedio de espectadores" value={formatNumber(kpis.avg_users)} />
              <KpiTile label="Drift promedio" value={`${formatNumber(kpis.avg_drift_ms, 0)} ms`} hint="Desfase medio corregido" />
              <KpiTile label="Mensajes" value={formatNumber(kpis.messages, 0)} />
              <KpiTile label="Reacciones" value={formatNumber(kpis.reactions, 0)} />
              <KpiTile label="Comandos de reproducción" value={formatNumber(kpis.playback_commands, 0)} />
              <KpiTile
                label="Buffering"
                value={`${formatNumber(kpis.buffering_events, 0)} ${kpis.buffering_events === 1 ? 'evento' : 'eventos'}`}
                hint={kpis.buffering_events > 0 ? `promedio ${formatNumber(kpis.avg_buffering_ms, 0)} ms` : undefined}
              />
              <KpiTile label="Aciertos de trivia" value={`${formatNumber(kpis.trivia_accuracy_pct)} %`} />
            </ul>
            <ViewersChart points={data.timeline.points} />
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <ReactionBars data={data.heatmap.by_emoji} />
              <ReactionHeatmap heatmap={data.heatmap} />
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
