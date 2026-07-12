// Thin fetch wrapper: attaches the JWT, parses errors into a single shape,
// and bounces to /login when the session expires.
export function getToken() {
  return localStorage.getItem('token');
}

export function setSession(token, user) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    clearSession();
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    const detail = data.error?.details?.length ? ` (${data.error.details.join('; ')})` : '';
    throw new Error((data.error?.message || 'Request failed') + detail);
  }
  return data;
}
