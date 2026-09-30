// Client for the dev server's graph file API (see server/graphFileApi.ts).

export async function fetchServerGraph(): Promise<{ file: string; text: string } | null> {
  try {
    const res = await fetch('/api/graph');
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function pushServerGraph(text: string): Promise<void> {
  const res = await fetch('/api/graph', { method: 'PUT', body: text, headers: { 'Content-Type': 'text/yaml' } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Save failed (${res.status})`);
  }
}

export function subscribeServerGraph(onText: (text: string) => void, onStatus: (online: boolean) => void): () => void {
  const es = new EventSource('/api/events');
  let dropped = false;
  es.addEventListener('graph', (e) => onText(JSON.parse((e as MessageEvent).data).text));
  es.onopen = async () => {
    onStatus(true);
    // Changes made while disconnected were never pushed to us; fetch the file once.
    if (dropped) {
      dropped = false;
      const current = await fetchServerGraph();
      if (current) onText(current.text);
    }
  };
  es.onerror = () => {
    dropped = true;
    onStatus(false);
  };
  return () => es.close();
}
