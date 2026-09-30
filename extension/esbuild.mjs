import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
rmSync(path.join(here, 'build'), { recursive: true, force: true });
mkdirSync(path.join(here, 'build'), { recursive: true });

const shared = path.resolve(here, '../shared/src/index.ts');
const options = {
  absWorkingDir: here,
  entryPoints: {
    collector: 'src/collector.ts',
    background: 'src/background.ts',
    options: 'src/options.ts',
  },
  bundle: true,
  outdir: 'build',
  format: 'iife',
  target: 'chrome114',
  alias: { '@npm-outreach/shared': shared },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

for (const file of ['collector.html', 'collector.css', 'options.html', 'manifest.json', 'icon16.png', 'icon48.png', 'icon128.png']) {
  cpSync(path.join(here, file), path.join(here, 'build', file));
}
