import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { usePoll } from '../hooks';
import { Badge, ErrorNote, timeAgo } from '../ui';

const STATUSES = ['', 'queued', 'scheduled', 'claimed', 'running', 'completed', 'dead', 'cancelled'];

export default function QueueDetail() {
  const { id } = useParams();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const { data: queue } = usePoll(() => api(`/api/queues/${id}`), [id], 10000);
  const { data: stats } = usePoll(() => api(`/api/queues/${id}/stats`), [id]);
  const { data: schedules, refresh: refreshSchedules } = usePoll(
    () => api(`/api/queues/${id}/schedules`),
    [id],
    10000
  );
  const { data: jobs, error, refresh } = usePoll(
    () => api(`/api/queues/${id}/jobs?page=${page}&limit=15${status ? `&status=${status}` : ''}`),
    [id, status, page]
  );

  const [jobForm, setJobForm] = useState({ type: 'demo.sleep', payload: '{"duration_ms": 800}', delay_ms: '' });
  const [schedForm, setSchedForm] = useState({ name: '', cron_expression: '* * * * *', job_type: 'report.generate' });
  const [formError, setFormError] = useState(null);

  const createJob = async (e) => {
    e.preventDefault();
    try {
      const body = { type: jobForm.type, payload: JSON.parse(jobForm.payload || '{}') };
      if (jobForm.delay_ms) body.delay_ms = Number(jobForm.delay_ms);
      await api(`/api/queues/${id}/jobs`, { method: 'POST', body });
      setFormError(null);
      refresh();
    } catch (err) {
      setFormError(err.message);
    }
  };

  const createSchedule = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/queues/${id}/schedules`, { method: 'POST', body: { ...schedForm, payload: {} } });
      setFormError(null);
      refreshSchedules();
    } catch (err) {
      setFormError(err.message);
    }
  };

  const totalPages = jobs ? Math.max(1, Math.ceil(jobs.total / jobs.limit)) : 1;

  return (
    <div>
      <h1>
        Queue: {queue?.name || '…'} {queue?.is_paused && <Badge status="offline" />}
      </h1>
      <div className="stat-grid">
        {Object.entries(stats?.by_status || {}).map(([k, v]) => (
          <div className="stat-card" key={k}>
            <div className="stat-value">{v}</div>
            <div className="stat-label"><Badge status={k} /></div>
          </div>
        ))}
      </div>

      <h2>Submit a job</h2>
      <form className="form-row panel" onSubmit={createJob}>
        <label>
          Type
          <select value={jobForm.type} onChange={(e) => setJobForm({ ...jobForm, type: e.target.value })}>
            {['demo.sleep', 'email.send', 'report.generate', 'math.sum', 'always.fail'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Payload (JSON)
          <textarea rows="2" cols="40" value={jobForm.payload} onChange={(e) => setJobForm({ ...jobForm, payload: e.target.value })} />
        </label>
        <label>
          Delay (ms, optional)
          <input type="number" value={jobForm.delay_ms} onChange={(e) => setJobForm({ ...jobForm, delay_ms: e.target.value })} />
        </label>
        <button type="submit">Enqueue</button>
      </form>

      <h2>Recurring schedules (cron)</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Name</th><th>Cron</th><th>Type</th><th>Next run</th><th>Active</th></tr></thead>
          <tbody>
            {(schedules?.data || []).map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="mono">{s.cron_expression}</td>
                <td className="mono">{s.job_type}</td>
                <td>{new Date(s.next_run_at).toLocaleTimeString()}</td>
                <td>{s.is_active ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="form-row" onSubmit={createSchedule}>
          <label>
            Name
            <input required value={schedForm.name} onChange={(e) => setSchedForm({ ...schedForm, name: e.target.value })} />
          </label>
          <label>
            Cron expression
            <input required value={schedForm.cron_expression} onChange={(e) => setSchedForm({ ...schedForm, cron_expression: e.target.value })} />
          </label>
          <label>
            Job type
            <input required value={schedForm.job_type} onChange={(e) => setSchedForm({ ...schedForm, job_type: e.target.value })} />
          </label>
          <button type="submit">Add schedule</button>
        </form>
      </div>
      <ErrorNote message={formError} />

      <h2>Jobs</h2>
      <div className="form-row">
        <label>
          Status filter
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            {STATUSES.map((s) => <option key={s} value={s}>{s || 'all'}</option>)}
          </select>
        </label>
      </div>
      <ErrorNote message={error} />
      <table>
        <thead><tr><th>ID</th><th>Type</th><th>Status</th><th>Attempts</th><th>Run at</th><th>Created</th></tr></thead>
        <tbody>
          {(jobs?.data || []).map((j) => (
            <tr key={j.id}>
              <td className="mono"><Link to={`/jobs/${j.id}`}>{j.id.slice(0, 8)}</Link></td>
              <td className="mono">{j.type}</td>
              <td><Badge status={j.status} /></td>
              <td>{j.attempts}/{j.max_attempts}</td>
              <td>{timeAgo(j.run_at)}</td>
              <td>{timeAgo(j.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pager">
        <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
        <span>page {page} of {totalPages} · {jobs?.total ?? 0} jobs</span>
        <button className="secondary" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
