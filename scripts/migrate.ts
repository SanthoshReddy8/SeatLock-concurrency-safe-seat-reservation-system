import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
await pool.end();
console.log('Database schema is ready.');
