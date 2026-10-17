import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: { DB_PATH: ':memory:', LOG_REQUESTS: '0', SSE_HEARTBEAT_MS: '40' },
  },
});
