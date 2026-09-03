import { DeviceIdentity, DevicePoolState, Env } from './types';
import { UpstreamClient, StatusError } from './client';

export const DEVICE_POOL_KEY = 'chatgpt_device_pool';
export const DEFAULT_POOL_SIZE = 3;
export const DEFAULT_L1_TTL_MS = 20_000; // 20 seconds

/**
 * Helper to select an eviction candidate when the pool is at capacity.
 * Ported from Go pickEvictionCandidate in auto_provision.go:
 * 1. If preferId is specified and found, evict it.
 * 2. Else pick candidate with longest cooldownUntil in the future.
 * 3. Fallback: candidate with oldest lastUsedAt.
 */
export function pickEvictionIndex(devices: DeviceIdentity[], preferId?: string): number {
  if (preferId) {
    const idx = devices.findIndex((d) => d.id === preferId);
    if (idx !== -1) return idx;
  }

  const now = Date.now();
  let maxCooldownIdx = -1;
  let maxCooldown = -1;
  for (let i = 0; i < devices.length; i++) {
    const cd = devices[i].cooldownUntil || 0;
    if (cd > now && cd > maxCooldown) {
      maxCooldown = cd;
      maxCooldownIdx = i;
    }
  }
  if (maxCooldownIdx !== -1) {
    return maxCooldownIdx;
  }

  let oldestIdx = 0;
  let oldestTime = Infinity;
  for (let i = 0; i < devices.length; i++) {
    const t = devices[i].lastUsedAt || 0;
    if (t < oldestTime) {
      oldestTime = t;
      oldestIdx = i;
    }
  }
  return oldestIdx;
}

export class DeviceManager {
  private cachedPool: DevicePoolState | null = null;
  private cacheExpiresAt: number = 0;
  private readonly l1TtlMs: number;
  private mutex: Promise<void> = Promise.resolve();

  constructor(l1TtlMs: number = DEFAULT_L1_TTL_MS) {
    this.l1TtlMs = l1TtlMs;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentLock = this.mutex;
    this.mutex = nextLock;

    try {
      await currentLock;
      return await fn();
    } finally {
      release!();
    }
  }

  clearCache(): void {
    this.cachedPool = null;
    this.cacheExpiresAt = 0;
  }

  async getPool(env: Env): Promise<DevicePoolState> {
    const now = Date.now();
    if (this.cachedPool && now < this.cacheExpiresAt) {
      return JSON.parse(JSON.stringify(this.cachedPool));
    }

    if (env.CHATGPT_KV) {
      const raw = await env.CHATGPT_KV.get(DEVICE_POOL_KEY, 'json');
      if (raw && typeof raw === 'object' && Array.isArray((raw as any).devices)) {
        const state = raw as DevicePoolState;
        this.cachedPool = state;
        this.cacheExpiresAt = now + this.l1TtlMs;
        return JSON.parse(JSON.stringify(state));
      }
    }

    const emptyState: DevicePoolState = {
      devices: [],
      lastUpdated: now,
    };
    this.cachedPool = emptyState;
    this.cacheExpiresAt = now + this.l1TtlMs;
    return JSON.parse(JSON.stringify(emptyState));
  }

  async savePool(env: Env, state: DevicePoolState): Promise<void> {
    state.lastUpdated = Date.now();
    const copy = JSON.parse(JSON.stringify(state));
    if (env.CHATGPT_KV) {
      await env.CHATGPT_KV.put(DEVICE_POOL_KEY, JSON.stringify(copy));
    }
    this.cachedPool = copy;
    this.cacheExpiresAt = Date.now() + this.l1TtlMs;
  }

  /**
   * Reconciles the device pool to match the configured DEVICE_POOL_SIZE:
   * - Top up with fresh UUIDs if below poolSize.
   * - Prune surplus devices if above poolSize (pruning cooled/stale candidates first).
   */
  reconcilePoolSize(state: DevicePoolState, poolSize: number): boolean {
    let modified = false;

    // Prune surplus if over capacity
    while (state.devices.length > poolSize) {
      const victimIdx = pickEvictionIndex(state.devices);
      state.devices.splice(victimIdx, 1);
      modified = true;
    }

    // Top up if under capacity
    while (state.devices.length < poolSize) {
      state.devices.push({
        id: crypto.randomUUID(),
      });
      modified = true;
    }

    return modified;
  }

  /**
   * Selects a healthy uncooled device identity using Round-Robin (LRU).
   * Automatically refreshes sentinel token if missing or expiring within 60s.
   * If all devices are cooled down, provisions a fresh identity to recover immediately.
   */
  async getHealthyDevice(env: Env, client: UpstreamClient): Promise<DeviceIdentity> {
    return await this.withLock(async () => {
      const state = await this.getPool(env);
      const configuredSize = env.DEVICE_POOL_SIZE ? parseInt(env.DEVICE_POOL_SIZE, 10) : DEFAULT_POOL_SIZE;
      const poolSize = isNaN(configuredSize) || configuredSize < 1 ? DEFAULT_POOL_SIZE : configuredSize;

      let modified = this.reconcilePoolSize(state, poolSize);

      const now = Date.now();
      const nowSec = Math.floor(now / 1000);

      // Finds uncooled devices (cooldownUntil <= Date.now() or not set)
      const uncooled = state.devices.filter((d) => !d.cooldownUntil || d.cooldownUntil <= now);

      let device: DeviceIdentity;

      if (uncooled.length === 0) {
        // All devices are cooled down: evict worst candidate and provision replacement
        device = {
          id: crypto.randomUUID(),
        };
        const victimIdx = pickEvictionIndex(state.devices);
        state.devices.splice(victimIdx, 1);
        state.devices.push(device);
        modified = true;
      } else {
        // Round-Robin / LRU rotation among healthy devices:
        // Sort by lastUsedAt ascending so traffic is evenly distributed across KV devices
        uncooled.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
        device = uncooled[0];
      }

      // Checks sentinel token: if missing or expiring within 60 seconds (expiry <= now + 60)
      const needsSentinel =
        !device.sentinelToken ||
        device.sentinelExpiry === undefined ||
        device.sentinelExpiry <= nowSec + 60;

      if (needsSentinel) {
        const { token, expiry } = await client.sentinel(device.id);
        device.sentinelToken = token;
        device.sentinelExpiry = expiry;
        modified = true;
      }

      device.lastUsedAt = now;
      modified = true;

      if (modified) {
        await this.savePool(env, state);
      }

      return { ...device };
    });
  }

  /**
   * Reports an upstream 429 or 403 error.
   * Matches Go auto_provision.go behavior:
   * 1. Evicts the rate-limited candidate when pool is at capacity (keeping pool bounded to poolSize).
   * 2. Provisions a fresh replacement device so pool has active capacity.
   * 3. Saves updated pool to KV and updates memory cache.
   */
  async reportCooldown(env: Env, deviceId: string, error: StatusError): Promise<void> {
    return await this.withLock(async () => {
      const state = await this.getPool(env);
      const configuredSize = env.DEVICE_POOL_SIZE ? parseInt(env.DEVICE_POOL_SIZE, 10) : DEFAULT_POOL_SIZE;
      const poolSize = isNaN(configuredSize) || configuredSize < 1 ? DEFAULT_POOL_SIZE : configuredSize;

      // When pool is full, evict the rate-limited candidate (just like Go auto_provision)
      if (state.devices.length >= poolSize) {
        const victimIdx = pickEvictionIndex(state.devices, deviceId);
        if (victimIdx !== -1) {
          state.devices.splice(victimIdx, 1);
        }
      }

      // Provision fresh replacement device
      const replacement: DeviceIdentity = {
        id: crypto.randomUUID(),
      };
      state.devices.push(replacement);

      // Reconcile to ensure pool size is strictly bounded
      this.reconcilePoolSize(state, poolSize);

      await this.savePool(env, state);
    });
  }
}

export const deviceManager = new DeviceManager();
