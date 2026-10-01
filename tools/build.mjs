// Build: Rust → wasm (cargo), TypeScript → one ES module (esbuild), static files → dist/.
// Usage: node tools/build.mjs [--skip-rust] [--dev]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const dist = `${root}dist`;
const args = new Set(process.argv.slice(2));
const wasm = `${root}sim/target/wasm32-unknown-unknown/release/mycelium_sim.wasm`;

if (!args.has('--skip-rust')) {
  execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', `${root}sim/Cargo.toml`], { stdio: 'inherit' });
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(`${root}public`, dist, { recursive: true });
copyFileSync(wasm, `${dist}/sim.wasm`);
await build({
  entryPoints: [`${root}src/main.ts`], bundle: true, format: 'esm', target: 'es2022',
  outfile: `${dist}/main.js`, minify: !args.has('--dev'), sourcemap: true, legalComments: 'none',
});
const kb = (f) => `${(statSync(`${dist}/${f}`).size / 1024).toFixed(1)} KB`;
console.log(`built dist/: main.js ${kb('main.js')}, sim.wasm ${kb('sim.wasm')}`);
