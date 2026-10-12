// Runs every row of test/fixtures/titles.tsv through parse(). Rows tagged [confirmed-conflict] are intended per-title
// answers that no single rule satisfies together: they are reported separately and never fail.
// The run fails only when the pass rate over the other rows drops below 95%. VERBOSE=1 prints every mismatch.
// A note containing `DIR=<name>` runs the row with that rule directory. Also prints a grouping report over the Mirakurun snapshot (informational only).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { parse } = require('../epgXport.js');

const TARGET = 0.95;
const fx = f => path.join(__dirname, 'fixtures', f);
const rows = fs.readFileSync(fx('titles.tsv'), 'utf8').split('\n').slice(1).filter(Boolean).map(l => l.split('\t'));

test('movie language versions', () => {
  const version = name => parse({ name, genres: [[6, 0]] }).version;
  assert.strictEqual(version('[映]ウィキッド 永遠の約束(吹替版)[SS][字]'), '吹替版');
  assert.strictEqual(version('第９地区【日本語吹替版】'), '吹替版');
  assert.strictEqual(version('[映]ロッキー5/最後のドラマ[吹]'), '吹替版');
  assert.strictEqual(version('[映]ドリームズ　愛と権力（字幕版）[PG12相当][SS]'), '字幕版');
  assert.strictEqual(version('[映]ロッキー5/最後のドラマ[字]'), undefined); // closed captions, not a version
  assert.strictEqual(parse({ name: 'グレイズ・アナトミー２２　＃１０　裸の自分で（字幕版）', genres: [[3, 0]] }).version, undefined); // TV
});

test('titles.tsv pass rate (excluding confirmed conflicts)', () => {
  const stats = { rule: [0, 0], conflict: [0, 0], tokyo: [0, 0] }, failed = [];
  for (const [i, [raw, genre = '', show, ep = '', sub = '', note = '']] of rows.entries()) {
    const conflict = /\[confirmed-conflict\]/.test(note);
    const genres = genre ? genre.split(',').map(g => g.split('/').map(x => (x === 'x' ? 0 : +x))) : [];
    const p = parse({ name: raw, genres, dir: (note.match(/\bDIR=([^;]+)/) || ['', ''])[1].trim() }); // DIR=<rule directory> in the note
    const e = p.episode === undefined ? '' : p.episodeEnd !== undefined && p.episodeEnd !== p.episode ? `${p.episode}-${p.episodeEnd}` : `${p.episode}`;
    const got = JSON.stringify({ show: p.show, ep: e, sub: p.subtitle || '' }), want = JSON.stringify({ show, ep, sub });
    const ok = got === want;
    stats[conflict ? 'conflict' : 'rule'][ok ? 0 : 1]++;
    if (/\[tokyo\]/.test(note)) stats.tokyo[ok ? 0 : 1]++; // rows from a Tokyo EPG week (the rest are Kansai)
    if (!ok) failed.push(`${conflict ? 'C' : '-'} ${i + 2} ${raw}\n     got  ${got}\n     want ${want}`);
  }
  const pct = ([p, f]) => `${p}/${p + f} (${((100 * p) / (p + f || 1)).toFixed(1)}%)`;
  if (process.env.VERBOSE) console.log(failed.join('\n'));
  console.log(`# titles.tsv  all: ${pct([stats.rule[0] + stats.conflict[0], stats.rule[1] + stats.conflict[1]])}` +
    `  confirmed-conflict rows: ${pct(stats.conflict)}  excluding conflicts: ${pct(stats.rule)} (target ${TARGET * 100}%)` +
    `  [tokyo] rows: ${pct(stats.tokyo)}`);
  const rate = stats.rule[0] / (stats.rule[0] + stats.rule[1]);
  assert.ok(rate >= TARGET, `pass rate ${(rate * 100).toFixed(1)}% is below ${TARGET * 100}%`);
});

const snapshot = fx('programs-20260930.jsonl'); // local EPG dump, not published: the report is skipped without it
test('grouping report (informational)', { skip: !fs.existsSync(snapshot) && 'no EPG snapshot (not published)' }, () => {
  const file = snapshot;
  const slots = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const p = JSON.parse(line);
    if (p.shared && p.shared[0] !== p.serviceId) continue; // simulcast sub-channel duplicate
    const d = new Date(p.startAt + 9 * 3600e3).toISOString();
    const k = `${p.networkId}-${p.serviceId} ${p.channel} ${d.slice(11, 16)}`;
    if (!slots.has(k)) slots.set(k, { days: new Set(), shows: new Map() });
    const s = slots.get(k), show = parse({ name: p.name, genres: p.genres || [] }).show;
    s.days.add(d.slice(0, 10));
    s.shows.set(show, (s.shows.get(show) || []).concat(p.name));
  }
  const compact = x => x.toLowerCase().replace(/[\s・:/!?~.。、,'"“”\-]/g, '');
  const rec = [...slots].filter(([, s]) => s.days.size >= 3), multi = rec.filter(([, s]) => s.shows.size > 1);
  const split = multi.map(([k, s]) => { // shows in one slot that share a 4-char prefix = probably one show split
    const g = new Map();
    for (const [sh, names] of s.shows) { const p = compact(sh).slice(0, 4); g.set(p, (g.get(p) || []).concat([[sh, names]])); }
    return [k, [...g.values()].filter(v => v.length > 1).flat()];
  }).filter(([, v]) => v.length);
  console.log(`\n# grouping: ${rec.length} recurring slots (>=3 days); ${multi.length} yield >1 show folder; ${split.length} contain likely splits (shows sharing a 4-char prefix)`);
  for (const [k, v] of split.sort((a, b) => b[1].length - a[1].length).slice(0, 20))
    console.log(`#  ${k}: ${v.map(([sh, n]) => `[${sh}] x${n.length} e.g. ${n[0]}`).join('  |  ')}`);
});
