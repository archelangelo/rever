import { useEffect, useState } from 'react';

interface Health {
  status: string;
  pid: number;
  reviews: number;
  uptime: number;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main style={{ font: '16px/1.5 system-ui, sans-serif', maxWidth: '40rem', margin: '4rem auto', padding: '0 1rem' }}>
      <h1>Rever</h1>
      <p>Local, PR-style code review that closes the loop with Claude Code.</p>
      {error && <p style={{ color: 'crimson' }}>Daemon unreachable: {error}</p>}
      {health && (
        <p>
          Daemon <strong>{health.status}</strong> · pid {health.pid} · {health.reviews} review(s) ·
          up {Math.round(health.uptime)}s
        </p>
      )}
    </main>
  );
}
