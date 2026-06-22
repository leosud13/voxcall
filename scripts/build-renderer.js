import * as esbuild from 'esbuild';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'dist-renderer');
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(__dirname, '..', 'src', 'js', 'app.js')],
  bundle: true,
  outfile: join(outDir, 'bundle.js'),
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'info',
});

console.log('Renderer bundle built successfully.');
