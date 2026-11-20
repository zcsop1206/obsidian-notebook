/**
 * S42 unit tests (docs/study/BOARD.md): the day file's parser, label splitter and one-line
 * toggle in src/study/panels/plan-day.ts. The sample is the brief's invented day file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivate, labelSegments, parseDayFile, toggleRow } from '../../src/study/panels/plan-day';

const SAMPLE = [
  '---',
  'study: plan',
  '---',
  '# Sat 11-21 · 360 min',
  'A label line written by the planner. Work from the top.',
  '',
  "- [ ] 30 · drills · Today's drills (fx-div is 2 days overdue)",
  '- [ ] 30 · putnam · settle the 2 open calls (Today lists them)',
  '- [x] 75 · putnam · first pass [[fx-units]], part 1 of 2',
  '- [ ] 45 · putnam · **Putnam timed half paper, then settle and score it**',
  '- [ ] 45 · private',
  '- [x] 60 · mie301 · extra',
  'hours 2026-12-12 60',
  'answer asic-1 a',
  '',
].join('\n');

test('parseDayFile: header minutes and the rows in file order, nothing else', () => {
  const d = parseDayFile(SAMPLE);
  assert.deepEqual(d.header, { minutes: 360 });
  assert.equal(d.rows.length, 6);
  assert.deepEqual(d.rows.map(r => r.line), [6, 7, 8, 9, 10, 11]);
  assert.deepEqual(d.rows.map(r => r.minutes), [30, 30, 75, 45, 45, 60]);
  assert.deepEqual(d.rows.map(r => r.ticked), [false, false, true, false, false, true]);
  assert.deepEqual(d.rows.map(r => r.deliverable), ['drills', 'putnam', 'putnam', 'putnam', 'private', 'mie301']);
  assert.equal(d.rows[0].label, "Today's drills (fx-div is 2 days overdue)");
  assert.equal(d.rows[3].label, '**Putnam timed half paper, then settle and score it**');
  assert.equal(d.rows[5].label, 'extra');
  assert.equal(d.rows[2].raw, '- [x] 75 · putnam · first pass [[fx-units]], part 1 of 2');
  // hours/answer lines, prose, the header and frontmatter are not rows
  assert.ok(!d.rows.some(r => /hours|answer|study: plan|label line/.test(r.raw)));
});

test('parseDayFile: links with and without an alias', () => {
  const d = parseDayFile('- [ ] 20 · nt · read [[fx-units]] then [[fx-sets|the sets basic]] and [[fx-x#part]]\n');
  assert.deepEqual(d.rows[0].links, [
    { id: 'fx-units', alias: null },
    { id: 'fx-sets', alias: 'the sets basic' },
    { id: 'fx-x', alias: null },
  ]);
  assert.deepEqual(parseDayFile(SAMPLE).rows[2].links, [{ id: 'fx-units', alias: null }]);
});

test('parseDayFile: * bullets and X boxes are rows too', () => {
  const d = parseDayFile('* [ ] 10 · a · one\n* [X] 15 · b · two\n- [X] 5 · c · three\n+ [ ] 5 · d · not a row\n');
  assert.deepEqual(d.rows.map(r => [r.minutes, r.ticked, r.deliverable]), [[10, false, 'a'], [15, true, 'b'], [5, true, 'c']]);
});

test('parseDayFile: a private row has its minutes only', () => {
  const r = parseDayFile(SAMPLE).rows[4];
  assert.equal(r.minutes, 45);
  assert.equal(r.deliverable, 'private');
  assert.equal(r.label, '');
  assert.deepEqual(r.links, []);
  assert.ok(isPrivate(r));
  assert.ok(!isPrivate(parseDayFile(SAMPLE).rows[0]));
});

test('parseDayFile: a label with · in it keeps everything after the deliverable', () => {
  const r = parseDayFile('- [ ] 45 · study · check the seven items · due 11-20\n').rows[0];
  assert.equal(r.deliverable, 'study');
  assert.equal(r.label, 'check the seven items · due 11-20');
});

test('parseDayFile: CRLF files parse the same, raw has no \\r', () => {
  const a = parseDayFile(SAMPLE);
  const b = parseDayFile(SAMPLE.replace(/\n/g, '\r\n'));
  assert.deepEqual(b, a);
  assert.ok(!b.rows.some(r => r.raw.includes('\r')));
});

test('parseDayFile: no header, no rows, odd rows Adit may add', () => {
  assert.deepEqual(parseDayFile(''), { header: null, rows: [] });
  assert.deepEqual(parseDayFile('# Just a heading\nsome prose\n'), { header: null, rows: [] });
  const d = parseDayFile('- [ ] 30 · gym\n- [ ] call the lab\n- [ ] \n- [ ] 25\n');
  assert.deepEqual(d.rows.map(r => [r.minutes, r.deliverable, r.label]), [[30, '', 'gym'], [null, '', 'call the lab'], [25, '', '']]);
});

test('labelSegments: bold and links, the markup never shows', () => {
  assert.deepEqual(labelSegments('first pass [[fx-units]], part 1 of 2'), [
    { text: 'first pass ', bold: false },
    { text: 'fx-units', bold: false, link: { id: 'fx-units', alias: null } },
    { text: ', part 1 of 2', bold: false },
  ]);
  assert.deepEqual(labelSegments('**timed paper** then [[fx-sets|sets]]'), [
    { text: 'timed paper', bold: true },
    { text: ' then ', bold: false },
    { text: 'sets', bold: false, link: { id: 'fx-sets', alias: 'sets' } },
  ]);
  assert.deepEqual(labelSegments('**read [[fx-a]]**'), [
    { text: 'read ', bold: true },
    { text: 'fx-a', bold: true, link: { id: 'fx-a', alias: null } },
  ]);
  // an unpaired ** stays as text
  assert.deepEqual(labelSegments('2 ** 3'), [{ text: '2 ** 3', bold: false }]);
  for (const r of parseDayFile(SAMPLE).rows) {
    for (const s of labelSegments(r.label)) assert.ok(!/\[\[|\]\]|\*\*/.test(s.text), s.text);
  }
});

test('toggleRow: flips exactly that line, both ways', () => {
  const d = parseDayFile(SAMPLE);
  const t1 = toggleRow(SAMPLE, d.rows[0].line, d.rows[0].raw);
  assert.ok(t1);
  const a = SAMPLE.split('\n');
  const b = (t1 as string).split('\n');
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) {
    if (i === 6) assert.equal(b[i], "- [x] 30 · drills · Today's drills (fx-div is 2 days overdue)");
    else assert.equal(b[i], a[i]);
  }
  const t2 = toggleRow(SAMPLE, d.rows[2].line, d.rows[2].raw) as string;
  assert.equal(t2.split('\n')[8], '- [ ] 75 · putnam · first pass [[fx-units]], part 1 of 2');
  // X unticks too, and * bullets keep their bullet
  assert.equal(toggleRow('* [X] 5 · a · b', 0, '* [X] 5 · a · b'), '* [ ] 5 · a · b');
  // back again gives the original text
  const back = toggleRow(t1 as string, 6, "- [x] 30 · drills · Today's drills (fx-div is 2 days overdue)");
  assert.equal(back, SAMPLE);
});

test('toggleRow: CRLF line endings are kept', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const d = parseDayFile(crlf);
  const t = toggleRow(crlf, d.rows[1].line, d.rows[1].raw) as string;
  assert.equal(t, crlf.replace('- [ ] 30 · putnam · settle', '- [x] 30 · putnam · settle'));
});

test('toggleRow: refused when the line changed under it', () => {
  const d = parseDayFile(SAMPLE);
  const row = d.rows[0];
  // a sync ticked it already
  const synced = SAMPLE.replace('- [ ] 30 · drills', '- [x] 30 · drills');
  assert.equal(toggleRow(synced, row.line, row.raw), null);
  // a line inserted above moves the row down
  assert.equal(toggleRow('new line\n' + SAMPLE, row.line, row.raw), null);
  // the label was edited
  assert.equal(toggleRow(SAMPLE.replace('2 days overdue', '3 days overdue'), row.line, row.raw), null);
  // out of range, or not a row
  assert.equal(toggleRow(SAMPLE, 999, row.raw), null);
  assert.equal(toggleRow('hours 2026-12-12 60', 0, 'hours 2026-12-12 60'), null);
});
