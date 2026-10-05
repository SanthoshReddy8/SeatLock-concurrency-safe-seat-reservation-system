import { copyFile } from 'node:fs/promises';

// Keep the SQL alongside the compiled migration runner for npm start / Docker.
await copyFile(new URL('../schema.sql', import.meta.url), new URL('../dist/schema.sql', import.meta.url));
