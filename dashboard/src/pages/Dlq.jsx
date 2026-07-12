import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePoll } from '../hooks';
import { ErrorNote, timeAgo } from '../ui';

export default function Dlq({ projectId }) {
  const { data, error, refresh } = usePoll(
    () => api(`/api/projects/${projectId}/dlq`),
    [projectId]
  );
  const [actionError, setActionError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summarizing, setSummarizing] = useState(false);

  const summarize = async () => {
    setSummarizing(true);
    try {
      setSummary(await api(`/api/projects/${projectId}/failure-summary`));
      setActionError(null);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setSummarizing(false);
    }
  };

  const replay = async (entryId) => {
    try {
      await api(`/api/dlq/${entryId}/replay`, { method: 'POST' });
      setActionError(null);
      refresh();
    } catch (err) {
      setActionError(err.message);
    }
  };

  return (
    <div>
      <h1>Dead Letter Queue</h1>
      <ErrorNote message={error || actionError} />
      <div className="form-row">
        <button className="secondary" onClick={summarize} disabled={summarizing}>
          {summarizing ? 'Summarizing…' : '✨ Summarize failures (24h)'}
        </button>
      </div>
      {summary && (
        <div className="panel">
          <strong>
            Failure summary · {summary.failure_count} failures ·{' '}
            {summary.source === 'heuristic'
              ? 'heuristic (no API key configured)'
              : `AI-generated (${summary.source})`}
          </strong>
          <pre style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{summary.summary}</pre>
        </div>
      )}
      <table>
        <thead>
          <tr><th>Job</th><th>Type</th><th>Queue</th><th>Reason</th><th>Attempts</th><th>Failed</th><th></th></tr>
        </thead>
        <tbody>
          {(data?.data || []).map((d) => (
            <tr key={d.id}>
              <td className="mono"><Link to={`/jobs/${d.job_id}`}>{d.job_id.slice(0, 8)}</Link></td>
              <td className="mono">{d.type}</td>
              <td>{d.queue_name}</td>
              <td style={{ color: 'var(--red)' }}>{d.reason}</td>
              <td>{d.attempts}</td>
              <td>{timeAgo(d.failed_at)}</td>
              <td><button onClick={() => replay(d.id)}>Replay</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.data.length && <p>Nothing here — no permanently failed jobs. 🎉</p>}
    </div>
  );
}
