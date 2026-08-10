// esbuild バンドル: main (UI) + worker (MLCEngine) を個別エントリで出力
import { build } from 'esbuild';

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'public/dist/main.js' });
await build({ ...common, entryPoints: ['src/worker.ts'], outfile: 'public/dist/worker.js' });
console.log('✅ build done: public/dist/{main,worker}.js');
