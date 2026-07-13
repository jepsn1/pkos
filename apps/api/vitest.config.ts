import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
  plugins: [
    // SWC handles NestJS decorators/metadata, which esbuild does not
    swc.vite({ module: { type: 'es6' } }),
  ],
});
