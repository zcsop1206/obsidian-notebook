// Writes the sample note to test/fixtures/ (run with `npm run fixture` from the repo root).
// Commit the result: the unit tests check the committed files match what this produces.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { buildFixture, FIXTURE_NAME } from './fixture';

const root = 'test/fixtures';
rmSync(`${root}/${FIXTURE_NAME}`, { recursive: true, force: true });
mkdirSync(`${root}/${FIXTURE_NAME}`, { recursive: true });
for (const [path, text] of buildFixture()) {
  writeFileSync(`${root}/${path}`, text);
  console.log(`wrote ${root}/${path} (${text.length} bytes)`);
}
