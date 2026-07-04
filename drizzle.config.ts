import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/runtime-home/app-db/schema.ts',
  out: './src/runtime-home/app-db/migrations',
});
