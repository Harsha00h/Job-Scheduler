import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePoll } from '../hooks';
import { Badge, ErrorNote } from '../ui';

export default function Queues({ projectId }) {
  const { data, error, refresh } = usePoll(
    () => api(`/api/projects/${projectId}/queues`),
    [projectId]
  );
  const [form, setForm] = useState({ name: '', priority: 0, max_concurrency: 5, rate_limit: '' });
  const [formError, setFormError] = useState(null);

  const create = async (e) => {
    e.preventDefault();
    try {
      const body = {
        name: form.name,
        priority: Number(form.priority),
        max_concurrency: Number(form.max_concurrency),
      };
      if (form.rate_limit) body.rate_limit_per_minute = Number(form.rate_limit);
      await api(`/api/projects/${projectId}/queues`, { method: 'POST', body });
      setForm({ name: '', priority: 0, max_concurrency: 5, rate_limit: '' });
      setFormError(null);
      refresh();
    } catch (err) {
      setFormError(err.message);
    }
  };

  const togglePause = async (queue) => {
    await api(`/api/queues/${queue.id}/${queue.is_paused ? 'resume' : 'pause'}`, { method: 'POST' });
    refresh();
  };

  return (
    <div>
      <h1>Queues</h1>
      <ErrorNote message={error} />
      <form className="form-row panel" onSubmit={create}>
        <label>
          Name
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          Priority
          <input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
        </label>
        <label>
          Max concurrency
          <input type="number" min="1" value={form.max_concurrency} onChange={(e) => setForm({ ...form, max_concurrency: e.target.value })} />
        </label>
        <label>
          Rate limit /min (optional)
          <input type="number" min="1" value={form.rate_limit} onChange={(e) => setForm({ ...form, rate_limit: e.target.value })} />
        </label>
        <button type="submit">Create queue</button>
        <ErrorNote message={formError} />
      </form>
      <table>
        <thead>
          <tr>
            <th>Name</th><th>Priority</th><th>Concurrency</th><th>Rate limit</th><th>Pending</th><th>Active</th><th>State</th><th></th>
          </tr>
        </thead>
        <tbody>
          {(data?.data || []).map((q) => (
            <tr key={q.id}>
              <td><Link to={`/queues/${q.id}`}>{q.name}</Link></td>
              <td>{q.priority}</td>
              <td>{q.max_concurrency}</td>
              <td>{q.rate_limit_per_minute ? `${q.rate_limit_per_minute}/min` : '—'}</td>
              <td>{q.pending_jobs}</td>
              <td>{q.active_jobs}</td>
              <td><Badge status={q.is_paused ? 'offline' : 'online'} />{q.is_paused ? ' paused' : ' active'}</td>
              <td>
                <button className="secondary" onClick={() => togglePause(q)}>
                  {q.is_paused ? 'Resume' : 'Pause'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
