import { useEffect, useState } from 'react';

import { api } from '@/lib/api';

// Session-wide cache so the same landmark photo is only looked up once.
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function lookup(key: string, query: string, width: number): Promise<string | null> {
  let p = inflight.get(key);
  if (!p) {
    p = api
      .placeImage(query, width)
      .then((img) => {
        cache.set(key, img?.url ?? null);
        return img?.url ?? null;
      })
      .catch(() => null)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Resolves a real photo (Google Places / Wikipedia via the backend) for a place name. */
export function usePlaceImage(query: string | null | undefined, width = 800) {
  const key = query ? `${query.toLowerCase()}|${width}` : null;
  const [resolved, setResolved] = useState<{ key: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!key || !query || cache.has(key)) return;
    let active = true;
    lookup(key, query, width).then((url) => {
      if (active) setResolved({ key, url });
    });
    return () => {
      active = false;
    };
  }, [key, query, width]);

  if (!key) return { url: null, loading: false };
  if (cache.has(key)) return { url: cache.get(key) ?? null, loading: false };
  if (resolved?.key === key) return { url: resolved.url, loading: false };
  return { url: null, loading: true };
}
