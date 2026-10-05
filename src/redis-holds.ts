import type { createClient } from 'redis';
import crypto from 'node:crypto';
import type { HoldStore, RateLimiter } from './types.js';

type RedisClient = ReturnType<typeof createClient>;

export class RedisHoldStore implements HoldStore, RateLimiter {
  constructor(private readonly redis: RedisClient, private readonly keyPrefix = '') {}

  async createMany(eventId: number, seatIds: number[], userId: number, ttlSeconds: number) {
    if (seatIds.length === 0) return null;
    const holdId = crypto.randomUUID();
    const keys = seatIds.map((seatId) => this.key(eventId, seatId));
    const script = `
      for _, key in ipairs(KEYS) do if redis.call('exists', key) == 1 then return 0 end end
      for _, key in ipairs(KEYS) do redis.call('set', key, ARGV[1], 'EX', ARGV[2]) end
      return 1
    `;
    const result = await this.redis.eval(script, { keys, arguments: [`${holdId}:${userId}`, String(ttlSeconds)] });
    return result === 1 ? { holdId, expiresInSeconds: ttlSeconds } : null;
  }

  async getMany(eventId: number, seatIds: number[]) {
    const result = new Map<number, { holdId: string; userId: number }>();
    if (seatIds.length === 0) return result;
    const values = await this.redis.mGet(seatIds.map((seatId) => this.key(eventId, seatId)));
    values.forEach((value, index) => {
      if (!value) return;
      const [holdId, userId] = value.split(':');
      result.set(seatIds[index], { holdId, userId: Number(userId) });
    });
    return result;
  }

  async releaseMany(eventId: number, seatIds: number[], holdId: string, userId: number): Promise<boolean> {
    if (seatIds.length === 0) return false;
    const script = `
      for _, key in ipairs(KEYS) do
        if redis.call('get', key) ~= ARGV[1] then return 0 end
      end
      for _, key in ipairs(KEYS) do redis.call('del', key) end
      return #KEYS
    `;
    const result = await this.redis.eval(script, { keys: seatIds.map((seatId) => this.key(eventId, seatId)), arguments: [`${holdId}:${userId}`] });
    return result === seatIds.length;
  }

  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    // Increment and expiration must succeed together: otherwise a crashed process
    // can leave a permanent counter that blocks a client forever.
    const count = await this.redis.eval(`
      local count = redis.call('incr', KEYS[1])
      if count == 1 or redis.call('ttl', KEYS[1]) < 0 then
        redis.call('expire', KEYS[1], ARGV[1])
      end
      return count
    `, { keys: [`${this.keyPrefix}rate:${key}`], arguments: [String(windowSeconds)] });
    return Number(count) <= limit;
  }

  private key(eventId: number, seatId: number): string {
    return `${this.keyPrefix}hold:${eventId}:${seatId}`;
  }
}
