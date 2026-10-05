import 'dotenv/config';
import { z } from 'zod';

const environment = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url().default('postgres://booking:booking@127.0.0.1:15432/booking'),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:16379'),
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60)
});

export const config = environment.parse(process.env);
