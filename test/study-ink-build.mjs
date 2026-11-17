// Bundles test/study-ink-entry.ts into test/out/study-ink.js for test/run_study_ink_test.py.
// `obsidian` resolves to the mock's window.obsidian (the ink module imports only its types today).
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await esbuild.build({
  absWorkingDir: root, bundle: true, platform: 'browser', format: 'iife', target: 'es2020', logLevel: 'warning',
  entryPoints: ['test/study-ink-entry.ts'], outfile: 'test/out/study-ink.js',
  plugins: [{
    name: 'obsidian-global',
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'obsidian-global' }));
      b.onLoad({ filter: /.*/, namespace: 'obsidian-global' }, () => ({ contents: 'module.exports = window.obsidian;', loader: 'js' }));
    },
  }],
});
