import React from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';
import { StatCard, ThroughputChart, ErrorNote } from '../ui';

export default function Overview({ projectId }) {
  const { data, error } = usePoll(() => api(`/api/projects/${projectId}/metrics`), [projectId]);
  const s = data?.by_status || {};
  const hour = data?.last_hour || {};
  const failRate =
    hour.total > 0 ? `${Math.round((hour.failed / hour.total) * 100)}%` : '0%';

  return (
    <div>
      <h1>Overview</h1>
      <ErrorNote message={error} />
      <div className="stat-grid">
        <StatCard label="Queued" value={(s.queued || 0) + (s.scheduled || 0)} tone="var(--blue)" />
        <StatCard label="Running" value={(s.running || 0) + (s.claimed || 0)} tone="var(--yellow)" />
        <StatCard label="Completed" value={s.completed || 0} tone="var(--green)" />
        <StatCard label="Dead (DLQ)" value={s.dead || 0} tone="var(--red)" />
        <StatCard label="Workers online" value={data?.workers?.online} tone="var(--green)" />
        <StatCard label="Failure rate (1h)" value={failRate} />
        <StatCard label="Avg duration (1h)" value={hour.avg_duration_ms ? `${hour.avg_duration_ms}ms` : '—'} />
        <StatCard label="p95 duration (1h)" value={hour.p95_duration_ms ? `${hour.p95_duration_ms}ms` : '—'} />
      </div>
      <h2>Throughput</h2>
      <div className="panel">
        <ThroughputChart points={data?.throughput_per_minute} />
      </div>
    </div>
  );
}
