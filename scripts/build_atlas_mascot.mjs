#!/usr/bin/env node
// Builds apps/web/assets/atlas-bot/atlas-mascot-scene.js from
// scripts/mascot/atlas-mascot-scene.src.mjs: one minified ES module with the
// Three.js parts it uses bundled in (no CDN at runtime; CSP script-src 'self').
//
//   npm i --no-save three@0.186.1 esbuild@0.25.10   (or set ATLAS_MASCOT_DEPS
//   to a folder whose node_modules has them), then:
//   node scripts/build_atlas_mascot.mjs
//
// Three.js is MIT licensed; its licence comment is kept in the bundle.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deps = process.env.ATLAS_MASCOT_DEPS || ROOT;
const require = createRequire(path.join(deps, 'package.json'));
const esbuild = require('esbuild');
// three's package exports hide package.json from require(); read it from disk.
const threeVersion = JSON.parse(readFileSync(path.join(path.dirname(require.resolve('three')), '..', 'package.json'), 'utf8')).version;
if (threeVersion !== '0.186.1') throw new Error(`three ${threeVersion}: the reviewed build uses 0.186.1`);

const result = await esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts/mascot/atlas-mascot-scene.src.mjs')],
  outfile: path.join(ROOT, 'apps/web/assets/atlas-bot/atlas-mascot-scene.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2020', 'safari15'],
  legalComments: 'inline',
  nodePaths: [path.join(deps, 'node_modules')],
  banner: { js: `/* Atlas AI mascot scene, built by scripts/build_atlas_mascot.mjs from scripts/mascot/atlas-mascot-scene.src.mjs with three@${threeVersion} (MIT, https://threejs.org). Do not edit by hand. */` },
  metafile: true,
  logLevel: 'warning'
});
const out = Object.values(result.metafile.outputs)[0];
console.log(`atlas-mascot-scene.js ${(out.bytes / 1024).toFixed(1)} KiB`);
