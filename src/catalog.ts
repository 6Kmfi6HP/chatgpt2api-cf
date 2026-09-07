import { Env } from './types';
import { UpstreamClient } from './client';

export const MODEL_CATALOG_KEY = 'chatgpt_model_catalog_v1';
export const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour
export const FALLBACK_CATALOG = ['auto'];

interface CachedCatalog {
  models: string[];
  fetchedAt: number; // ms epoch
}

let memCache: CachedCatalog | null = null;

export function clearCatalogCache(): void {
  memCache = null;
}

/**
 * Returns the anonymous upstream model catalog.
 * Priority: fresh upstream GET /backend-anon/models (KV + memory cached),
 * fallback: ["auto"] when upstream is unreachable.
 * No name mapping is performed; slugs are returned verbatim.
 */
export async function getModelCatalog(env: Env, client: UpstreamClient): Promise<string[]> {
  const now = Date.now();

  if (memCache && now - memCache.fetchedAt < DEFAULT_CATALOG_TTL_MS) {
    return [...memCache.models];
  }

  if (env.CHATGPT_KV) {
    try {
      const raw = await env.CHATGPT_KV.get(MODEL_CATALOG_KEY, 'json');
      if (
        raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as any).models) &&
        (raw as any).models.length > 0 &&
        now - ((raw as any).fetchedAt || 0) < DEFAULT_CATALOG_TTL_MS
      ) {
        memCache = raw as CachedCatalog;
        return [...memCache.models];
      }
    } catch {
      // KV read failure: continue to live fetch
    }
  }

  try {
    const slugs = await client.models(crypto.randomUUID());
    if (slugs.length > 0) {
      const catalog: CachedCatalog = { models: slugs, fetchedAt: now };
      memCache = catalog;
      if (env.CHATGPT_KV) {
        try {
          await env.CHATGPT_KV.put(MODEL_CATALOG_KEY, JSON.stringify(catalog));
        } catch {
          // KV write failure: catalog still served from memory
        }
      }
      return [...slugs];
    }
  } catch {
    // upstream unreachable: fall through to fallback
  }

  return [...FALLBACK_CATALOG];
}
