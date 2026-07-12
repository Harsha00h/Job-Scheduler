import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { usePoll } from '../hooks';
import { Badge, ErrorNote, timeAgo } from '../ui';

export default function JobDetail() {
  const { id } = useParams();
  const { data: job, error, refresh } = usePoll(() => api(`/api/jobs/${id}`), [id], 3000);
  const [actionError, setActionError] = useState(null);

  const act = async (action) => {
    try {
      await api(`/api/jobs/${id}/${action}`, { method: 'POST' });
      setActionError(null);
      refresh();
    } catch (err) {
      setActionError(err.message);
    }
  };

  if (!job) return <p>Loading…</p>;

  return (
    <div>
      <h1>
        Job <span className="mono">{job.id?.slice(0, 8)}</span> <Badge status={job.status} />
      </h1>
      <ErrorNote message={error || actionError} />
      <div className="panel">
        <table>
          <tbody>
            <tr><th>Type</th><td className="mono">{job.type}</td></tr>
            <tr><th>Queue</th><td className="mono"><Link to={`/queues/${job.queue_id}`}>{job.queue_id?.slice(0, 8)}</Link></td></tr>
            <tr><th>Payload</th><td className="mono">{JSON.stringify(job.payload)}</td></tr>
            <tr><th>Priority</th><td>{job.priority}</td></tr>
            <tr><th>Attempts</th><td>{job.attempts} / {job.max_attempts}</td></tr>
            <tr><th>Run at</th><td>{new Date(job.run_at).toLocaleString()}</td></tr>
            <tr><th>Created</th><td>{new Date(job.created_at).toLocaleString()}</td></tr>
            {job.completed_at && <tr><th>Completed</th><td>{new Date(job.completed_at).toLocaleString()}</td></tr>}
            {job.last_error && <tr><th>Last error</th><td style={{ color: 'var(--red)' }}>{job.last_error}</td></tr>}
            {job.batch_id && <tr><th>Batch</th><td className="mono">{job.batch_id}</td></tr>}
          </tbody>
        </table>
        <div className="form-row">
          {['queued', 'scheduled'].includes(job.status) && (
            <button className="danger" onClick={() => act('cancel')}>Cancel</button>
          )}
          {['dead', 'cancelled'].includes(job.status) && (
            <button onClick={() => act('retry')}>Retry now</button>
          )}
        </div>
      </div>

      <h2>Executions (retry history)</h2>
      <table>
        <thead><tr><th>Attempt</th><th>Status</th><th>Worker</th><th>Started</th><th>Duration</th><th>Error / result</th></tr></thead>
        <tbody>
          {(job.executions || []).map((e) => (
            <tr key={e.id}>
              <td>{e.attempt}</td>
              <td><Badge status={e.status} /></td>
              <td className="mono">{e.worker_name || '—'}</td>
              <td>{timeAgo(e.started_at)}</td>
              <td>{e.duration_ms != null ? `${e.duration_ms}ms` : '—'}</td>
              <td className="mono">{e.error || (e.result ? JSON.stringify(e.result) : '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Logs</h2>
      <div className="panel">
        {(job.logs || []).length === 0 && <span className="chart-empty">No log lines.</span>}
        {(job.logs || []).map((l) => (
          <div key={l.id} className={`log-line mono ${l.level}`}>
            <span className="lvl">{l.level}</span>
            <span>{new Date(l.created_at).toLocaleTimeString()} — {l.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
