import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeviceManager, DEVICE_POOL_KEY, DEFAULT_POOL_SIZE } from './device';
import { UpstreamClient, StatusError } from './client';
import type { Env, DevicePoolState } from './types';

class MockKVNamespace {
  public store = new Map<string, string>();
  public getCalls = 0;
  public putCalls = 0;

  async get(key: string, type?: string): Promise<any> {
    this.getCalls++;
    const val = this.store.get(key);
    if (val === undefined) return null;
    if (type === 'json') {
      try {
        return JSON.parse(val);
      } catch {
        return null;
      }
    }
    return val;
  }

  async put(key: string, value: any): Promise<void> {
    this.putCalls++;
    this.store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

class MockUpstreamClient extends UpstreamClient {
  public sentinelCalls: string[] = [];
  public mockSentinelResponse: ((deviceId: string) => Promise<{ token: string; expiry: number }>) | null = null;

  constructor() {
    super('http://mock');
  }

  async sentinel(deviceId: string): Promise<{ token: string; expiry: number }> {
    this.sentinelCalls.push(deviceId);
    if (this.mockSentinelResponse) {
      return await this.mockSentinelResponse(deviceId);
    }
    return {
      token: `sentinel-for-${deviceId}`,
      expiry: Math.floor(Date.now() / 1000) + 540,
    };
  }
}

describe('DeviceManager', () => {
  let mockKV: MockKVNamespace;
  let env: Env;
  let client: MockUpstreamClient;
  let manager: DeviceManager;

  beforeEach(() => {
    mockKV = new MockKVNamespace();
    env = {
      CHATGPT_KV: mockKV as any,
    };
    client = new MockUpstreamClient();
    manager = new DeviceManager(20_000);
  });

  describe('Device pool initialization & capacity bounds', () => {
    it('initializes default pool size when KV is empty and bounds size', async () => {
      const dev = await manager.getHealthyDevice(env, client);
      expect(dev.id).toBeDefined();
      expect(dev.sentinelToken).toBe(`sentinel-for-${dev.id}`);

      const pool = await manager.getPool(env);
      expect(pool.devices).toHaveLength(DEFAULT_POOL_SIZE);
      expect(pool.devices.map((d) => d.id)).toContain(dev.id);
    });

    it('respects custom DEVICE_POOL_SIZE', async () => {
      env.DEVICE_POOL_SIZE = '5';
      const dev = await manager.getHealthyDevice(env, client);
      expect(dev.id).toBeDefined();

      const pool = await manager.getPool(env);
      expect(pool.devices).toHaveLength(5);
    });

    it('prunes surplus devices down to DEVICE_POOL_SIZE if pool is over capacity', async () => {
      // Seed KV with 5 devices
      const seedState: DevicePoolState = {
        devices: [
          { id: 'dev-1', lastUsedAt: 100 },
          { id: 'dev-2', lastUsedAt: 200 },
          { id: 'dev-3', lastUsedAt: 300 },
          { id: 'dev-4', lastUsedAt: 400 },
          { id: 'dev-5', lastUsedAt: 500 },
        ],
        lastUpdated: Date.now(),
      };
      await mockKV.put(DEVICE_POOL_KEY, seedState);

      env.DEVICE_POOL_SIZE = '3';
      await manager.getHealthyDevice(env, client);

      const pool = await manager.getPool(env);
      expect(pool.devices).toHaveLength(3);
    });
  });

  describe('Round-Robin rotation and Sentinel Token caching', () => {
    it('rotates across healthy devices using round-robin', async () => {
      const dev1 = await manager.getHealthyDevice(env, client);
      const dev2 = await manager.getHealthyDevice(env, client);
      const dev3 = await manager.getHealthyDevice(env, client);
      const dev4 = await manager.getHealthyDevice(env, client);

      // Should visit all 3 distinct devices
      const ids = new Set([dev1.id, dev2.id, dev3.id]);
      expect(ids.size).toBe(3);

      // 4th request cycles back to the first device
      expect(dev4.id).toBe(dev1.id);
    });

    it('reuses cached sentinel tokens when valid', async () => {
      await manager.getHealthyDevice(env, client); // dev1
      await manager.getHealthyDevice(env, client); // dev2
      await manager.getHealthyDevice(env, client); // dev3
      expect(client.sentinelCalls).toHaveLength(3);

      // Cycle through again: all 3 tokens are still valid, so 0 additional sentinel calls
      await manager.getHealthyDevice(env, client);
      await manager.getHealthyDevice(env, client);
      await manager.getHealthyDevice(env, client);
      expect(client.sentinelCalls).toHaveLength(3);
    });

    it('refreshes sentinel token when expiring within 60 seconds', async () => {
      const dev1 = await manager.getHealthyDevice(env, client);
      expect(client.sentinelCalls).toHaveLength(1);

      // Mutate device in pool so expiry is in 30 seconds
      const pool = await manager.getPool(env);
      const target = pool.devices.find((d) => d.id === dev1.id)!;
      target.sentinelExpiry = Math.floor(Date.now() / 1000) + 30;
      target.lastUsedAt = 0; // make it next candidate
      await manager.savePool(env, pool);

      client.mockSentinelResponse = async (deviceId) => ({
        token: `refreshed-token-for-${deviceId}`,
        expiry: Math.floor(Date.now() / 1000) + 600,
      });

      const devRefreshed = await manager.getHealthyDevice(env, client);
      expect(devRefreshed.id).toBe(dev1.id);
      expect(devRefreshed.sentinelToken).toBe(`refreshed-token-for-${dev1.id}`);
      expect(client.sentinelCalls).toHaveLength(2);
    });
  });

  describe('Cooldown reporting and Eviction (Strict Pool Size Cap)', () => {
    it('evicts rate-limited device on 429 and keeps pool strictly at DEVICE_POOL_SIZE', async () => {
      const dev1 = await manager.getHealthyDevice(env, client);
      const poolBefore = await manager.getPool(env);
      expect(poolBefore.devices).toHaveLength(3);

      // Report 429 on dev1
      const error429 = new StatusError('conversation', 429, 'Too Many Requests', 15_000);
      await manager.reportCooldown(env, dev1.id, error429);

      const poolAfter = await manager.getPool(env);
      // Pool size strictly capped at 3
      expect(poolAfter.devices).toHaveLength(3);
      // dev1 was evicted
      expect(poolAfter.devices.map((d) => d.id)).not.toContain(dev1.id);
    });

    it('evicts 403 device and provisions fresh replacement', async () => {
      const dev1 = await manager.getHealthyDevice(env, client);
      const error403 = new StatusError('prepare', 403, 'Forbidden');
      await manager.reportCooldown(env, dev1.id, error403);

      const pool = await manager.getPool(env);
      expect(pool.devices).toHaveLength(3);
      expect(pool.devices.map((d) => d.id)).not.toContain(dev1.id);
    });

    it('recovers immediately when all devices are cooled down by evicting and provisioning', async () => {
      // Seed pool where all devices are cooled
      const seedState: DevicePoolState = {
        devices: [
          { id: 'cool-1', cooldownUntil: Date.now() + 60_000 },
          { id: 'cool-2', cooldownUntil: Date.now() + 60_000 },
          { id: 'cool-3', cooldownUntil: Date.now() + 60_000 },
        ],
        lastUpdated: Date.now(),
      };
      await mockKV.put(DEVICE_POOL_KEY, seedState);

      const freshDev = await manager.getHealthyDevice(env, client);
      expect(freshDev.id).toBeDefined();
      expect(['cool-1', 'cool-2', 'cool-3']).not.toContain(freshDev.id);

      const pool = await manager.getPool(env);
      expect(pool.devices).toHaveLength(3);
    });
  });

  describe('L1 in-isolate memory caching', () => {
    it('uses L1 cache to avoid repeated KV reads within TTL', async () => {
      await manager.getHealthyDevice(env, client);
      const initialGetCalls = mockKV.getCalls;

      // Multiple calls within TTL should use L1 cache and NOT call mockKV.get
      await manager.getHealthyDevice(env, client);
      expect(mockKV.getCalls).toBe(initialGetCalls);
    });

    it('re-reads from KV after cache is cleared', async () => {
      await manager.getHealthyDevice(env, client);
      const initialGetCalls = mockKV.getCalls;

      manager.clearCache();
      await manager.getHealthyDevice(env, client);

      expect(mockKV.getCalls).toBeGreaterThan(initialGetCalls);
    });
  });
});
