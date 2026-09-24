import type { createClient } from 'redis';
import crypto from 'node:crypto';
import type { HoldStore, RateLimiter } from './types.js';

type RedisClient = ReturnType<typeof createClient>;

export class RedisHoldStore implements HoldStore, RateLimiter {
  constructor(private readonly redis: RedisClient) {}

  async createMany(eventId: number, seatIds: number[], userId: number, ttlSeconds: number) {
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
    const values = await this.redis.mGet(seatIds.map((seatId) => this.key(eventId, seatId)));
    const result = new Map<number, { holdId: string; userId: number }>();
    values.forEach((value, index) => {
      if (!value) return;
      const [holdId, userId] = value.split(':');
      result.set(seatIds[index], { holdId, userId: Number(userId) });
    });
    return result;
  }

  async releaseMany(eventId: number, seatIds: number[], holdId: string, userId: number): Promise<boolean> {
    const script = `
      local deleted = 0
      for _, key in ipairs(KEYS) do
        if redis.call('get', key) == ARGV[1] then deleted = deleted + redis.call('del', key) end
      end
      return deleted
    `;
    const result = await this.redis.eval(script, { keys: seatIds.map((seatId) => this.key(eventId, seatId)), arguments: [`${holdId}:${userId}`] });
    return result === seatIds.length;
  }

  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const count = await this.redis.incr(`rate:${key}`);
    if (count === 1) await this.redis.expire(`rate:${key}`, windowSeconds);
    return count <= limit;
  }

  private key(eventId: number, seatId: number): string {
    return `hold:${eventId}:${seatId}`;
  }
}
