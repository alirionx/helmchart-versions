// Builds dist/helm-versions: a single executable (Node SEA) for the platform this runs on.
// Only for releases – development and Docker use server.js directly.
import { build } from 'esbuild';
import { execFileSync } from 'child_process';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { resolve } from 'path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const at = (...parts) => resolve(root, ...parts);

await rm(dist, { recursive: true, force: true });
await mkdir(dist);

// 1. server.js and its dependencies as one ES module (a SEA cannot load node_modules)
await build({
  entryPoints: [at('server.js')],
  outfile: at('dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  // Express and friends are CommonJS and call require() for Node built-ins
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});

// 2. Frontend and default chart list as embedded assets
const assets = { 'sources.json': at('sources.json') };
for (const file of await readdir(at('public'))) assets[`public/${file}`] = at('public', file);

const config = at('dist/sea.json');
await writeFile(config, JSON.stringify({
  main: at('dist/server.mjs'),
  mainFormat: 'module',
  output: at('dist/helm-versions'),
  assets,
  disableExperimentalSEAWarning: true,
}, null, 2));

// 3. Copy the running node binary and inject the app
execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
console.log(`Built dist/helm-versions with Node ${process.version} for ${process.platform}-${process.arch}`);
