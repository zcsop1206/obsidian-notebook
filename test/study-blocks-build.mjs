// Bundles test/study-blocks-entry.ts into test/out/study-blocks.js for test/run_study_blocks_test.py.
// `obsidian` resolves to the mock's window.obsidian (test/mock-obsidian.js).
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await esbuild.build({
  absWorkingDir: root, bundle: true, platform: 'browser', format: 'iife', target: 'es2020', logLevel: 'warning',
  entryPoints: ['test/study-blocks-entry.ts'], outfile: 'test/out/study-blocks.js',
  plugins: [{
    name: 'obsidian-global',
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'obsidian-global' }));
      b.onLoad({ filter: /.*/, namespace: 'obsidian-global' }, () => ({ contents: 'module.exports = window.obsidian;', loader: 'js' }));
    },
  }],
});
