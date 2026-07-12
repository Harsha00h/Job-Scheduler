import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api, getToken, clearSession, setSession } from './api';
import { ErrorNote } from './ui';
import Overview from './pages/Overview';
import Queues from './pages/Queues';
import QueueDetail from './pages/QueueDetail';
import JobDetail from './pages/JobDetail';
import Workers from './pages/Workers';
import Dlq from './pages/Dlq';

function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await api(path, { method: 'POST', body: form });
      setSession(res.token, res.user);
      navigate('/');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Job Scheduler</h1>
        {mode === 'register' && (
          <input
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        )}
        <input
          placeholder="Email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <input
          placeholder="Password"
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <ErrorNote message={error} />
        <button type="submit">{mode === 'login' ? 'Log in' : 'Create account'}</button>
        <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); }}>
          {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
        </a>
      </form>
    </div>
  );
}

function Layout({ children, project, projects, onProjectChange }) {
  const navigate = useNavigate();
  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">⚙ Scheduler</div>
        <NavLink to="/" end>Overview</NavLink>
        <NavLink to="/queues">Queues</NavLink>
        <NavLink to="/workers">Workers</NavLink>
        <NavLink to="/dlq">Dead Letter Queue</NavLink>
        <div className="spacer" />
        <a href="#" onClick={(e) => { e.preventDefault(); clearSession(); navigate('/login'); }}>
          Log out
        </a>
      </nav>
      <main className="main">
        <div className="topbar">
          <label>
            Project:{' '}
            <select value={project || ''} onChange={(e) => onProjectChange(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
        {project ? children : <p>No projects yet.</p>}
      </main>
    </div>
  );
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(localStorage.getItem('project') || null);
  const authed = !!getToken();

  useEffect(() => {
    if (!authed) return;
    api('/api/projects').then((res) => {
      setProjects(res.data);
      if (res.data.length && !res.data.some((p) => p.id === project)) {
        setProject(res.data[0].id);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  const changeProject = (id) => {
    setProject(id);
    localStorage.setItem('project', id);
  };

  if (!authed) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" />} />
      </Routes>
    );
  }

  return (
    <Layout project={project} projects={projects} onProjectChange={changeProject}>
      <Routes>
        <Route path="/" element={<Overview projectId={project} />} />
        <Route path="/queues" element={<Queues projectId={project} />} />
        <Route path="/queues/:id" element={<QueueDetail />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/dlq" element={<Dlq projectId={project} />} />
        <Route path="/login" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
}
