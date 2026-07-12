import React from 'react';

const STATUS_COLORS = {
  queued: 'var(--blue)',
  scheduled: 'var(--purple)',
  claimed: 'var(--yellow)',
  running: 'var(--yellow)',
  completed: 'var(--green)',
  dead: 'var(--red)',
  cancelled: 'var(--muted)',
  online: 'var(--green)',
  draining: 'var(--yellow)',
  offline: 'var(--red)',
  succeeded: 'var(--green)',
  failed: 'var(--red)',
  timed_out: 'var(--red)',
  lost: 'var(--muted)',
};

export function Badge({ status }) {
  return (
    <span className="badge" style={{ '--badge-color': STATUS_COLORS[status] || 'var(--muted)' }}>
      {status}
    </span>
  );
}

export function StatCard({ label, value, tone }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={tone ? { color: tone } : undefined}>
        {value ?? '—'}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function ErrorNote({ message }) {
  if (!message) return null;
  return <div className="error-note">{message}</div>;
}

export function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// Stacked bar chart (succeeded/failed per minute) as plain SVG - no chart
// library needed for one visualization.
export function ThroughputChart({ points }) {
  const width = 720;
  const height = 160;
  const pad = 24;
  if (!points || !points.length) {
    return <div className="chart-empty">No executions in the last hour yet.</div>;
  }
  const max = Math.max(...points.map((p) => p.succeeded + p.failed), 1);
  const barW = Math.min(18, (width - pad * 2) / points.length - 2);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart">
      {points.map((p, i) => {
        const total = p.succeeded + p.failed;
        const h = ((height - pad * 2) * total) / max;
        const hFail = total ? (h * p.failed) / total : 0;
        const x = pad + i * ((width - pad * 2) / points.length);
        const y = height - pad - h;
        return (
          <g key={p.minute}>
            <title>{`${new Date(p.minute).toLocaleTimeString()} — ok: ${p.succeeded}, failed: ${p.failed}`}</title>
            <rect x={x} y={y + hFail} width={barW} height={h - hFail} fill="var(--green)" rx="2" />
            {hFail > 0 && <rect x={x} y={y} width={barW} height={hFail} fill="var(--red)" rx="2" />}
          </g>
        );
      })}
      <text x={pad} y={height - 6} className="chart-label">
        last 60 minutes · green = succeeded · red = failed · peak {max}/min
      </text>
    </svg>
  );
}
