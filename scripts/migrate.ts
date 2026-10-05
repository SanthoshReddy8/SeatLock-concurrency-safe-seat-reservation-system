import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { config } from '../src/config.js';

const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize simultaneous application starts and make schema changes atomic.
    await client.query('SELECT pg_advisory_xact_lock(72638194)');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Database schema is ready.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
} finally { await pool.end(); }
