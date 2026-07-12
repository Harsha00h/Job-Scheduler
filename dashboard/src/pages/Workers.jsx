import React from 'react';
import { api } from '../api';
import { usePoll } from '../hooks';
import { Badge, ErrorNote, timeAgo } from '../ui';

export default function Workers() {
  const { data, error } = usePoll(() => api('/api/workers'), []);
  return (
    <div>
      <h1>Workers</h1>
      <ErrorNote message={error} />
      <table>
        <thead>
          <tr><th>Name</th><th>Status</th><th>Active jobs</th><th>Concurrency</th><th>Last heartbeat</th><th>Started</th></tr>
        </thead>
        <tbody>
          {(data?.data || []).map((w) => (
            <tr key={w.id}>
              <td className="mono">{w.name}</td>
              <td><Badge status={w.status} /></td>
              <td>{w.active_jobs}</td>
              <td>{w.max_concurrency}</td>
              <td>{timeAgo(w.last_heartbeat_at)}</td>
              <td>{timeAgo(w.started_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.data.length && <p>No workers have registered yet. Start one with <code>npm run worker</code>.</p>}
    </div>
  );
}
