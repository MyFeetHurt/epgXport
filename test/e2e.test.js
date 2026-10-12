'use strict';
// Runs epgXport.js as EPGStation would (env vars, no args) against a temp library.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'epgXport.js');
const { trunc } = require(SCRIPT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epgxport-'));
const lib = path.join(tmp, 'lib'), rec = path.join(tmp, 'rec');
fs.mkdirSync(rec);
const START = Date.UTC(2026, 8, 30, 14, 0); // 2026-09-30 23:00 JST

const EXT = '◇番組内容\r\nあらすじ & <テスト>\r\n◇出演者\r\n【出演】ロバート・レッドフォード，山田　太郎ほか\r\n【語り】語り手\r\n' +
  '◇声の出演\r\n好実いのり：小川華果\r\n◇原作・脚本\r\n【原作】作家，【脚本】脚本家\r\n◇監督・演出\r\n【監督】監督者\r\n◇おしらせ\r\n注意\uFFFE事項\u0007';
function run(name, extra = {}) {
  const input = path.join(rec, `${Object.keys(runs).length}.m2ts`);
  if (!fs.existsSync(input)) fs.writeFileSync(input, Buffer.alloc(188 * 10, 0x47));
  runs[name + JSON.stringify(extra)] = input;
  const env = { PATH: process.env.PATH, EPGXPORT_LIBRARY: lib, EPGXPORT_CONFIG: path.join(tmp, 'none.json'), INPUT: input, NAME: name,
    DESCRIPTION: 'あらすじ & <テスト>', EXTENDED: EXT, CHANNELNAME: 'ＢＳテスト', START_AT: String(START),
    END_AT: String(START + 30 * 60e3), GENRE1: '7', SUBGENRE1: '0', GENRE2: '', SUBGENRE2: '', ...extra };
  const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  return { ...r, input };
}
const runs = {};
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const wellFormed = x => { // strict enough for TinyXML (Kodi drops an NFO that doesn't parse)
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>\n<(\w+)>[\s\S]*<\/\1>\n$/);
  assert.doesNotMatch(x, /[\r\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/);
  const stack = [];
  for (const [, close, tag] of x.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z_][\w.-]*)[^<>]*>/g)) close ? assert.strictEqual(stack.pop(), tag) : stack.push(tag);
  assert.strictEqual(stack.length, 0);
  assert.doesNotMatch(x.replace(/<[^<>]*>/g, ''), /[<>]|&(?!(amp|lt|gt|quot);)/);
  for (const t of ['lockdata', 'premiered', 'dateadded', 'fileinfo', 'edition']) assert.ok(!x.includes(`<${t}`), `unexpected <${t}>`);
  if (!x.includes('<tvshow>')) assert.ok(!x.includes('<uniqueid'), 'uniqueid only in tvshow.nfo, from a pinned ID');
};

test('TV episode: layout, hardlink, NFOs, idempotency', () => {
  const r = run('[新]アニメ　薬屋のひとりごと　＃４９「毒見役」[字]');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  const dir = path.join(lib, 'TV', '薬屋のひとりごと'), base = '薬屋のひとりごと - 2026-09-30 2300 - 毒見役';
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${base}.m2ts`, `${base}.nfo`, 'tvshow.nfo'].sort());
  assert.strictEqual(fs.statSync(path.join(dir, `${base}.m2ts`)).ino, fs.statSync(r.input).ino);
  const nfo = fs.readFileSync(path.join(dir, `${base}.nfo`), 'utf8');
  wellFormed(nfo);
  for (const t of ['<episodedetails>', '<title>毒見役</title>', '<showtitle>薬屋のひとりごと</showtitle>', '<episode>49</episode>',
    '<aired>2026-09-30</aired>', '<runtime>30</runtime>', '<genre>アニメ・特撮</genre>', '<tag>国内アニメ</tag>', '<outline>あらすじ &amp; &lt;テスト&gt;</outline>',
    '<tag>新番組</tag>', '<tag>字幕</tag>', '【出演者】\n【出演】ロバート・レッドフォード', '【おしらせ】\n注意事項', '<director>監督者</director>', '<credits>作家</credits>',
    '<credits>脚本家</credits>', '<actor><name>ロバート・レッドフォード</name><role>出演</role></actor>', '<actor><name>山田 太郎</name><role>出演</role></actor>',
    '<actor><name>語り手</name><role>語り</role></actor>', '<actor><name>小川華果</name><role>好実いのり</role></actor>'])
    assert.ok(nfo.includes(t), `missing ${t}`);
  assert.strictEqual(nfo.match(/あらすじ/g).length, 2, '番組内容 duplicating DESCRIPTION is dropped (outline + plot only)');
  const show = fs.readFileSync(path.join(dir, 'tvshow.nfo'), 'utf8');
  wellFormed(show);
  assert.ok(show.includes('<title>薬屋のひとりごと</title>') && !show.includes('<plot>') && !show.includes('<actor>') && !show.includes('新番組'));
  fs.writeFileSync(path.join(dir, 'tvshow.nfo'), 'user edited');
  const again = run('[新]アニメ　薬屋のひとりごと　＃４９「毒見役」[字]');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.strictEqual(fs.readdirSync(dir).length, 3);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'tvshow.nfo'), 'utf8'), 'user edited');
  assert.strictEqual(fs.readFileSync(path.join(dir, `${base}.nfo`), 'utf8'), nfo);
});

test('movie layout and DIR override', () => {
  const r = run('[映]ディープ・ブルー（１９９９）[字]', { GENRE1: '6', SUBGENRE1: '0' });
  assert.strictEqual(r.status, 0, r.stderr);
  const dir = path.join(lib, 'Movies', 'ディープ・ブルー (1999)');
  const nfo = fs.readFileSync(path.join(dir, 'ディープ・ブルー (1999).nfo'), 'utf8');
  wellFormed(nfo);
  assert.match(nfo, /<movie>[\s\S]*<year>1999<\/year>[\s\S]*<genre>映画<\/genre>[\s\S]*<tag>洋画<\/tag>/);
  assert.ok(!/<originaltitle>|<aired>|<premiered>/.test(nfo) && nfo.includes('[映]ディープ・ブルー(1999)[字]</plot>'));
  const ed = run('[映]ブラックホーク・ダウン　完全版', { GENRE1: '6', SUBGENRE1: '0' });
  assert.strictEqual(ed.status, 0, ed.stderr);
  assert.match(fs.readFileSync(path.join(lib, 'Movies', 'ブラックホーク・ダウン', 'ブラックホーク・ダウン.nfo'), 'utf8'), /<tag>完全版<\/tag>/);
  assert.ok(fs.existsSync(path.join(dir, 'ディープ・ブルー (1999).m2ts')));
  const d = run('ぐるっと全国ぶらり旅　第３回', { DIR: '旅番組' });
  assert.strictEqual(d.status, 0, d.stderr);
  assert.ok(fs.existsSync(path.join(lib, 'TV', '旅番組', '旅番組 - 2026-09-30 2300.m2ts')));
  const pin = run('金曜時代劇　大岡越前　第９部', { DIR: '/rec/大岡越前 {tmdb-158199}' }), pdir = path.join(lib, 'TV', '大岡越前 {tmdb-158199}');
  assert.strictEqual(pin.status, 0, pin.stderr);
  const pnfo = fs.readFileSync(path.join(pdir, '大岡越前 - 2026-09-30 2300.nfo'), 'utf8'); // ID stays in the folder name only
  assert.ok(pnfo.includes('<showtitle>大岡越前</showtitle>') && pnfo.includes('<title>大岡越前 2026-09-30</title>'));
  const pshow = fs.readFileSync(path.join(pdir, 'tvshow.nfo'), 'utf8');
  assert.ok(pshow.includes('<title>大岡越前</title>') && pshow.includes('<uniqueid type="tmdb" default="true">158199</uniqueid>'));
});

test('movie versions: 吹替版 and 字幕版 share one folder as "<Title> (<Year>) - <version>"; [字] alone is no version', () => {
  const dir = path.join(lib, 'Movies', '異端者の家 (2024)');
  for (const [name, file] of [['[映]異端者の家（２０２４）（吹替版）[字]', '異端者の家 (2024) - 吹替版'], ['[映]異端者の家（２０２４）（字幕版）', '異端者の家 (2024) - 字幕版'],
    ['[映]異端者の家（２０２４）[字]', '異端者の家 (2024)']]) {
    const r = run(name, { GENRE1: '6', SUBGENRE1: '0' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, `${file}.m2ts`)), file);
  }
  const nfo = fs.readFileSync(path.join(dir, '異端者の家 (2024) - 吹替版.nfo'), 'utf8');
  assert.ok(nfo.includes('<title>異端者の家</title>') && nfo.includes('<tag>吹替版</tag>'));
  assert.strictEqual(fs.readdirSync(path.join(lib, 'Movies')).filter(d => d.startsWith('異端者の家')).length, 1);
});

test('loose-key folder reuse (spacing variants land in one folder)', () => {
  assert.strictEqual(run('【連日放送】プロフェッショナル 仕事の流儀：一節入魂(日)', { GENRE1: '8' }).status, 0);
  assert.strictEqual(run('【連日放送】プロフェッショナル仕事の流儀：答え合わせ(日)', { GENRE1: '8' }).status, 0);
  const dirs = fs.readdirSync(path.join(lib, 'TV')).filter(d => d.startsWith('プロフェッショナル'));
  assert.deepStrictEqual(dirs, ['プロフェッショナル 仕事の流儀']);
  assert.strictEqual(fs.readdirSync(path.join(lib, 'TV', dirs[0])).filter(f => f.endsWith('.m2ts')).length, 2);
});

test('prefix folder reuse at a natural break (4-char and "Show!" names, ／); blank EPG name -> channel folder', () => {
  const tv = path.join(lib, 'TV'), eps = d => fs.readdirSync(path.join(tv, d)).filter(f => f.endsWith('.m2ts'));
  for (const [name, at] of [['徹子の部屋[解][字]', 0], ['徹子の部屋　クワバタオハラ[解][字]', 1], ['ヒルナンデス！[デ]', 2],
    ['ヒルナンデス！優吾＆慎吾！伊香保温泉の女将が教えるメディア初だしグルメ[デ]', 3], ['5分であさイチ　献立をAIと一緒に考えてみよう！[字]', 4],
    ['5分であさイチ“夏枯れ肌”をいたわる洗顔テクニック[字]', 5], ['ニュース', 6], ['ニュースウオッチ9[字]', 7], ['天気予報', 8], ['天気予報最終便', 9],
    ['ラグビー　SANZAARツアー2026', 10], ['[無料]ラグビー わんだほー！～ラグビー情報番組～ #137', 11], ['Green Healing', 12], ['[無]Green Healing World', 13]])
    assert.strictEqual(run(name, { START_AT: String(START + at * 3600e3) }).status, 0);
  const dirs = fs.readdirSync(tv);
  for (const d of ['徹子の部屋', 'ヒルナンデス!', '5分であさイチ', 'ニュース', 'ニュースウオッチ9', '天気予報', '天気予報最終便', 'ラグビー', 'ラグビー わんだほー!', 'Green Healing', 'Green Healing World'])
    assert.ok(dirs.includes(d), `missing folder ${d}`);
  assert.ok(!dirs.some(d => /クワバタオハラ|優吾|夏枯れ/.test(d)), dirs.join(','));
  assert.deepStrictEqual(eps('徹子の部屋'), ['徹子の部屋 - 2026-09-30 2300.m2ts', '徹子の部屋 - 2026-10-01 0000 - クワバタオハラ.m2ts']);
  assert.ok(eps('ヒルナンデス!').includes('ヒルナンデス! - 2026-10-01 0200 - 優吾&慎吾!伊香保温泉の女将が教えるメディア初だしグルメ.m2ts'));
  assert.ok(eps('5分であさイチ').includes('5分であさイチ - 2026-10-01 0400 - “夏枯れ肌”をいたわる洗顔テクニック.m2ts'));
  assert.match(fs.readFileSync(path.join(tv, '徹子の部屋', '徹子の部屋 - 2026-10-01 0000 - クワバタオハラ.nfo'), 'utf8'), /<title>クワバタオハラ<\/title>\n  <showtitle>徹子の部屋<\/showtitle>/);
  // [tokyo] a 4-char name with a kanji qualifies (all-kana / all-Latin 4-char words do not); a 3-char name ending in "!" too;
  // "／" (a safe()d "/") is a break.
  for (const [name, at] of [['時論公論　どう進める？企業のＡＩ活用[字]', 20], ['時論公論“米中接近”の裏側は[字]', 21], ['ZIP!【台風26号最新の進路】', 22],
    ['ZIP!台風26号 警報級大雨も最新進路▽30歳の誕生日を迎えた横浜流星の抱負', 23], ['みんなのKEIBA[字]', 24],
    ['みんなのKEIBA／秋GIへ!毎日王冠&京都大賞典▼今夜発走凱旋門賞へ武豊の想い', 25], ['まもなく', 26], ['まもなく!キリンチャレンジカップ 日本×ベネズエラ', 27]])
    assert.strictEqual(run(name, { START_AT: String(START + at * 3600e3) }).status, 0);
  const after = fs.readdirSync(tv);
  assert.ok(!after.some(d => /米中|台風|秋GI/.test(d)), after.join(','));
  assert.ok(after.includes('まもなく') && after.some(d => d.startsWith('まもなく!キリン')), after.join(','));
  assert.ok(eps('時論公論').includes('時論公論 - 2026-10-01 2000 - “米中接近”の裏側は.m2ts'), eps('時論公論').join(','));
  assert.ok(eps('ZIP!').includes('ZIP! - 2026-10-01 2200 - 台風26号 警報級大雨も最新進路▽30歳の誕生日を迎えた横浜流星の抱負.m2ts'), eps('ZIP!').join(','));
  assert.ok(eps('みんなのKEIBA').some(f => f.startsWith('みんなのKEIBA - 2026-10-02 0000 - 秋GIへ!毎日王冠&京都大賞典')), eps('みんなのKEIBA').join(','));
  const blank = run('　', { CHANNELNAME: 'ＭＢＳ毎日放送' });
  assert.strictEqual(blank.status, 0, blank.stderr);
  assert.ok(fs.existsSync(path.join(tv, 'MBS毎日放送', 'MBS毎日放送 - 2026-09-30 2300.m2ts')));
});

test('filename sanitising and 255-byte limit', () => {
  const r = run('[映]ＬＵＣＹ／ルーシー：Ｗｈａｔ？（字幕版）', { GENRE1: '6', SUBGENRE1: '0' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(lib, 'Movies', 'LUCY／ルーシー：What？', 'LUCY／ルーシー：What？ - 字幕版.m2ts')));
  const long = 'あ'.repeat(120), l = run(`${long} #1「${'い'.repeat(120)}」`);
  assert.strictEqual(l.status, 0, l.stderr);
  for (const f of walk(path.join(lib, 'TV')))
    for (const part of path.relative(lib, f).split(path.sep)) assert.ok(Buffer.byteLength(part) <= 255, `${part.length} chars too long`);
  assert.ok(walk(path.join(lib, 'TV')).some(f => f.includes('あ'.repeat(50)) && f.endsWith('.m2ts')));
});

test('Kodi SxxEyy / e<digit> guard; every NFO written is well-formed', () => {
  assert.strictEqual(run('ダンス部 #3「Stage1 開幕」').status, 0);
  assert.ok(fs.existsSync(path.join(lib, 'TV', 'ダンス部', 'ダンス部 - 2026-09-30 2300.m2ts')));
  assert.strictEqual(run('Type2 #3「決勝」').status, 0);
  assert.ok(fs.existsSync(path.join(lib, 'TV', 'Type2', '2026-09-30 2300 - 決勝.m2ts')));
  for (const f of walk(lib).filter(x => x.endsWith('.nfo'))) { const x = fs.readFileSync(f, 'utf8'); if (x !== 'user edited') wellFormed(x); }
});

test('pinned and unpinned folders are one show; 福祉 accessibility subgenres are flag tags, not genres', () => {
  const tv = path.join(lib, 'TV'), name = 'アニメ　はなかっぱ「はなかっぱ奇想天外！」「おじいちゃんのラブレター」[字][デ]';
  assert.strictEqual(run(name, { DIR: 'はなかっぱ {tmdb-128055}' }).status, 0);
  assert.strictEqual(run(name, { START_AT: String(START + 864e5) }).status, 0); // no DIR, next day
  assert.deepStrictEqual(fs.readdirSync(tv).filter(d => d.startsWith('はなかっぱ')), ['はなかっぱ {tmdb-128055}']);
  assert.ok(fs.existsSync(path.join(tv, 'はなかっぱ {tmdb-128055}', 'はなかっぱ - 2026-10-01 2300 - はなかっぱ奇想天外!／おじいちゃんのラブレター.m2ts')));
  const k = run('科捜研の女１０　＃７[再][字]', { GENRE1: '3', SUBGENRE1: '0', GENRE2: '11', SUBGENRE2: '5' }); // unpinned first, then a pinned DIR
  assert.strictEqual(k.status, 0, k.stderr);
  assert.strictEqual(run('科捜研の女１０　＃８[字]', { DIR: '科捜研の女 {tmdb-55891}', START_AT: String(START + 864e5) }).status, 0);
  assert.deepStrictEqual(fs.readdirSync(tv).filter(d => d.startsWith('科捜研')), ['科捜研の女']);
  const nfo = fs.readFileSync(path.join(tv, '科捜研の女', '科捜研の女 - 2026-09-30 2300.nfo'), 'utf8');
  assert.ok(nfo.includes('<genre>ドラマ</genre>') && nfo.includes('<tag>字幕</tag>') && !/福祉|文字\(字幕\)/.test(nfo), nfo);
  assert.ok(!fs.readFileSync(path.join(tv, '科捜研の女', 'tvshow.nfo'), 'utf8').includes('福祉'));
});

test('EXTENDED shapes from real recordings (【key】 sections, 肩書…名前, 【役名役】, 役名：キャスト header)', () => {
  const { extended } = require(SCRIPT);
  const y = extended('吉本新喜劇の舞台。', '◇【番組内容】\r\n吉本新喜劇の舞台。\r\n◇【出演者】\r\n川畑泰史、すっちー\r\n◇【お知らせ】\r\n字幕放送です');
  assert.strictEqual(y.plot, '吉本新喜劇の舞台。\n\n【出演者】\n川畑泰史、すっちー\n\n【お知らせ】\n字幕放送です');
  assert.deepStrictEqual(y.people, [['actor', ['川畑泰史', '出演者']], ['actor', ['すっちー', '出演者']]]);
  assert.deepStrictEqual(extended('', '◇出演者\n【出演】名古屋市立大学教授　奈良大学特別教授…千田嘉博，歴史学者・健康科学大学特任教授…平山優').people,
    [['actor', ['千田嘉博', '名古屋市立大学教授 奈良大学特別教授']], ['actor', ['平山優', '歴史学者・健康科学大学特任教授']]]);
  assert.deepStrictEqual(extended('', '◇出演者\n【キム・ウンヒ役】キョン・スジン【イム・ソンジェ役】イ・イン').people,
    [['actor', ['キョン・スジン', 'キム・ウンヒ']], ['actor', ['イ・イン', 'イム・ソンジェ']]]);
  assert.deepStrictEqual(extended('', '◇出演者\n役名：キャスト\n小田切ナミ：梶芽衣子').people, [['actor', ['梶芽衣子', '小田切ナミ']]]);
});

test('credit lines in the description and other sections; [label] lines in a credit section', () => {
  const { extended } = require(SCRIPT);
  const people = (desc, ext = '') => extended(desc, ext).people;
  assert.deepStrictEqual(people('出演：菅原文太／安藤昇／小池朝雄　監督：深作欣二　菅原文太が寄る辺なき狂犬を演じた（１９７２年）'), [
    ['actor', ['菅原文太', '出演']], ['actor', ['安藤昇', '出演']], ['actor', ['小池朝雄', '出演']], ['director', '深作欣二']]);
  assert.deepStrictEqual(people('B級アクション。\n\n2019年　イギリス\n監督：フィリップ・マルチネス／ロス・Ｗ・クラークソン\n出演：スティーヴン・セガール／ソーニャ・クーリング'), [
    ['director', 'フィリップ・マルチネス'], ['director', 'ロス・W・クラークソン'], ['actor', ['スティーヴン・セガール', '出演']], ['actor', ['ソーニャ・クーリング', '出演']]]);
  assert.deepStrictEqual(people('名探偵の活躍。\n原作：青山剛昌\n声の出演：高山みなみ(江戸川コナン)、山口勝平(工藤新一)\nオープニングテーマ「雲に乗って」(三枝夕夏 IN db)\n地上波放送：2007年1月22日'), [
    ['credits', '青山剛昌'], ['actor', ['高山みなみ', '江戸川コナン']], ['actor', ['山口勝平', '工藤新一']]]);
  assert.deepStrictEqual(people('逃げた花嫁!!\n出演者：渡瀬恒彦、平田満、若村麻由美 ほか', '◇番組内容\n夜明が迫る！\n\n原作：笹沢左保／脚本：塩田千種／音楽：長谷部徹／監督：吉田啓一郎／制作：テレビ朝日'), [
    ['actor', ['渡瀬恒彦', '出演者']], ['actor', ['平田満', '出演者']], ['actor', ['若村麻由美', '出演者']],
    ['credits', '笹沢左保'], ['credits', '塩田千種'], ['director', '吉田啓一郎']]);
  assert.deepStrictEqual(people('', '◇監督・出演\n[監督]\nジャウム・コレット＝セラ\n\n[出演]\nリーアム・ニーソン\nエド・ハリス'), [
    ['director', 'ジャウム・コレット=セラ'], ['actor', ['リーアム・ニーソン', '出演']], ['actor', ['エド・ハリス', '出演']]]);
  assert.deepStrictEqual(people('ジョーム・コレット＝セラ監督が３度目のタッグ。地上波放送：2007年'), []); // prose, not a credit line
  assert.deepStrictEqual(people('', '◇出演者\n遠野吠／ゴジュウウルフ：冬野心央\r\n暴神竜儀／ゴジュウティラノ：神田聖司'), [
    ['actor', ['冬野心央', '遠野吠/ゴジュウウルフ']], ['actor', ['神田聖司', '暴神竜儀/ゴジュウティラノ']]]);
  assert.deepStrictEqual(people('', '◇声の出演\n（花垣武道／タケミチ）新祐樹\n（松野千冬）狩野翔\nほか'), [
    ['actor', ['新祐樹', '花垣武道/タケミチ']], ['actor', ['狩野翔', '松野千冬']]]);
  assert.deepStrictEqual(people('', '◇スタッフ\n【原作】御子柴奈々\n『冰剣の魔術師が世界を統べる　世界最強の魔術師である少年は、魔術学院に入学する』（講談社ラノベ文庫刊）'),
    [['credits', '御子柴奈々']]);
  assert.deepStrictEqual(people('原作：日向夏（ヒーロー文庫／イマジカインフォス刊）\n原作：東野圭吾『虚ろな十字架』（光文社文庫刊）\n監督：イ・サンヨプ／チェ・ジュンベ\n出演：香山美子 1966年\n出演：深田恭子（2016年）', '◇出演者\n天の声・ナレーター：たくや（ザ・たっち）'), [
    ['actor', ['たくや', '天の声・ナレーター']], // credit sections come first; the bracket isn't part of the name
    ['credits', '日向夏'], ['credits', '東野圭吾'], ['director', 'イ・サンヨプ'], ['director', 'チェ・ジュンベ'],
    ['actor', ['香山美子', '出演']], ['actor', ['深田恭子', '出演']]]);
  // Full-width spaces in a credit line: between names they separate, inside a name ("高倉　健") they don't.
  assert.deepStrictEqual(people('出演：高倉　健、倍賞千恵子'), [['actor', ['高倉健', '出演']], ['actor', ['倍賞千恵子', '出演']]]);
  assert.deepStrictEqual(people('出演：菅原文太　安藤昇　梅宮辰夫'), [['actor', ['菅原文太', '出演']], ['actor', ['安藤昇', '出演']], ['actor', ['梅宮辰夫', '出演']]]);
  // A sentence after the label is not a name.
  assert.deepStrictEqual(people('出演：豪華ゲストが多数登場します！'), []);
  // 名前(役名) under 出演, and 役名/声優 under a 声 label.
  assert.deepStrictEqual(people('出演：西島秀俊(三上)、内野聖陽(島田)'), [['actor', ['西島秀俊', '三上']], ['actor', ['内野聖陽', '島田']]]);
  assert.deepStrictEqual(people('声の出演：コナン/高山みなみ'), [['actor', ['高山みなみ', 'コナン']]]);
});

test('never replaces a different file: same show/date/time gets "(2)"; the same recording again is a no-op', () => {
  const dir = path.join(lib, 'TV', 'NHKニュース7'), base = 'NHKニュース7 - 2026-09-30 2300', name = 'ＮＨＫニュース７';
  const a = run(name), b = run(name, { CHANNELNAME: 'ＢＳ別局' }); // b: another recording (own file, same size), same target name
  assert.strictEqual(a.status, 0, a.stderr); assert.strictEqual(b.status, 0, b.stderr);
  assert.match(a.stderr, / linked .* -> .*2300\.m2ts\n$/);
  const files = () => fs.readdirSync(dir).sort();
  assert.deepStrictEqual(files(), [`${base} (2).m2ts`, `${base} (2).nfo`, `${base}.m2ts`, `${base}.nfo`, 'tvshow.nfo'].sort());
  assert.strictEqual(fs.statSync(path.join(dir, `${base}.m2ts`)).ino, fs.statSync(a.input).ino);
  assert.strictEqual(fs.statSync(path.join(dir, `${base} (2).m2ts`)).ino, fs.statSync(b.input).ino);
  assert.ok(fs.readFileSync(path.join(dir, `${base} (2).nfo`), 'utf8').includes('ＢＳ別局'.normalize('NFKC')));
  for (const r of [run(name, { INPUT: a.input }), run(name, { CHANNELNAME: 'ＢＳ別局', INPUT: b.input })]) assert.match(r.stderr, / exists /);
  assert.strictEqual(files().length, 5);
  fs.writeFileSync(path.join(dir, `${base} (3).m2ts`), 'user file'); // a foreign file with no NFO is never touched either
  assert.strictEqual(run(name, { CHANNELNAME: '第三局' }).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, `${base} (3).m2ts`), 'utf8'), 'user file');
  assert.ok(fs.existsSync(path.join(dir, `${base} (4).m2ts`)));
});

test('other filesystem: copies (logged as "copied"); a re-run is a no-op; a second recording is kept', { skip: !fs.existsSync('/dev/shm') || fs.statSync('/dev/shm').dev === fs.statSync(tmp).dev }, () => {
  const shm = fs.mkdtempSync('/dev/shm/epgxport-'), name = 'コピー番組', dir = path.join(shm, 'TV', name);
  try {
    const go = (input, extra = {}) => spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, EPGXPORT_LIBRARY: shm,
      EPGXPORT_CONFIG: path.join(tmp, 'none.json'), INPUT: input, NAME: name, START_AT: String(START), ...extra } });
    const a = path.join(rec, 'copy-a.ts'), b = path.join(rec, 'copy-b.ts');
    fs.writeFileSync(a, 'aaaa'); fs.writeFileSync(b, 'bbbbbb');
    assert.match(go(a).stderr, / copied /);
    assert.match(go(a).stderr, / exists /);
    assert.match(go(b, { CHANNELNAME: 'B' }).stderr, / copied .*\(2\)\.ts\n$/);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${name} - 2026-09-30 2300 (2).nfo`, `${name} - 2026-09-30 2300 (2).ts`,
      `${name} - 2026-09-30 2300.nfo`, `${name} - 2026-09-30 2300.ts`, 'tvshow.nfo'].sort());
    assert.strictEqual(fs.readFileSync(path.join(dir, `${name} - 2026-09-30 2300.ts`), 'utf8'), 'aaaa');
  } finally { fs.rmSync(shm, { recursive: true, force: true }); }
});

// EPGStation's thumbnail "<thumbnail dir>/<RECORDEDID>.jpg" is linked next to the recording.
const thumbs = path.join(tmp, 'thumbnail');
fs.mkdirSync(thumbs);
const jpeg = (file, text = file) => fs.writeFileSync(path.join(thumbs, file), Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(text), Buffer.from([0xff, 0xd9])]));
const thumbEnv = (id, wait = '2') => ({ RECORDEDID: id, EPGXPORT_THUMBNAIL_DIR: thumbs, EPGXPORT_THUMBNAIL_WAIT: wait });
const ino = f => fs.statSync(f).ino;

test('thumbnails: episode gets <base>-thumb.jpg and <base>.jpg, movie only -thumb.jpg (hardlinks); re-run is a no-op; never overwrites', () => {
  jpeg('101.jpg');
  const r = run('サムネ番組　＃１「始まり」', thumbEnv('101'));
  assert.strictEqual(r.status, 0, r.stderr);
  const dir = path.join(lib, 'TV', 'サムネ番組'), base = 'サムネ番組 - 2026-09-30 2300 - 始まり';
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${base}-thumb.jpg`, `${base}.jpg`, `${base}.m2ts`, `${base}.nfo`, 'tvshow.nfo'].sort());
  for (const f of [`${base}-thumb.jpg`, `${base}.jpg`]) assert.strictEqual(ino(path.join(dir, f)), ino(path.join(thumbs, '101.jpg')));
  assert.match(r.stderr, / linked .*始まり\.m2ts; thumbnail linked .*101\.jpg\n$/);
  const again = run('サムネ番組　＃１「始まり」', { ...thumbEnv('101'), INPUT: r.input });
  assert.match(again.stderr, / exists .*; thumbnail exists .*101\.jpg\n$/);
  assert.strictEqual(fs.readdirSync(dir).length, 5);
  // The user's own picture is never replaced: on a re-run it is kept; a new recording that wants the name moves to "(2)".
  fs.rmSync(path.join(dir, `${base}.jpg`)); fs.writeFileSync(path.join(dir, `${base}.jpg`), 'my art');
  assert.match(run('サムネ番組　＃１「始まり」', { ...thumbEnv('101'), INPUT: r.input }).stderr, /; thumbnail exists\+kept /);
  assert.strictEqual(fs.readFileSync(path.join(dir, `${base}.jpg`), 'utf8'), 'my art');
  fs.writeFileSync(path.join(dir, 'サムネ番組 - 2026-10-01 2300-thumb.jpg'), 'my art');
  jpeg('107.jpg');
  const next = run('サムネ番組　＃２', { ...thumbEnv('107'), START_AT: String(START + 864e5) });
  assert.match(next.stderr, / linked .*2300 \(2\)\.m2ts; thumbnail linked /);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'サムネ番組 - 2026-10-01 2300-thumb.jpg'), 'utf8'), 'my art');
  assert.strictEqual(ino(path.join(dir, 'サムネ番組 - 2026-10-01 2300 (2).jpg')), ino(path.join(thumbs, '107.jpg')));
  assert.ok(!fs.existsSync(path.join(dir, 'サムネ番組 - 2026-10-01 2300.nfo')), 'a name with a foreign picture is not used');

  jpeg('102.jpg');
  const m = run('[映]サムネ映画（２０００）', { GENRE1: '6', SUBGENRE1: '0', ...thumbEnv('102') });
  assert.strictEqual(m.status, 0, m.stderr);
  const mdir = path.join(lib, 'Movies', 'サムネ映画 (2000)');
  assert.deepStrictEqual(fs.readdirSync(mdir).sort(), ['サムネ映画 (2000)-thumb.jpg', 'サムネ映画 (2000).m2ts', 'サムネ映画 (2000).nfo']);
  assert.strictEqual(ino(path.join(mdir, 'サムネ映画 (2000)-thumb.jpg')), ino(path.join(thumbs, '102.jpg')));
});

test('thumbnails: one that appears while the script waits is picked up', async () => {
  const input = path.join(rec, 'late.m2ts');
  fs.writeFileSync(input, 'late');
  const child = require('child_process').spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, EPGXPORT_LIBRARY: lib,
    EPGXPORT_CONFIG: path.join(tmp, 'none.json'), INPUT: input, NAME: '遅いサムネ', START_AT: String(START), ...thumbEnv('103', '10') } });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  setTimeout(() => jpeg('103.jpg'), 800);
  const t0 = Date.now(), code = await new Promise(resolve => child.on('close', resolve));
  assert.strictEqual(code, 0, stderr);
  assert.ok(Date.now() - t0 < 5000, 'stops waiting once the thumbnail is complete');
  assert.match(stderr, /; thumbnail linked .*103\.jpg\n$/);
  assert.strictEqual(ino(path.join(lib, 'TV', '遅いサムネ', '遅いサムネ - 2026-09-30 2300.jpg')), ino(path.join(thumbs, '103.jpg')));
});

test('thumbnails: none appears (an empty file does not count) → placed without images after the configured wait (0 = look once)', () => {
  fs.writeFileSync(path.join(thumbs, '104.jpg'), ''); // ffmpeg has only just created it
  let t0 = Date.now();
  const r = run('サムネなし番組', thumbEnv('104', '1'));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 >= 1000 && Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
  assert.match(r.stderr, / linked .*2300\.m2ts; no thumbnail 104\.jpg in .* after 1 s\n$/);
  assert.deepStrictEqual(fs.readdirSync(path.join(lib, 'TV', 'サムネなし番組')).sort(), ['tvshow.nfo', 'サムネなし番組 - 2026-09-30 2300.m2ts', 'サムネなし番組 - 2026-09-30 2300.nfo']);
  t0 = Date.now();
  assert.match(run('サムネなし番組2', thumbEnv('104', '0')).stderr, /after 0 s\n$/);
  assert.ok(Date.now() - t0 < 1000);
});

test('thumbnails: "<id>(N).jpg" — the highest N written after the programme start wins', () => {
  const old = new Date('2020-01-01');
  jpeg('105.jpg'); fs.utimesSync(path.join(thumbs, '105.jpg'), old, old); // left over from an earlier recording with ID 105
  jpeg('105(1).jpg'); jpeg('105(3).jpg'); fs.utimesSync(path.join(thumbs, '105(3).jpg'), old, old); jpeg('1050.jpg');
  const r = run('番号付きサムネ', thumbEnv('105'));
  assert.match(r.stderr, /; thumbnail linked .*105\(1\)\.jpg\n$/);
  assert.strictEqual(ino(path.join(lib, 'TV', '番号付きサムネ', '番号付きサムネ - 2026-09-30 2300-thumb.jpg')), ino(path.join(thumbs, '105(1).jpg')));
});

test('thumbnails: every sibling of a 255-byte name fits, also as "(2)"', () => {
  jpeg('106.jpg'); jpeg('108.jpg');
  const name = `${'う'.repeat(120)} #1「${'え'.repeat(120)}」`, at = { START_AT: String(START + 2 * 864e5) };
  assert.strictEqual(run(name, { ...at, ...thumbEnv('106') }).status, 0);
  const r = run(name, { ...at, ...thumbEnv('108'), CHANNELNAME: '別局' });
  assert.strictEqual(r.status, 0, r.stderr);
  const files = fs.readdirSync(path.join(lib, 'TV', trunc('う'.repeat(120), 180)));
  assert.strictEqual(files.filter(f => /\(2\)(-thumb)?\.jpg$/.test(f)).length, 2, files.join('\n'));
  assert.ok(files.some(f => Buffer.byteLength(f) > 240), 'the name is really long');
  for (const f of files) assert.ok(Buffer.byteLength(f) <= 255, `${Buffer.byteLength(f)} bytes: ${f}`);
});

test('thumbnails: another filesystem → copied; a re-run sees the copy as the same picture', { skip: !fs.existsSync('/dev/shm') || fs.statSync('/dev/shm').dev === fs.statSync(tmp).dev }, () => {
  const shm = fs.mkdtempSync('/dev/shm/epgxport-');
  try {
    jpeg('109.jpg');
    const input = path.join(rec, 'copy-thumb.ts');
    fs.writeFileSync(input, 'cccc');
    const go = () => spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, EPGXPORT_LIBRARY: shm,
      EPGXPORT_CONFIG: path.join(tmp, 'none.json'), INPUT: input, NAME: 'コピーサムネ', START_AT: String(START), ...thumbEnv('109') } });
    assert.match(go().stderr, / copied .*; thumbnail copied .*109\.jpg\n$/);
    assert.match(go().stderr, / exists .*; thumbnail exists .*109\.jpg\n$/);
    const dir = path.join(shm, 'TV', 'コピーサムネ');
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'コピーサムネ - 2026-09-30 2300-thumb.jpg')), fs.readFileSync(path.join(thumbs, '109.jpg')));
    assert.strictEqual(fs.readdirSync(dir).length, 5);
  } finally { fs.rmSync(shm, { recursive: true, force: true }); }
});

test('link mode "copy": video and thumbnail are copies (own inode), a re-run is a no-op; a bad link value fails', () => {
  jpeg('110.jpg');
  const r = run('コピーモード番組', { ...thumbEnv('110'), EPGXPORT_LINK: 'copy' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, / copied .*2300\.m2ts; thumbnail copied .*110\.jpg\n$/);
  const dir = path.join(lib, 'TV', 'コピーモード番組'), base = 'コピーモード番組 - 2026-09-30 2300';
  assert.notStrictEqual(ino(path.join(dir, `${base}.m2ts`)), ino(r.input));
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, `${base}.m2ts`)), fs.readFileSync(r.input));
  assert.notStrictEqual(ino(path.join(dir, `${base}-thumb.jpg`)), ino(path.join(thumbs, '110.jpg')));
  const again = run('コピーモード番組', { ...thumbEnv('110'), EPGXPORT_LINK: 'copy', INPUT: r.input });
  assert.match(again.stderr, / exists .*; thumbnail exists /);
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.part')));
  assert.strictEqual(fs.readdirSync(dir).length, 5);
  const bad = run('コピーモード番組', { EPGXPORT_LINK: 'symlink' });
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stderr, /link must be "hardlink" or "copy"/);
});

// Caption files as ffmpeg's ARIB decoders write them: with empty clear-screen events.
const ASS = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
  'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(480,500)}{\\1c&H00FFFF&}こんにちは, 世界\n' +
  'Dialogue: 0,0:00:03.00,9:59:59.99,Default,,0,0,0,,{\\pos(480,500)}\n';
const SRT = '1\n00:00:01,000 --> 00:00:03,000\n<font size="36"><font color="#ffff00">こんにちは</font></font>\n<font size="36">世界</font>\n\n' +
  '2\n00:00:02,769 --> 1193:02:50,064\n<font size="36"></font>\n\n3\n00:00:04,000 --> 00:00:05,000\n<font size="36">さようなら</font>\n';
// A fake ffmpeg (set through FFMPEG, as EPGStation does): logs its arguments, writes the output file named by its last argument.
const fakeLog = path.join(tmp, 'ffmpeg-calls.jsonl'), fakeFfmpeg = path.join(tmp, 'fake-ffmpeg');
fs.writeFileSync(fakeFfmpeg + '.js', `
const fs = require('fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify(args) + '\\n');
process.stdout.write('frame=1 progress on stdout\\n');
const out = args[args.length - 1], input = args[args.indexOf('-i') + 1];
if (args.includes('0:s:0')) { // caption extraction
  const decoder = args[args.indexOf('-c:s') + 1], format = args[args.lastIndexOf('-f') + 1];
  if ((process.env.FAKE_NO_DECODERS || '').split(',').includes(decoder)) { process.stderr.write(\`Unknown decoder '\${decoder}'\\n\`); process.exit(8); }
  if (process.env.FAKE_NO_CAPTIONS) { process.stderr.write("Stream map '0:s:0' matches no streams.\\n"); process.exit(1); }
  fs.writeFileSync(out, format === 'ass' ? ${JSON.stringify(ASS)} : ${JSON.stringify(SRT)});
  process.exit(0);
}
if (process.env.FAKE_FFMPEG_FAIL) { fs.writeFileSync(out, 'half'); process.stderr.write('first line\\nInvalid data found when processing input\\n'); process.exit(1); }
fs.writeFileSync(out, 'remuxed:' + fs.readFileSync(input, 'utf8').slice(0, 4));
`);
fs.writeFileSync(fakeFfmpeg, `#!/bin/sh\nexec "${process.execPath}" "${fakeFfmpeg}.js" "$@"\n`, { mode: 0o755 });
// A fake ffprobe (FFPROBE): 100 s of video and audio, or for a remuxed file the durations in FAKE_PART_VIDEO / FAKE_PART_AUDIO
// (no audio with FAKE_PART_NO_AUDIO); FAKE_PROBE_FAIL fails like ffprobe on an unreadable file.
const fakeFfprobe = path.join(tmp, 'fake-ffprobe');
fs.writeFileSync(fakeFfprobe + '.js', `
const fs = require('fs'), file = process.argv[process.argv.length - 1];
const part = fs.readFileSync(file, 'utf8').startsWith('remuxed:'), env = process.env;
if (env.FAKE_PROBE_FAIL) { process.stdout.write('{}'); process.exit(1); } // what ffprobe does for an unreadable file
const d = { video: part && env.FAKE_PART_VIDEO || '100.000000', audio: part && env.FAKE_PART_AUDIO || '100.000000' };
const streams = [{ codec_type: 'video', duration: d.video }, { codec_type: 'audio', duration: d.audio }, { codec_type: 'data' }];
process.stdout.write(JSON.stringify({ streams: part && env.FAKE_PART_NO_AUDIO ? streams.filter(x => x.codec_type !== 'audio') : streams }));
`);
fs.writeFileSync(fakeFfprobe, `#!/bin/sh\nexec "${process.execPath}" "${fakeFfprobe}.js" "$@"\n`, { mode: 0o755 });
const calls = () => fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const remuxEnv = (extra = {}) => ({ EPGXPORT_REMUX: 'true', FFMPEG: fakeFfmpeg, FFPROBE: fakeFfprobe, ...extra });

test('remux: ffmpeg stream copy (first video + all audio) to <name>.part, renamed; stdout stays clean; a re-run does not remux again', () => {
  fs.rmSync(fakeLog, { force: true });
  jpeg('111.jpg');
  const input = path.join(rec, 'remux-a.m2ts');
  fs.writeFileSync(input, 'original recording');
  const r = run('リマックス番組　＃３', { ...thumbEnv('111'), ...remuxEnv(), INPUT: input });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  const dir = path.join(lib, 'TV', 'リマックス番組'), base = 'リマックス番組 - 2026-09-30 2300', dst = path.join(dir, `${base}.m2ts`);
  assert.match(r.stderr, / remuxed .*remux-a\.m2ts -> .*2300\.m2ts; thumbnail linked /);
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), 'remuxed:orig');
  const [args] = calls();
  assert.strictEqual(calls().length, 1);
  assert.deepStrictEqual(args.slice(args.indexOf('-i')), ['-i', input, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-ignore_unknown', '-dn', '-sn',
    '-max_muxing_queue_size', '1024', '-f', 'mpegts', '-y', `${dst}.part`]);
  assert.ok(args.includes('-nostdin') && args.includes('-hide_banner'));
  assert.deepStrictEqual(args.slice(args.indexOf('-fflags'), args.indexOf('-fflags') + 2), ['-fflags', '+discardcorrupt']);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${base}-thumb.jpg`, `${base}.jpg`, `${base}.m2ts`, `${base}.nfo`, 'tvshow.nfo'].sort());
  // Same recording again: recognised by its identical NFO (a remuxed file has another size), so ffmpeg is not run.
  const again = run('リマックス番組　＃３', { ...thumbEnv('111'), ...remuxEnv(), INPUT: input });
  assert.match(again.stderr, / exists .*2300\.m2ts; thumbnail exists /);
  assert.strictEqual(calls().length, 1);
  // Another recording that wants the same name is remuxed to "(2)".
  const other = run('リマックス番組　＃３', { ...remuxEnv(), CHANNELNAME: '別局', INPUT: input });
  assert.match(other.stderr, / remuxed .*2300 \(2\)\.m2ts\n$/);
  assert.strictEqual(fs.readdirSync(dir).length, 7);
  // remuxArgs from the config file replace the default stream selection.
  const cfgFile = path.join(tmp, 'remux.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ remux: true, remuxArgs: ['-map', '0:v:0', '-map', '0:a:0', '-c', 'copy'] }));
  assert.strictEqual(run('リマックス番組２', { FFMPEG: fakeFfmpeg, EPGXPORT_CONFIG: cfgFile, INPUT: input }).status, 0);
  const last = calls().pop();
  assert.deepStrictEqual(last.slice(last.indexOf('-i') + 2, -4), ['-map', '0:v:0', '-map', '0:a:0', '-c', 'copy']);
});

test('remux: an ffmpeg failure removes the .part, logs the reason and places the original (link mode) instead', () => {
  const input = path.join(rec, 'remux-bad.m2ts');
  fs.writeFileSync(input, 'broken recording');
  const r = run('壊れた録画', { ...remuxEnv({ FAKE_FFMPEG_FAIL: '1' }), INPUT: input });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, / linked .*2300\.m2ts; remux failed: ffmpeg exit 1: first line \| Invalid data found when processing input\n$/);
  const dir = path.join(lib, 'TV', '壊れた録画');
  assert.strictEqual(ino(path.join(dir, '壊れた録画 - 2026-09-30 2300.m2ts')), ino(input));
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.part')), fs.readdirSync(dir).join(','));
  const missing = run('ffmpegなし', { ...remuxEnv({ FFMPEG: path.join(tmp, 'no-such-ffmpeg') }), EPGXPORT_LINK: 'copy', INPUT: input });
  assert.strictEqual(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, / copied .*; remux failed: .*no-such-ffmpeg.*ENOENT/);
});

test('remux: a remux that lost part of the recording (reception errors) is discarded; scrambled recordings are named; no ffprobe, no check', () => {
  const input = path.join(rec, 'remux-damaged.m2ts');
  fs.writeFileSync(input, 'damaged recording');
  // ffmpeg exits 0, but the audio stops after 30 of 100 seconds: the original is linked instead.
  const short = run('受信エラー', { ...remuxEnv({ FAKE_PART_AUDIO: '30.0' }), INPUT: input });
  assert.strictEqual(short.status, 0, short.stderr);
  assert.match(short.stderr, / linked .*2300\.m2ts; remux failed: audio is 30 s of 100 s \(damaged recording\)\n$/);
  const dir = path.join(lib, 'TV', '受信エラー');
  assert.strictEqual(ino(path.join(dir, '受信エラー - 2026-09-30 2300.m2ts')), ino(input));
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.part')), fs.readdirSync(dir).join(','));
  // 98 s of 100 is within the 10 s allowance: the remux is kept.
  assert.match(run('受信エラー２', { ...remuxEnv({ FAKE_PART_VIDEO: '98.0' }), INPUT: input }).stderr, / remuxed /);
  // A recording that was never descrambled (every audio/video packet has its scrambling bits set) isn't remuxed at all; the
  // packets are found whether or not the file starts on a packet boundary, and in 192-byte (timestamped) TS too.
  const tsFile = (name, len, skip) => {
    const packet = Buffer.alloc(len, 0xff), at = len - 188;
    packet.fill(0, 0, at); packet[at] = 0x47; packet[at + 1] = 0x01; packet[at + 2] = 0x00; packet[at + 3] = 0x90; // PID 0x100, odd key
    const file = path.join(rec, name);
    fs.writeFileSync(file, Buffer.concat(Array(3000).fill(packet)).subarray(skip));
    return file;
  };
  for (const [i, file] of [tsFile('scr-a.m2ts', 188, 0), tsFile('scr-b.m2ts', 188, 100), tsFile('scr-c.m2ts', 192, 7)].entries()) {
    fs.rmSync(fakeLog, { force: true });
    const s = run(`スクランブル${i}`, { ...remuxEnv(), INPUT: file });
    assert.match(s.stderr, / linked .*; remux failed: the recording is scrambled \(not descrambled\), so it can't be played\n$/);
    assert.strictEqual(calls().length, 0);
  }
  // Without ffprobe, or when it fails, the remux is kept and the log says it wasn't checked.
  const unchecked = run('確認なし', { ...remuxEnv({ FFPROBE: path.join(tmp, 'no-such-ffprobe') }), INPUT: input });
  assert.match(unchecked.stderr, / remuxed .*2300\.m2ts; remux not checked: .*no-such-ffprobe.*ENOENT/);
  assert.match(run('確認失敗', { ...remuxEnv({ FAKE_PROBE_FAIL: '1' }), INPUT: input }).stderr, / remuxed .*; remux not checked: ffprobe exit 1\n$/);
  // remuxArgs that leave out the audio: only the video is compared.
  assert.match(run('音声なし', { ...remuxEnv({ FAKE_PART_NO_AUDIO: '1' }), INPUT: input }).stderr, / remuxed .*2300\.m2ts\n$/);
});

test('subtitles: ARIB captions to <name>.ja.ass / .ja.srt before the NFO, cleaned; re-runs add only missing files; never replaced', () => {
  fs.rmSync(fakeLog, { force: true });
  const input = path.join(rec, 'subs.m2ts');
  fs.writeFileSync(input, 'captioned');
  const env = { FFMPEG: fakeFfmpeg, EPGXPORT_SUBTITLES: 'both', INPUT: input };
  const r = run('字幕番組　＃１[字]', env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, / linked .*2300\.m2ts; subtitles \.ja\.ass written, \.ja\.srt written\n$/);
  const dir = path.join(lib, 'TV', '字幕番組'), base = path.join(dir, '字幕番組 - 2026-09-30 2300');
  const ass = fs.readFileSync(`${base}.ja.ass`, 'utf8'), srt = fs.readFileSync(`${base}.ja.srt`, 'utf8');
  assert.ok(ass.includes('{\\pos(480,500)}{\\1c&H00FFFF&}こんにちは, 世界') && !ass.includes('9:59:59.99'), ass);
  assert.strictEqual(srt, '1\n00:00:01,000 --> 00:00:03,000\nこんにちは\n世界\n\n2\n00:00:04,000 --> 00:00:05,000\nさようなら\n');
  const [assArgs, srtArgs] = calls();
  assert.deepStrictEqual(assArgs.slice(assArgs.indexOf('-c:s'), -1), ['-c:s', 'libaribcaption', '-sub_type', 'ass', '-i', input, '-map', '0:s:0', '-c:s', 'ass', '-f', 'ass', '-y']);
  assert.deepStrictEqual(srtArgs.slice(srtArgs.indexOf('-c:s'), -1), ['-c:s', 'libaribb24', '-i', input, '-map', '0:s:0', '-c:s', 'srt', '-f', 'srt', '-y']);
  assert.ok(!fs.readdirSync(dir).some(f => f.startsWith('.')), 'no temporary file left');
  // Re-run: nothing extracted again while both files exist; a deleted one is added back.
  assert.match(run('字幕番組　＃１[字]', env).stderr, / exists .*; subtitles \.ja\.ass exists, \.ja\.srt exists\n$/);
  assert.strictEqual(calls().length, 2);
  fs.rmSync(`${base}.ja.srt`);
  assert.match(run('字幕番組　＃１[字]', env).stderr, /; subtitles \.ja\.ass exists, \.ja\.srt written\n$/);
  assert.strictEqual(calls().length, 3);
  // A foreign subtitle file at a new recording's name pushes it to "(2)"; the file is not touched.
  fs.writeFileSync(path.join(dir, '字幕番組 - 2026-10-01 2300.ja.ass'), 'my subs');
  const next = run('字幕番組　＃２[字]', { ...env, START_AT: String(START + 864e5) });
  assert.match(next.stderr, / linked .*2300 \(2\)\.m2ts; subtitles \.ja\.ass written, \.ja\.srt written\n$/);
  assert.strictEqual(fs.readFileSync(path.join(dir, '字幕番組 - 2026-10-01 2300.ja.ass'), 'utf8'), 'my subs');
  assert.ok(!fs.existsSync(path.join(dir, '字幕番組 - 2026-10-01 2300.ja.srt')));
});

test('subtitles: a missing ARIB decoder or no caption stream is skipped with a note, never a failure', () => {
  const input = path.join(rec, 'nosubs.m2ts');
  fs.writeFileSync(input, 'no captions');
  const r = run('字幕なし番組', { FFMPEG: fakeFfmpeg, EPGXPORT_SUBTITLES: 'both', FAKE_NO_DECODERS: 'libaribb24', INPUT: input });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /; subtitles \.ja\.ass written, \.ja\.srt skipped \(ffmpeg exit 8: Unknown decoder 'libaribb24'\)\n$/);
  const s = run('字幕なし番組２', { EPGXPORT_SUBTITLE_FFMPEG: fakeFfmpeg, FFMPEG: '/nonexistent', EPGXPORT_SUBTITLES: 'srt', FAKE_NO_CAPTIONS: '1', INPUT: input });
  assert.strictEqual(s.status, 0, s.stderr);
  assert.match(s.stderr, / linked .*; subtitles \.ja\.srt skipped \(ffmpeg exit 1: Stream map '0:s:0' matches no streams\.\)\n$/);
  assert.deepStrictEqual(fs.readdirSync(path.join(lib, 'TV', '字幕なし番組2')).filter(f => /\.ja\./.test(f)), []);
  const bad = run('字幕なし番組', { EPGXPORT_SUBTITLES: 'vtt', INPUT: input });
  assert.match(bad.stderr, /subtitles must be false, "ass", "srt" or "both"/);
});

test('failures exit non-zero with a message', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, EPGXPORT_LIBRARY: lib, INPUT: path.join(tmp, 'missing.ts') }, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /epgXport: INPUT/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
