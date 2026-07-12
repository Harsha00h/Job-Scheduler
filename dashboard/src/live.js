// Singleton WebSocket connection for live updates. Job events pushed by the
// server trigger subscribers (usePoll refreshes); polling remains the
// fallback if the socket is unavailable.
import { getToken } from './api';

const subscribers = new Set();
let socket = null;
let retryMs = 1000;

function connect() {
  const token = getToken();
  if (!token || (socket && socket.readyState <= 1)) return;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${window.location.host}/ws?token=${token}`);
  socket.onopen = () => {
    retryMs = 1000;
  };
  socket.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    for (const cb of subscribers) cb(event);
  };
  socket.onclose = () => {
    socket = null;
    setTimeout(connect, Math.min((retryMs *= 2), 15000));
  };
}

export function subscribe(cb) {
  subscribers.add(cb);
  connect();
  return () => subscribers.delete(cb);
}
