// Bundles the unit tests (test/unit/*.test.ts) into test/out/unit.js, run with
// `node --test test/out/unit.js`, the fixture script into test/out/make-fixture.js, and the
// format functions and large-note generator for the ink view test into test/out/view-fixture.js.
import esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const common = { absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' };

const tests = readdirSync(`${root}/test/unit`).filter(f => f.endsWith('.test.ts')).sort();
await esbuild.build({
  ...common,
  stdin: { contents: tests.map(f => `import './${f}';`).join('\n'), resolveDir: `${root}/test/unit`, loader: 'ts', sourcefile: 'unit-tests.ts' },
  outfile: 'test/out/unit.js',
});
await esbuild.build({ ...common, entryPoints: ['test/make-fixture.ts'], outfile: 'test/out/make-fixture.js' });
await esbuild.build({ ...common, platform: 'browser', format: 'iife', target: 'es2020', entryPoints: ['test/view-fixture.ts'], outfile: 'test/out/view-fixture.js' });
