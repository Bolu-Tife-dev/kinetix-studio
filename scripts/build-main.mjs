import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist-main', { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist-main/main.js',
});

await build({
  ...common,
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist-main/preload.js',
});
