#!/usr/bin/env node
/**
 * epgXport — put EPGStation recordings into a Jellyfin / Emby / Kodi / Plex library, with NFO metadata.
 *
 * Runs as an EPGStation "encode" command without encoding: the recording is hardlinked (or copied, or optionally remuxed)
 * into the library, NFO files are written from the EPG data, and EPGStation's thumbnail (and optionally the captions)
 * go next to it. One file, no npm dependencies, Node.js 14.14+. See README.md for setup and settings.
 *
 * EPGStation config.yml (no `suffix`, `rate: 1.0`):
 *     encode:
 *         - name: Library
 *           cmd: '%NODE% %ROOT%/config/epgXport.js'
 *           rate: 1.0
 *
 * Input (environment set by EPGStation): INPUT, NAME, DESCRIPTION, EXTENDED, CHANNELNAME, START_AT, END_AT,
 * GENRE1-3, SUBGENRE1-3, DIR/SUBDIR (the rule's directory = show folder name), RECORDEDID (finds the thumbnail), FFMPEG, FFPROBE.
 * Settings: epgXport.json next to this file (or EPGXPORT_CONFIG), overridden by EPGXPORT_* variables (see loadConfig()).
 *
 * Layout: TV/<Show>/<Show> - 2026-09-30 2300 - <subtitle>.ts (+ .nfo, images, subtitles), TV/<Show>/tvshow.nfo,
 * Movies/<Title> (<Year>)/<Title> (<Year>).ts. Sidecars are placed before the NFO, the NFO before the video.
 * An existing file is never replaced; another recording that wants a taken name gets "<name> (2)", "(3)", …
 *
 * Output: one log line on stderr (and in logFile), "<time> linked|copied|remuxed|exists <INPUT> -> <file>; …".
 * Exit code 1 with "epgXport: <message>" on error. As a module it exports { parse, norm, safe, trunc, extended }.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');

// =====================================================================================================================
// 1. Constants and tables
// =====================================================================================================================

/** ARIB STD-B10 content descriptor, level 1 (index = GENREn). 14 (extension) and 15 (その他) are not listed and are skipped. */
const GENRE = 'ニュース・報道|スポーツ|情報・ワイドショー|ドラマ|音楽|バラエティ|映画|アニメ・特撮|ドキュメンタリー・教養|劇場・公演|趣味・教育|福祉'.split('|');

/** ARIB level 2 (SUBGENRE[GENREn][SUBGENREn]). Missing indexes (e.g. 15 = その他) give no tag. */
const SUBGENRE = [
  /*  0 ニュース・報道 */ '定時・総合|天気|特集・ドキュメント|政治・国会|経済・市況|海外・国際|解説|討論・会談|報道特番|ローカル・地域|交通',
  /*  1 スポーツ */ 'スポーツニュース|野球|サッカー|ゴルフ|その他の球技|相撲・格闘技|オリンピック・国際大会|マラソン・陸上・水泳|モータースポーツ|マリン・ウィンタースポーツ|競馬・公営競技',
  /*  2 情報・ワイドショー */ '芸能・ワイドショー|ファッション|暮らし・住まい|健康・医療|ショッピング・通販|グルメ・料理|イベント|番組紹介・お知らせ',
  /*  3 ドラマ */ '国内ドラマ|海外ドラマ|時代劇',
  /*  4 音楽 */ '国内ロック・ポップス|海外ロック・ポップス|クラシック・オペラ|ジャズ・フュージョン|歌謡曲・演歌|ライブ・コンサート|ランキング・リクエスト|カラオケ・のど自慢|民謡・邦楽|童謡・キッズ|民族音楽・ワールドミュージック',
  /*  5 バラエティ */ 'クイズ|ゲーム|トークバラエティ|お笑い・コメディ|音楽バラエティ|旅バラエティ|料理バラエティ',
  /*  6 映画 */ '洋画|邦画|アニメ',
  /*  7 アニメ・特撮 */ '国内アニメ|海外アニメ|特撮',
  /*  8 ドキュメンタリー・教養 */ '社会・時事|歴史・紀行|自然・動物・環境|宇宙・科学・医学|カルチャー・伝統文化|文学・文芸|スポーツ|ドキュメンタリー全般|インタビュー・討論',
  /*  9 劇場・公演 */ '現代劇・新劇|ミュージカル|ダンス・バレエ|落語・演芸|歌舞伎・古典',
  /* 10 趣味・教育 */ '旅・釣り・アウトドア|園芸・ペット・手芸|音楽・美術・工芸|囲碁・将棋|麻雀・パチンコ|車・オートバイ|コンピュータ・TVゲーム|会話・語学|幼児・小学生|中学生・高校生|大学生・受験|生涯教育・資格|教育問題',
  /* 11 福祉 */ '高齢者|障害者|社会福祉|ボランティア|手話|字幕|解説放送',
].map(list => list.split('|'));

/** Genre numbers the parser looks at. */
const G_NEWS = 0, G_DRAMA = 3, G_MOVIE = 6, G_STAGE = 9, G_WELFARE = 11;

/** EPG flag marks such as [字] [新] (gaiji 🈑 🈟 are mapped by norm()), ratings (PG12, R15+), formats (4K) and 前編/後編. */
const FLAG = '音声解説付?|新|終|再|字|デ|解|無料?|二|多|双|SS?|初|生|N|映|吹|手|天|交|HV|SD|[248]K|英|韓|中|録|ほか|前編|後編|字/[日英]+|PG-?12(?:相当)?|R-?1[58]\\+?(?:指定版)?';

/** Flag mark → NFO <tag> (episode and movie NFOs). Other flags give no tag. */
const FLAG_TAG = { 新: '新番組', 終: '最終回', 再: '再放送', 字: '字幕', 二: '二か国語', 解: '解説放送', 吹: '吹替', デ: 'データ放送', 初: '初放送', 生: '生放送' };

/** Movie editions: dropped from the folder name, kept as a tag. "ローマの休日 4Kレストア版" → "ローマの休日". */
const ED = '(?:HD)?(?:[248]K)?(?:デジタル)?(?:リマスター|レストア|修復)版?|(?:HD)?完全版|ノーカット(?:字幕)?版|オリジナル版|スペシャル・エクステンデッド・カット';
/** Editions plus language/format versions, which are only removed when bracketed: "[字幕版]" "(吹替版)" "【HD】". */
const EDITION = `${ED}|(?:日本語)?(?:字幕|吹替)(?:版|スーパー)?|レターボックスサイズ|HD`;
/** A movie's language version, which becomes a " - 吹替版" / " - 字幕版" file name suffix. [字] alone is closed captions, not a version. */
const VERSION = [['吹替版', /吹替|\[吹\]/], ['字幕版', /字幕(?:版|スーパー)|[(<]字幕[)>]/]];

/** Words that mark a 【…】 as a broadcast-block label, not the title: "Dr.コトー診療所 #6-11【週末イッキミドラマ】". */
const BLOCK = /劇場|シアター|ドラマ|洋画|邦画|アニメイズム|一挙|連日|放送|特集|[出主]演|時代劇|デイ$|×|周年|祭り|SP$|BS初|CS初|版$/;

/** Umbrella slots that air other series: "NHKスペシャル病への挑戦…" → folder "病への挑戦". */
const UMBRELLA = /^(NHKスペシャル|プチプチ・アニメ|手話で楽しむみんなのテレビ)[\s×]?/;

/** Leading labels removed from the title, repeatedly (examples after norm()). */
const PREFIX = new RegExp('^(?:' + [
  String.raw`【[^】]*】`, //                                      【連日放送】プロフェッショナル仕事の流儀:…
  String.raw`([●★☆])[^●★☆]*\1(?=\S)`, //                        ●集まれ!スゴ腕アニマルドクター●スゴ腕どうぶつドクター9…
  String.raw`[☆★◆●]+\s?`, //                                   ★にけつッ!!★
  String.raw`[^\s◆◇]{1,3}[◆◇]`, //                             韓◆トンイ #60
  String.raw`(?:TV)?アニメA?・?\s?(?=\S)`, //                    アニメ Battle Spirits…
  String.raw`(?:韓国|中国)(?:ドラマ|時代劇|バラエティ)(?:・セレクション・)?\s?`, // 韓国ドラマ「…」
  String.raw`韓ドラ☆?\s`, //                                     韓ドラ☆ <title>
  String.raw`(?:金曜|BS)?時代劇(?:アワー)?\s?`, //                  時代劇アワー 暴れん坊将軍X
  String.raw`TBSレジェンドドラマ・`,
  String.raw`ミステリー(?:・セレクション|S)・`,
  String.raw`連続ドラマW\s`,
  String.raw`(?:将棋|囲碁)\)`, //                                 将棋)[生]ALSOK杯 第76期 王将戦…
  String.raw`土曜プレミアム・`,
  String.raw`KIDS STATION STAGE\s`,
].join('|') + ')');

/** A broadcast slot label before the title: "Kids劇場 爆上戦隊ブンブンジャー" → "爆上戦隊ブンブンジャー". */
const SLOT = /^(?:ドラマ\d*|[^\s「\u0001]*(?:劇場|のサスペンス|アワー))\s(?=[^\s「▽▼【#])/;

/** Wrapper words before a 「title」: "日5「正反対な君と僕」 #25" → "正反対な君と僕". */
const WRAP = /^(?:大河ドラマ|日\d|韓ドラ|ドラマ|スペシャル|連続テレビ小説|藤子・F・不二雄ワールド|橋田壽賀子ドラマ|新?木曜ドラマ|ドラマDiVE|劇場版|映画|シネマ|[^「」\s]*(?:主演|×)[^「」\s]*)(?=[「『])/;

/** A movie slot before a quoted title: "金曜ロードショー「インサイド・ヘッド」…" → "インサイド・ヘッド", also 韓国映画「…」, …シネマラウンジ『…』. */
const MOVIE_SLOT = /^[^「『]*(?:映画|ロードショー|シネマ|ラウンジ|劇場|シアター)[「『]([^」』]+)[」』]/;

/** A number: Arabic digits or kanji (第十二話). */
const N = '(\\d+|[一二三四五六七八九十百]+)';

/** Episode markers, first match wins. Group 1 = episode, group 2/3 = range end. */
const EPS = [
  /#(\d+)(?:\s?[-~,・&]\s?#?(\d+))*/, //                                    #5, #1-12, #17,18, #01・#02, #1&#2
  new RegExp(`\\(?第${N}(?:[話回](?:、第?${N}[話回])?|、${N}[話回])\\)?`), // 第22回, (第2話), 第32話、33話, 第3、4回
  /(?<![第全\d])(\d+)話/, //                                                 12話 (not 全12話, not 第12話)
  /(?<![A-Za-z])(?:Chapter|Ep\.?|No\.|Vol\.)\s?(\d+)/i, //                   Vol.1, Ep.3, Chapter 2
  /(\d+)\. PHASE-\d+/, //                                                    12. PHASE-2
];

/** "(N)": an episode only right after the show name ("豊臣兄弟!(38)…" → 38), not an age as in "大相撲 玉鷲(41)". */
const PAREN = /\((\d{1,3})\)(?:\((\d{1,3})\))?/;

/** Season words, dropped from the show name (every episode is season 1): "孤独のグルメ Season5#3" → "孤独のグルメ". */
const SEASON = new RegExp([
  String.raw`\(?(?:第[\d一二三四五六七八九十]+(?:期|シリーズ|部)|シーズン\s?\d+|Season\s?\d+|\d+期)\)?`, // 第2期 (第1期) 第23部 シーズン2 Season5 2期
  String.raw`・第\d+部`,
  String.raw`S\d+(?=\s?#|:)`, //                      S2 #5
  String.raw`SECOND SEASON`,
  String.raw`~?\d+(?:st|nd|rd|th) season~?`, //      ~2nd season~
  String.raw`\s[壱弐参肆伍陸漆捌玖](?=\s#)`, //        "… 弐 #3"
  String.raw`(?<=[^\x00-\x7f\s\d])\d{1,2}(?=\s#)`, // グレイズ・アナトミー22 #10
].join('|'), 'gi');

/** Where the show name ends when no episode marker comes first: the earliest match. */
const CUT = new RegExp([
  String.raw`(?<!の|^[^\s「]{1,2})「`, //    an opening 「 (not "…の「", and not after a 1-2 char word: 舞台「桃源暗鬼」 is a title)
  String.raw`[『▽▼◆◇★【\u0001]`, //        sub-headings, decorations, 【…】, a mid-title flag (\u0001)
  String.raw`“[^”]*”(?=\s|$|【)`, //        a “quoted” phrase: 100分de名著“万葉集” → 100分de名著
  // "Show!" followed by a long phrase: "ラヴィット!生バンドで熱唱できるのは誰?…" → "ラヴィット!"
  String.raw`(?<=^[^\s!?]*[!?]+)(?![!?])(?=[^\s\u0001「▽▼【★◆!?(]{13,}[!?▽▼/]|[^\s\u0001「▽▼【★◆]*\.\.\.)`,
  // a slash right after "Show!": "なないろ日和!/都議会" → "なないろ日和!" (other slashes are part of titles: SUITS/スーツ)
  String.raw`(?<=[^\s!?/][!?]+)\/(?!\/)`,
  // a leading Latin word glued with "." to the topic: "DayDay.カスハラ対策…" → "DayDay." (not Mr.サンデー, Dr.コトー)
  String.raw`(?<=^(?!(?:Mrs|Miss|Prof|Vol)\.)[A-Za-z]{3,}\.)(?=[^\sA-Za-z\d.ぁ-ゖ\u0001])`,
  String.raw`(?<=^[^~]*[!?])~`, //          "Show!~tagline~"
  String.raw`(?<!傑作)\s?選(?=[\s「“▽\u0001]|$)`, // スポーツ×ヒューマン選 それでも、土俵へ… → スポーツ×ヒューマン
  String.raw`ゲスト`,
  String.raw`ベストセレクション`,
  String.raw`特別編(?!成)`, //               Qさま!!特別編!… → Qさま!! (特別編成 is not a cut)
  String.raw`~(?=[^~]*編[^~]*~)`, //        an arc in tildes: ドライブミュージック~甲信越編~Part2
  String.raw`\((?![ァ-ヶー]+\))[^()\d]+\)$`, // a trailing (…): ニュース・気象情報(関西); not a katakana reading CARRIERE(キャリール)
  String.raw`\(\d{1,2}\/\d{1,2}\)`, //      a date (9/30)
  String.raw`(?<=[^\d\s])(?:19[5-9]|20[0-4])\d(?![\d年.])`, // a glued year: 国際報道2026, プロ野球2026 広島×阪神
].join('|'), 'g');

/** A ":" outside (…), a cut only without an episode marker: "メーデー!13:航空機事故…" → "メーデー!13" (but "Re:ゼロ…" stays). */
const COLON = /(?<!^[A-Za-z]{1,3}):(?![^(]*\))/;

/**
 * Short versions, specials and digests: they join the parent show and move to the subtitle.
 * "ダーウィンが来た!10min." → "ダーウィンが来た!" + "10min.".
 */
const SUFFIX = /(?:\s?(?:\d+(?:\.\d+)?min\.?|(?<![ァ-ヶー])ミニ|(?<![A-Za-z])mini|\d+分版|(?<![A-Za-z])PR|スペシャル|傑作選?|(?:\d+分)?ダイジェスト|\d+周年PR|直前(?:SP|スペシャル)?)|\sセレクション)!*$/;

/** "<word><suffix>" names that are shows of their own: NHKスペシャル, BSセレクション, ドキュメント20min. */
const SUFFIX_KEEP = /^(?:[A-Z\d]{1,5}|ドキュメント|ニュース)$/;

/** A pinned online ID ({tmdb-N}, {tvdb-N}, [tmdbid-N]): kept in the folder name, removed everywhere else. */
const PIN = /\s*[{[]\w+[-=][^}\]]+[}\]]/g;
const PIN_ID = /[{[](tmdb|tvdb|imdb)(?:id)?[-=]([^}\]]+)[}\]]/g;

/** Text Kodi would read as an episode number (S1E2, ep3, Type2 …e2); kept out of file names. */
const KODI_EPISODE = /s\d+[ ._x-]*e\d|e(p[ ._-]?)?\d/i;

// =====================================================================================================================
// 2. Text normalisation
// =====================================================================================================================

/**
 * Normalise EPG text: gaiji flags → "[x]" (before NFKC, which would make 🈑 a bare 字), NFKC, 〜 → ~, ♯ → #, spaces collapsed.
 * "ドラマ　ＤＩＶＥ🈑" → "ドラマ DIVE[字]".
 */
const norm = text => String(text || '').replace(/[\u{1F100}-\u{1F2FF}]/gu, c => `[${c.normalize('NFKC')}]`)
  .normalize('NFKC').replace(/[〜～]/g, '~').replace(/♯/g, '#').replace(/\s+/g, ' ').trim();

/** Length in characters (code points), not UTF-16 units. */
const charCount = text => [...text].length;

/** Loose comparison key (NFKC, lower case, no spaces or punctuation). */
const key = text => text.normalize('NFKC').toLowerCase().replace(/[\s・:/!?~.。、,'"“”’\-]/g, '');

/** Parse an Arabic or kanji number: "12" → 12, "十二" → 12, "二十" → 20, "百" → 100. */
function parseNumber(text) {
  if (/^\d+$/.test(text)) return +text;
  let total = 0, digit = 0;
  for (const c of text) {
    const i = '〇一二三四五六七八九'.indexOf(c);
    if (i >= 0) digit = i;
    else { total += (digit || 1) * (c === '百' ? 100 : 10); digit = 0; } // 十 or 百
  }
  return total + digit;
}

// =====================================================================================================================
// 3. Title parsing: EPG programme name → { kind, show, episode, subtitle, … }
//
// Steps: stripNoise → parseUmbrella → takeLeadingShow → takeMedleyPrefix → dropTails → (movie?) → cutShow →
// findEpisode → joinWrappedArc → buildSubtitle → tidyShow → moveVersionSuffix. They share a mutable "title" state;
// "\u0001" in title.text marks a removed flag or season word (a delimiter).
// =====================================================================================================================

/** A promotional blurb after "#N" and two full-width spaces: "サザエさん #207　　時代を超えて…" → "サザエさん #207". */
const BLURB_AFTER_EPISODE = /(?<=[#＃][\d０-９]+\S*)\u3000{2}.*$/;

/** Bracketed flags and editions: "[字]", "【HD】", "[吹替版]". */
const FLAG_BRACKET = new RegExp(`[\\[【](?:${FLAG}|${EDITION})[\\]】]`, 'g');

/** Parenthesised and other noise removed from the title. */
const TITLE_NOISE = new RegExp([
  `\\((?:${EDITION}|最終回|主演.*?|\\d+ch .*?)\\)`, // (字幕版) (最終回) (主演:…) (182ch …)
  '\\([^\\d()]\\)(?=[\\s\\[【<(▼▽◆#\\u0001]|$)', //  a one-char note: 水戸黄門 第23部▼第22回「白いお髭の意地比べ」(萩)
  '\\([^\\d()]+\\)(?=#)', //                         a cast note before #N: 遠山の金さん(高橋英樹)#1
  '[(<]?/?全\\d+話[)>]?', //                        episode count: (全10話) <全12話> /全156話
  '(?<![一-鿿])<(?!第\\d+節)[^>]*>', //       <…> labels (<深夜一挙放送>), kept: <第3節>
  '<(?![ァ-ヶー]+>|第\\d+節)[^>]*>', //               <…> after a kanji, unless it is a katakana word
  '\\sEND$',
  '[’\']\\d\\d(?!\\d)', //                          NNNドキュメント’26 → NNNドキュメント
].join('|'), 'g');

/** An edition word not in brackets: "ゴジラ 4Kデジタルリマスター版" → "ゴジラ". */
const EDITION_WORD = new RegExp(`\\s?(?:${ED})(?=[\\s#\\u0001]|$)`, 'g');

/**
 * Normalise the name and strip flags, editions, notes and a release year (returned for movies).
 * "ワンポイント手話(15)職業※字幕スーパー[手]" → "ワンポイント手話(15)職業".
 */
function stripNoise(normalized) {
  let year;
  const text = normalized
    .replace(/※.*$/, '') //                                          ※一部地域は放送休止
    .replace(/\s?【?出演:.*$/, '') //                                 出演:北大路欣也 / 【出演:…】
    .replace(/\(((?:19|20)\d\d)(?:年(?:\s?\S{0,4}公開)?)?\)/, (_, y) => { year = y; return ''; }) // ローマの休日(1953), (2019年 日本公開)
    .replace(/\((?:19|20)\d\d~(?:(?:19|20)\d\d)?\)/g, '\u0001') //   (2019~2023)
    .replace(FLAG_BRACKET, '\u0001')
    .replace(TITLE_NOISE, '')
    .replace(EDITION_WORD, '')
    .replace(/\[([^\]]*)\]/g, '【$1】') //                            other [..] are treated like 【..】
    .replace(/\s*\u0001[\s\u0001]*/g, '\u0001').replace(/^\u0001|\u0001$/g, '').trim(); // one delimiter, none at the ends
  return { text, year };
}

/**
 * Umbrella slots: a first word followed by a space or one 「…」 is a series, else the programme stays in the umbrella folder.
 * "NHKスペシャル 最新科学で見えた「うつ病の正体」…" → "NHKスペシャル".
 */
function parseUmbrella(text, dir) {
  const umbrella = text.match(UMBRELLA);
  if (!umbrella) return null;
  const rest = text.slice(umbrella[0].length);
  const series = rest.replace(/^PR\s/, '').match(/^([^\s「\u0001]+)(?=\s|「[^」]*」$)/);
  return { kind: 'tv', show: dir || (series ? series[1] : umbrella[1]), subtitle: cleanSubtitle(rest) };
}

/**
 * A leading 【show】 or 「show」 is the show ("wrapped"); otherwise strip leading labels and block-label 【…】s.
 * "【クレヨンしんちゃん一挙放送】#537-542" → "クレヨンしんちゃん".
 */
function takeLeadingShow(title, hasGenre) {
  let m = title.text.match(/^【([^】]+)】\s?(?=([#“「])|$)/);
  if (m) {
    title.show = m[2] === '#' && !/一挙/.test(m[1]) ? `【${m[1]}】` : m[1].replace(/一挙放送/, '');
    title.text = title.text.slice(m[0].length);
    return;
  }
  while ((m = title.text.match(PREFIX) || !hasGenre(G_STAGE) && title.text.match(SLOT)))
    title.text = title.text.slice(m[0].length).replace(/^\u0001/, '');
  title.text = title.text.replace(/【([^】]*)】/g, (all, label) => BLOCK.test(label) ? '\u0001' : all).replace(WRAP, '').replace(/\u0001$/, '');
  if ((m = title.text.match(/^([「『])/))) {
    const close = title.text.indexOf(m[1] === '「' ? '」' : '』');
    if (close > 0) { title.show = title.text.slice(1, close); title.text = title.text.slice(close + 1); }
  }
}

/** "X◆Show #N": X is a programme label and becomes the subtitle. */
function takeMedleyPrefix(title) {
  const m = title.text.match(/^([^#◆◇]+)[◆◇](?=[^◆◇#\s]+\s?#)/);
  if (m && title.show === undefined) { title.medley = m[1]; title.text = title.text.slice(m[0].length); }
}

/** Tails that are never show or subtitle. */
const TAIL = new RegExp([
  '[\\s\\u0001]▼.*$', //              cast list: "チャクペ~相棒~#16 ▼チョン・ジョンミョン…"
  '\\s~[^~]+~(?=\\s?#)', //           a spaced tagline before #N: "界隈ほーる ~偏愛の穴に落ちてみた~ #16"
  '[▽▼]\\S*主演$', //                 "▽<actor>主演" at the end
  '◆.*$', //                          everything after ◆
  ' FRIDAY ANIME NIGHT$', //          anime block name: "薬屋のひとりごと FRIDAY ANIME NIGHT"
  '\\s一挙放送(?:\\(\\d+\\))?(?=\\s|$)', // "桃源暗鬼~京都編&練馬編~ 一挙放送(2) #13~24"
].join('|'), 'g');

/** Drop tails; a leading "YYYY " goes to the subtitle. */
function dropTails(title) {
  title.text = title.text.replace(TAIL, '').replace(/^((?:19|20)\d\d) /, (_, y) => { title.leadYear = y; return ''; }).trim();
}

/** Index of the first match of `re` in `text` at or after `from` (Infinity when none). */
function firstIndex(re, text, from) {
  const g = new RegExp(re.source, re.flags.replace('g', '') + 'g');
  g.lastIndex = from;
  const m = g.exec(text);
  return m ? m.index : Infinity;
}

/** 「Y」 before "#N <subtitle>" belongs to the show: "東野圭吾「虚ろな十字架」 #4 「最終話」". */
const QUOTED_TITLE_BEFORE_EPISODE = /^[^「\s]+「[^」]+」(?=\s?#\d+(?!\d)\s?[^\s\u0001])/;

/** Find where the show name ends (not wrapped): the earliest marker, then the space rule. */
function cutShow(title, hasEpisodeMarker, hasGenre) {
  let text = title.text;
  const quoted = (hasEpisodeMarker && text.match(QUOTED_TITLE_BEFORE_EPISODE) || [''])[0];
  const markers = [...EPS, SEASON, CUT, PAREN, ...(hasEpisodeMarker ? [] : [COLON])];
  let markerAt = Math.min(...markers.map(re => firstIndex(re, text, quoted.length || 1))); // never cut at 0
  if (markerAt === Infinity) markerAt = text.length;
  const words = text.slice(0, markerAt).trim().split(' ');
  let cut = markerAt;
  if (!hasEpisodeMarker && words.length > 1 && text[markerAt] !== ':')
    cut = words.slice(0, spaceRuleWordCount(words, text.slice(markerAt), markerAt >= text.length, hasGenre)).join(' ').length;
  title.show = text.slice(0, cut);

  // A glued year: kept in the subtitle ("プロ野球2026 広島×阪神"), dropped for news ("国際報道2026").
  const year = text.slice(cut).match(/^((?:19|20)\d\d)(?!\d)\s?/);
  if (year) {
    title.gluedYear = hasGenre(G_NEWS) ? '' : year[1] + (/[\s<]/.test(text[cut + 4]) ? ' ' : '');
    cut += year[0].length;
  }
  title.cut = cut;

  // Mask season words (same length, so indexes stay valid).
  text = title.text = text.replace(SEASON, x => '\u0001'.repeat(x.length));

  // "(N)" directly at the marker is the episode.
  const paren = new RegExp(PAREN.source, 'g');
  paren.lastIndex = markerAt;
  const m = !hasEpisodeMarker && paren.exec(text);
  if (m && /^[\s\u0001]*$/.test(text.slice(markerAt, m.index)))
    Object.assign(title, { episode: +m[1], episodeEnd: m[2], epAt: m.index, epLen: m[0].length });
}

/**
 * The space rule: how many space-separated words form the show (default 1: "にっぽん縦断 こころ旅 …" → "にっぽん縦断").
 * More for ASCII runs ("SOUL JERKER 7"), short two-word names ("NHKニュース おはよう日本"), numbered dramas, and after a
 * 1-2 char first word ("刑事 吉永誠一…").
 */
function spaceRuleWordCount(words, rest, atEnd, hasGenre) {
  const ascii = w => /^[\x21-\x7e]+$/.test(w);
  let count = ascii(words[0]) ? words.findIndex(w => !ascii(w)) : 1;
  if (count < 0) count = words.length;
  const twoWords = words.length === 2 && count === 1 && charCount(words[1]) < 11 && !/SP$/.test(words[1]) &&
    (/^【/.test(rest) && !/\d/.test(words[1]) || (atEnd || /^\(\d/.test(rest)) && charCount(words[1]) > 4);
  const numberedDrama = hasGenre(G_DRAMA) && count === 1 && /[^\x00-\x7f\d]\d{1,3}$/.test(words[1]);
  if (twoWords || numberedDrama) count = 2;
  const next = words.slice(count).find(Boolean);
  if (charCount(words.slice(0, count).join('')) <= 2 && next && !/^\d+$/.test(next)) count = words.indexOf(next, count) + 1;
  return count;
}

/** The first episode marker after the show: "ポケットモンスター(2023年) 1話からおさらい #17,18" → 17-18. */
function findEpisode(title) {
  if (title.epAt >= 0) return;
  for (const re of title.wrapped ? [...EPS, PAREN] : EPS) {
    const m = title.text.slice(title.cut).match(re);
    if (m) {
      Object.assign(title, { episode: parseNumber(m[1]), episodeEnd: m[2] || m[3], epAt: title.cut + m.index, epLen: m[0].length });
      return;
    }
  }
}

/** An anime arc joins the show: "「東京リベンジャーズ」三天戦争編 第51話" → "東京リベンジャーズ 三天戦争編". */
function joinWrappedArc(title) {
  if (!(title.wrapped && title.epAt > 0)) return;
  const arc = title.text.slice(0, title.epAt).replace(SEASON, '').replace(/[▼▽\u0001]/g, ' ').trim();
  if (/^[^\s「」『』]{0,10}$/.test(arc) && !BLOCK.test(arc)) { title.show += ` ${arc}`; title.cut = title.epAt; }
}

/** The subtitle: the text after the episode marker, else after the show. */
function buildSubtitle(title) {
  const { text, cut, epAt, epLen, show } = title;
  let sub;
  if (epAt >= 0) sub = cleanSubtitle(text.slice(epAt + epLen).replace(/【[^】]*】\s*$/, '')) || cleanSubtitle(text.slice(cut, epAt));
  else sub = cleanSubtitle(title.wrapped && text.endsWith(`「${show}」`) ? text.slice(0, text.lastIndexOf(' ')) : text.slice(cut));
  title.subtitle = title.medley ? cleanSubtitle(title.medley) : [title.leadYear, (title.gluedYear + sub).trim()].filter(Boolean).join(' ');
}

/** Tidy the show name: no season words, kana readings ("夢華録(むかろく)" → "夢華録"), trailing SP or punctuation. */
function tidyShow(show) {
  return show.replace(SEASON, '').replace(/(?<=[一-鿿])\([ぁ-ゖー]+\)(?![ぁ-ゖ])/g, '').replace(/(?<=[^\sA-Z])(?:\d+(?:\.\d)?時間)?SP$/, '')
    .replace(/\u0001/g, ' ').replace(/\s+/g, ' ').replace(/[\s・:/,、(]+$|^[\s・:]+/g, '');
}

/**
 * Move short-version suffixes from the show to the subtitle (not with a DIR). A glued number stays with the suffix:
 * "さわやか自然百景3min.(60) 愛媛" → "さわやか自然百景", subtitle "3min.(60) 愛媛".
 */
function moveVersionSuffix(title, dir) {
  const { text, epAt, epLen, cut } = title;
  let own = epAt >= 0 && epAt === cut && !/\s$/.test(text.slice(0, epAt)) ? text.substr(epAt, epLen) : '';
  let m;
  while (!dir && (m = title.show.match(SUFFIX)) && charCount(key(title.show.slice(0, m.index))) > 3 && !SUFFIX_KEEP.test(title.show.slice(0, m.index).trim())) {
    if (own) title.episode = title.episodeEnd = undefined;
    title.subtitle = [m[0].trim() + own, title.subtitle].filter(Boolean).join(' ');
    own = '';
    title.show = title.show.slice(0, m.index).replace(/[\s・:]+$/, '');
  }
}

/**
 * Parse an EPG programme name (pure). genres = [[level1, level2], …]; dir = the rule's directory, which becomes the show.
 * @returns {{ kind: 'tv'|'movie', show: string, episode?: number, episodeEnd?: number, subtitle: string, year?: string, edition?: string, version?: string }}
 * @example parse({ name: '韓◆トンイ　＃６０＜ノーカット字幕版／全６０話＞[終]' }) // { kind: 'tv', show: 'トンイ', episode: 60, subtitle: '' }
 */
function parse({ name = '', genres = [], dir = '' }) {
  const hasGenre = n => genres.some(g => +g[0] === n);
  const normalized = norm(String(name).replace(BLURB_AFTER_EPISODE, ''));
  const isMovieGenre = hasGenre(G_MOVIE) || /\[映\]/.test(normalized);
  const { text, year } = stripNoise(normalized);

  const umbrella = parseUmbrella(text, dir);
  if (umbrella) return umbrella;

  const title = { text, show: undefined, cut: 0, episode: undefined, episodeEnd: undefined, epAt: -1, epLen: 0, gluedYear: '' };
  takeLeadingShow(title, hasGenre);
  takeMedleyPrefix(title);
  dropTails(title);

  const hasEpisodeMarker = EPS.some(re => re.test(title.text));
  const kind = isMovieGenre && !hasEpisodeMarker ? 'movie' : 'tv';
  if (kind === 'movie') {
    let show = (title.show ?? title.text.replace(/[\u0001【▽◆].*$/, '')).replace(/\u0001/g, ' ');
    show = (show.match(MOVIE_SLOT) || [])[1] || show;
    const edition = (normalized.match(new RegExp(ED, 'g')) || []).join(' ') || undefined;
    const version = (VERSION.find(([, re]) => re.test(normalized)) || [])[0];
    return { kind, show: show.trim(), year, edition, version, subtitle: '' };
  }

  title.wrapped = title.show !== undefined;
  if (!title.wrapped) cutShow(title, hasEpisodeMarker, hasGenre);
  findEpisode(title);
  joinWrappedArc(title);
  // Drama genre: a number glued to the title is the episode ("温泉若おかみの殺人推理16").
  const glued = title.episode === undefined && !title.wrapped && hasGenre(G_DRAMA) && title.show.match(/(?<=[^\x00-\x7f\d])(\d{1,3})$/);
  if (glued) { title.episode = +glued[1]; title.show = title.show.slice(0, glued.index); }
  buildSubtitle(title);
  title.show = tidyShow(title.show);
  moveVersionSuffix(title, dir);

  const rest = title.text.replace(/\u0001/g, ' ');
  if (!title.show) title.show = rest.trim() || norm(name);
  // A DIR longer than the parsed show: the subtitle is what follows it.
  const dirKey = key(dir.replace(PIN, ''));
  if (dirKey && title.episode === undefined && key(title.show) !== dirKey) {
    for (let i = 1; i <= rest.length; i++) if (key(rest.slice(0, i)) === dirKey) { title.subtitle = cleanSubtitle(rest.slice(i)); break; }
  }
  const { episode, episodeEnd, subtitle } = title;
  return { kind, show: dir || title.show, episode, episodeEnd: episodeEnd !== undefined ? parseNumber(episodeEnd) : undefined, subtitle, year };
}

/** Clean a subtitle: no seasons or leading decorations, unwrap 【…】 and an outer 「…」. "「A」「B」" → "A/B". */
function cleanSubtitle(text) {
  let m;
  text = text.replace(SEASON, ' ').replace(/【([^】]*)】|<([^>]*)>/g, ' $1$2 ').replace(/\u0001/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/^~([^~]*)~\s?/, '$1 ').replace(/^(?:[▽▼◆◇★:~・/\-\s]|選(?=[\s「“]|$)|\d{1,2}(?=[\s「]))+/, '').trim();
  if (/^(?:「[^「」]*」[\s/]*)+$/.test(text)) text = text.match(/「[^」]*」/g).map(q => q.slice(1, -1)).join('/');
  else if ((m = text.match(/^「([^「」]*)」(\(.*\))?$/) || text.match(/^\(([^()]*)\)$/))) text = m[1] + (m[2] || '');
  if (!text.includes('「')) text = text.replace(/」/g, '');
  if (!text.includes('」')) text = text.replace(/「/g, '');
  return text.trim();
}

// =====================================================================================================================
// 4. EXTENDED text: plot sections and credits
// =====================================================================================================================

/** EXTENDED section keys whose text holds people. */
const CREDIT_SECTION = /出演|声|キャスト|司会|語り|ナレ|スタッフ|原作|脚本|監督|演出|関連情報/;
/** Credit label → NFO element; other labels are skipped (their text is still in the plot). */
const DIRECTOR_LABEL = /監督|演出/;
const WRITER_LABEL = /脚本|^作$|原作|原案|構成/;
const ACTOR_LABEL = /出演|声|語り|ナレ|司会|MC|ゲスト|キャスト|キャスター|解説|実況|アナ|リポーター|レポーター|進行|講師|案内|パーソナリティ|.役$/;
/** Not a name: starts with a digit or bracket, contains quotes or decorations, is a header word, or is a sentence ("豪華ゲストが登場します!"). */
const NOT_A_NAME = /^[\d(《<[]|[：:「」『』◆◇☆※。!?]|^(?:キャスト|キャスター|ナレーター|役名|出演者?|ゲスト|司会|MC)$|(?:ます|です|した)$/;
/** Credit labels recognised in running text outside the credit sections: "出演：菅原文太／安藤昇　監督：深作欣二　…". */
const CREDIT_LINE_LABEL = /^(?:出演者?|声の出演|キャスト|監督|演出|脚本|原作|ナレーション|ナレーター|語り|司会)$/;

/** Split EXTENDED ("◇key\nvalue…") into [key, text]; "◇【番組内容】" → "番組内容", "◇出演者2" → "出演者". */
function extendedSections(ext) {
  return ext.replace(/\r\n?/g, '\n').split(/\n(?=◇)/).map(part => part.match(/^(?:◇+([^\n]*)\n?)?([\s\S]*)$/))
    .map(m => [norm(m[1]).replace(/^【(.*)】$|\d+$/g, '$1'), m[2].trim()]);
}

/** The plot: DESCRIPTION, then each EXTENDED section under "【key】"; parts contained in another part are dropped. */
function buildPlot(desc, sections) {
  const contains = (part, other) => key(other).includes(key(part));
  const parts = [[, desc.trim()], ...sections].filter(([, text], i, all) =>
    text && !all.some(([, other], j) => j !== i && contains(text, other) && (key(text) !== key(other) || j < i)));
  return parts.map(([k, text], i) => (k && !/^番組内容/.test(k) && k !== (parts[i - 1] || [])[0] ? `【${k}】\n` : '') + text).join('\n\n');
}

/**
 * "label：value" runs in running text → [[label, value], …] for the credit labels only. Any short "xx：" at a line start or after a space
 * or ／ ends the previous value ("原作：笹沢左保／脚本：塩田千種／音楽：…"). A value ends at the line end, or at the first full-width
 * space followed by something that isn't a short name ("監督：深作欣二　菅原文太が…" → 深作欣二; "出演：菅原文太　安藤昇" keeps both).
 */
function creditLines(text) {
  const runs = text.split(/(?:^|(?<=[\s／/]))([^\s：:／/、。「」()（）]{1,8})[：:]/m), found = [];
  for (let i = 1; i < runs.length; i += 2) {
    const label = norm(runs[i]);
    if (!CREDIT_LINE_LABEL.test(label)) continue;
    const [first, ...rest] = runs[i + 1].split(/\n|[▽▼]/)[0].split(/　|\s{2,}/), value = [first]; // ▽ starts the next topic
    for (const part of rest) { if (!/^[^\s\d０-９。！？!?「」『』]{1,12}$/.test(part)) break; value.push(part); } // not 全30話 or prose
    found.push([label, value.join('　').replace(/[／/\s]+$/, '')]);
  }
  return found;
}

/**
 * Split one entry of a credit line on full-width spaces: "菅原文太　安藤昇" is two names, "高倉　健" (a 1-2 character part) is one.
 * Not used in credit sections, where "役名　俳優名" pairs are common.
 */
function spacedNames(entry) {
  // also "名前(所属) 名前", "名前 / 名前" and ●-bulleted lists
  const parts = entry.split(/　|(?<=[)）])\s+|\s+\/\s+|[●○■◆]/).map(p => p.replace(/^・/, '')).filter(p => p && !/^(?:ほか|他|など)$/.test(p)); // ・有田哲平　・…　他
  return parts.length > 1 && parts.every(p => charCount(p) >= 3) ? parts : [parts.join('')];
}

/**
 * People from the credit sections, then from credit lines in the description and the other sections:
 * [['director'|'credits', name] | ['actor', [name, role]], …].
 * "【出演】肩書…名前" gives role 肩書; under a 声 label "名前(役名)" gives role 役名; names are never split on ・ ("ロバート・レッドフォード").
 */
function buildCredits(sections, desc = '') {
  const people = [], seen = new Set();
  const add = (label, text, colonLabel, sectionKey = '', inLine = false) => {
    const tag = DIRECTOR_LABEL.test(label) ? 'director' : WRITER_LABEL.test(label) ? 'credits'
      : ACTOR_LABEL.test(label) || (colonLabel && /声|キャスト|出演/.test(sectionKey)) ? 'actor' : '';
    // separators inside (…) don't split: 原作：日向夏(ヒーロー文庫／イマジカインフォス刊)
    for (const entry of (tag ? text || '' : '').split(/[，、,／\n](?![^(（)）]*[)）])/).flatMap(e => inLine ? spacedNames(e) : [e])) {
      let [, role, name] = norm(entry).replace(/\s*(?:ほか|他)(?:多数)?$/, '')
        .replace(/\s+\d{4}年.*$|(?:\s*\((?=[^()]*\d)[^()]*\))+$/, '') // 香山美子 1966年, 深田恭子(2016年), 堤剛(1981/8/2放送・26分)
        .replace(tag === 'actor' ? /$^/ : /\s*(?:『[^』]*』)?\s*(?:\([^()]*\))?$/, '') // 池波正太郎(新潮文庫刊), 東野圭吾『虚ろな十字架』(光文社文庫刊)
        .match(/^(?:(.*?)\s?\.{3}\s?)?(.*)$/);
      // 声の出演：高山みなみ(江戸川コナン), 出演：西島秀俊(三上): the role in brackets; under other labels (天の声・ナレーター：たくや(ザ・たっち))
      // the label stays the role. Either way the name alone, so the same person matches across recordings.
      const bracketed = tag === 'actor' && name.match(/^(.+?)\s?\(([^()]+)\)$/);
      if (bracketed) { name = bracketed[1]; if (/^声|^(?:出演者?|キャスト)$/.test(label)) role = bracketed[2]; }
      const slashed = /^声/.test(label) && name.match(/^([^/()]+)\/([^/()]+)$/); // 声の出演：コナン/高山みなみ
      if (slashed) [, role, name] = slashed;
      const roleFirst = tag === 'actor' && name.match(/^\(([^()]+)\)\s?([^()]+)$/); // (花垣武道/タケミチ)新祐樹
      if (roleFirst) [, role, name] = roleFirst;
      if (!name || charCount(name) > 20 || NOT_A_NAME.test(name) || seen.has(tag + name)) continue;
      seen.add(tag + name);
      people.push([tag, tag === 'actor' ? [name, role || label.replace(/(.)役$/, '$1')] : name]);
    }
  };
  for (const [sectionKey, text] of sections) {
    if (!CREDIT_SECTION.test(sectionKey)) continue;
    // [text0, 【label】, [label] (a line of its own), label：, text1, …]
    const runs = text.split(/【([^】]+)】|^\[([^\]\n]{1,12})\]$|^(?!https?[：:])([^：:\n【「」[]{1,20})[：:]/m);
    for (let i = 0; i < runs.length; i += 4) {
      const label = norm(i ? runs[i - 3] || runs[i - 2] || runs[i - 1] : /関連|スタッフ/.test(sectionKey) ? '' : sectionKey);
      add(label, runs[i], i && runs[i - 1] !== undefined, sectionKey);
    }
  }
  for (const text of [desc, ...sections.filter(([k]) => !CREDIT_SECTION.test(k)).map(([, t]) => t)])
    for (const [label, value] of creditLines(text)) add(label, value, false, '', true);
  return people;
}

/** DESCRIPTION + EXTENDED → { plot, people }. */
function extended(desc, ext) {
  const sections = extendedSections(ext);
  return { plot: buildPlot(desc, sections), people: buildCredits(sections, desc) };
}

// =====================================================================================================================
// 5. NFO building
// =====================================================================================================================

/** XML text: newlines normalised, invalid XML characters removed, & < > " escaped. */
const esc = value => String(value).replace(/\r\n?/g, '\n')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** An NFO document from [[element, value], …]; empty values are skipped, an array value is an actor [name, role]. */
function xml(root, fields) {
  const lines = fields.filter(([, v]) => v !== undefined && v !== '').map(([element, v]) =>
    `  <${element}>${Array.isArray(v) ? `<name>${esc(v[0])}</name><role>${esc(v[1])}</role>` : esc(v)}</${element.split(' ')[0]}>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${root}>\n${lines.join('\n')}\n</${root}>\n`;
}

/** Genres → show-level fields (studio, genre, tag) and flag tags. 福祉 手話/字幕/解説放送 is a flag tag, not a genre. */
function genreFields(genres, channel, rawName) {
  const tags = [], genreNames = [], flagTags = [...rawName.matchAll(/\[(.)\]/g)].map(m => FLAG_TAG[m[1]]).filter(Boolean);
  for (const [g, sg] of genres) {
    if (g === G_WELFARE && sg > 3) flagTags.push(SUBGENRE[g][sg]);
    else if (GENRE[g]) { genreNames.push(GENRE[g]); tags.push(GENRE[g]); if (SUBGENRE[g][sg]) tags.push(SUBGENRE[g][sg]); }
  }
  const showFields = [['studio', channel || undefined], ...[...new Set(genreNames)].map(g => ['genre', g]), ...[...new Set(tags)].map(t => ['tag', t])];
  return { showFields, flagTags };
}

/** A movie year from the EPG text: "(1983年 141分)", "製作年:1975". */
const MOVIE_YEAR = /((?:19|20)\d\d)年\s?[・/]?\s?(?:本編)?\d{2,3}分|\d{2,3}分。((?:19|20)\d\d)年|製作年?\D{0,3}((?:19|20)\d\d)|((?:19|20)\d\d)年\s?[^\s\d()~]{1,8}(?:制作|製作)/;

// =====================================================================================================================
// 6. Folder and file naming
// =====================================================================================================================

/** A file-name-safe string: / \ : * ? " < > | → full-width forms. "Re:ゼロ" → "Re：ゼロ". */
const safe = text => text.replace(/[/\\:*?"<>|]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).replace(/[\x00-\x1f]/g, '').replace(/^[\s.]+|[\s.]+$/g, '');

/** Cut text to at most `maxBytes` UTF-8 bytes on a character boundary. */
const trunc = (text, maxBytes) => { const chars = [...text]; while (Buffer.byteLength(chars.join('')) > maxBytes) chars.pop(); return chars.join('').trim(); };

/** Bytes kept free after a base name so every sibling fits 255 bytes: " (99)" + the longest suffix ("-thumb.jpg"). */
const suffixBytes = ext => Buffer.byteLength(' (99)') + Math.max(Buffer.byteLength(ext), Buffer.byteLength('-thumb.jpg'));

/** Folder-name key that ignores pinned IDs. */
const folderKey = folder => key(folder.replace(PIN, ''));

/** An existing folder for the same show (same loose key): the exact name, else a pinned one, else the first. */
function findSameFolder(folders, want) {
  const same = folders.filter(f => folderKey(f) === folderKey(want));
  return same.find(f => f === want) || same.find(f => f.replace(PIN, '') !== f) || same[0];
}

/** Can a folder name take longer names by prefix? 5+ chars, 4 with a kanji (時論公論), or 3 ending in !/? (ZIP!). */
function longEnoughForPrefix(name) {
  const k = key(name), n = charCount(k);
  return n > 4 || n === 4 && /[一-鿿々]/.test(k) || n === 3 && /[!?！？]$/.test(name);
}

/**
 * An existing folder whose name starts the new name at a natural break: "徹子の部屋 クワバタオハラ" → "徹子の部屋".
 * @returns {[string, string]|[]} [folder, folder name without pin] or []
 */
function findPrefixFolder(folders, want) {
  return folders.map(f => [f, f.replace(PIN, '').trim()])
    .filter(([, name]) => longEnoughForPrefix(name) && want.startsWith(name) &&
      (/[!?！？]$/.test(name) || /^(?:[\s!?！？☆★“"＂~▽▼…／]|\.\.\.)/.test(want.slice(name.length))) &&
      !/\w \w/.test(name.slice(-1) + want.substr(name.length, 2)))
    .sort((a, b) => b[1].length - a[1].length)[0] || [];
}

/** The TV target: folder (reusing the same show's folder), "<Show> - YYYY-MM-DD HHmm[ - <subtitle>]", NFOs. */
function tvTarget({ cfg, parsed, dir, date, hhmm, ext, nfoItem, rawName, showFields }) {
  const root = path.join(cfg.library, cfg.tvDir), want = trunc(safe(parsed.show), 180) || '_';
  const folders = fs.existsSync(root) ? fs.readdirSync(root) : [];
  let folder = findSameFolder(folders, want);
  const [prefixFolder, prefixName] = dir || folder ? [] : findPrefixFolder(folders, want);
  let { show, subtitle } = parsed;
  if (prefixFolder) {
    subtitle = [cleanSubtitle(show.slice(prefixName.length).replace(/^[\s!?]+/, '')), subtitle].filter(Boolean).join(' ');
    show = show.slice(0, prefixName.length);
  }
  folder = prefixFolder || folder || want;
  const title = show.replace(PIN, '').trim() || show; // a pinned ID stays in the folder name only

  let base = `${KODI_EPISODE.test(folder) ? '' : `${folder.replace(PIN, '').trim() || folder} - `}${date} ${hhmm}`;
  const roomForSubtitle = 255 - suffixBytes(ext) - (Buffer.byteLength(base) + 3); // " - "
  const fileSubtitle = KODI_EPISODE.test(subtitle) ? '' : trunc(safe(subtitle), roomForSubtitle);
  if (fileSubtitle) base += ` - ${fileSubtitle}`;

  const nfo = xml('episodedetails', [['title', subtitle || `${title} ${date}`], ['showtitle', title], ['season', 1], ['episode', parsed.episode],
    ['episodenumberend', parsed.episodeEnd], ['aired', date], ...nfoItem([]), ['originaltitle', rawName]]);
  // A pinned ID becomes <uniqueid>, so Kodi can still match the show online.
  const ids = [...show.matchAll(PIN_ID)].map(([, type, id], i) => [`uniqueid type="${type}"${i ? '' : ' default="true"'}`, id]);
  const showNfo = xml('tvshow', [['title', title], ...ids, ...showFields]);
  return { folderPath: path.join(root, folder), base, nfo, showNfo };
}

/**
 * The movie target: "Movies/<Title> (<Year>)/<Title> (<Year>).ext". A dubbed or subtitled broadcast is named
 * "<Title> (<Year>) - 吹替版.ext" / "- 字幕版.ext", so Jellyfin, Emby and Plex show both recordings as versions of one movie.
 */
function movieTarget({ cfg, parsed, desc, extendedText, nfoItem, rawName }) {
  const text = norm(`${desc} ${extendedText}`);
  const year = parsed.year || (text.match(MOVIE_YEAR) || []).slice(1).find(Boolean);
  const folder = (trunc(safe(parsed.show), 200) || '_') + (year ? ` (${year})` : '');
  const tags = [...(parsed.edition ? parsed.edition.split(' ') : []), parsed.version].filter(Boolean);
  const nfo = xml('movie', [['title', parsed.show], ['year', year], ...nfoItem(tags, rawName)]);
  const base = parsed.version ? `${folder} - ${parsed.version}` : folder;
  return { folderPath: path.join(cfg.library, cfg.movieDir, folder), base, nfo };
}

// =====================================================================================================================
// 7. EPGStation's thumbnail
//
// EPGStation saves one frame of every recording as "<thumbnail dir>/<RECORDEDID>.jpg" (or "<id>(1).jpg", … when taken),
// at the same time as it starts this script, so findThumbnail() waits for it. Images are never generated here.
// =====================================================================================================================

/** Image names next to a recording. A movie gets no "<base>.jpg", which servers would use as its poster. */
const THUMB_SUFFIXES = { tv: ['-thumb.jpg', '.jpg'], movie: ['-thumb.jpg'] };

/** How often findThumbnail() looks at the thumbnail folder. */
const THUMB_POLL_MS = 500;

/** Block for `ms` milliseconds without busy-waiting. */
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * This recording's thumbnail now: { file, n, size } or undefined. Files older than the programme start (an earlier
 * recording with the same ID) are ignored; the highest n wins: "12.jpg" and "12(1).jpg" → "12(1).jpg".
 */
function currentThumbnail(dir, recordedId, notBefore) {
  let names, best;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const name of names) {
    const m = name.startsWith(recordedId) && name.slice(recordedId.length).match(/^(?:\((\d+)\))?\.jpg$/);
    if (!m) continue;
    const file = path.join(dir, name), stat = fs.statSync(file), n = +(m[1] || 0);
    if (stat.mtimeMs >= notBefore && (!best || n > best.n)) best = { file, n, size: stat.size };
  }
  return best;
}

/** Wait up to `waitSeconds` until the thumbnail exists, is not empty, and has the same size twice in a row. */
function findThumbnail(dir, recordedId, notBefore, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (let previous; ;) {
    const found = currentThumbnail(dir, recordedId, notBefore);
    if (found && found.size > 0 && (waitSeconds <= 0 || previous && previous.file === found.file && previous.size === found.size)) return found.file;
    if (Date.now() >= deadline) return undefined;
    previous = found;
    sleep(Math.min(THUMB_POLL_MS, deadline - Date.now()));
  }
}

// =====================================================================================================================
// 8. Placing files in the library
// =====================================================================================================================

/** File contents, or undefined when the file does not exist. */
function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

/**
 * Hardlink `source` to `dst` (copy when impossible), or always copy with mode "copy". Copies are reflinks where supported
 * and go through "<dst>.part". EEXIST is thrown.
 * @returns {'linked'|'copied'}
 */
function linkOrCopy(source, dst, mode) {
  if (mode !== 'copy') {
    try {
      fs.linkSync(source, dst);
      return 'linked';
    } catch (e) { if (e.code === 'EEXIST') throw e; }
  }
  try { fs.copyFileSync(source, dst + '.part', fs.constants.COPYFILE_FICLONE); publishPart(dst); } catch (e) {
    fs.rmSync(dst + '.part', { force: true });
    throw e;
  }
  return 'copied';
}

/** Move a finished `part` file to `dst`, never replacing an existing file (EEXIST is thrown). */
function publishPart(dst, part = dst + '.part') {
  try { fs.linkSync(part, dst); } catch (e) {
    if (e.code === 'EEXIST') throw e;
    if (fs.existsSync(dst)) throw Object.assign(new Error(`${dst} exists`), { code: 'EEXIST' });
    fs.renameSync(part, dst); // a filesystem without hardlinks
    return;
  }
  fs.rmSync(part);
}

/**
 * Run ffmpeg with stdout discarded (EPGStation reads stdout as progress) and stderr in a temporary file.
 * @returns {string|undefined} undefined on success, else the reason (ffmpeg's last error lines)
 */
function runFfmpeg(ffmpeg, args) {
  const logFile = path.join(os.tmpdir(), `epgXport-${process.pid}.log`), log = fs.openSync(logFile, 'w');
  let result;
  try { result = spawnSync(ffmpeg, args, { stdio: ['ignore', 'ignore', log] }); } finally { fs.closeSync(log); }
  const stderr = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join(' | ').slice(-300);
  fs.rmSync(logFile, { force: true });
  return result.error ? `${ffmpeg}: ${result.error.message}`
    : result.status !== 0 ? `ffmpeg exit ${result.status ?? result.signal}${stderr ? `: ${stderr}` : ''}` : undefined;
}

/** Default "remuxArgs": first video and all audio streams, stream copy; captions and data streams are dropped. */
const REMUX_ARGS = ['-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-ignore_unknown', '-dn', '-sn', '-max_muxing_queue_size', '1024'];
const PROBE_ARGS = ['-analyzeduration', '10M', '-probesize', '32M'];

/**
 * The durations (seconds) of the first video and the first audio stream, as ffprobe reports them; null for a type with no stream,
 * 0 when ffprobe can't tell. These are the streams the default remuxArgs keep first (0:v:0, then the audio in order).
 * @returns {{video: number|null, audio: number|null} | string} the durations, or why ffprobe failed
 */
function streamDurations(ffprobe, file) {
  const result = spawnSync(ffprobe, ['-v', 'error', ...PROBE_ARGS, '-show_entries', 'stream=codec_type,duration', '-of', 'json', file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20, timeout: 120000 });
  if (result.error) return `${ffprobe}: ${result.error.message}`;
  if (result.status !== 0) return `ffprobe exit ${result.status ?? result.signal}`; // it still prints "{}" for an unreadable file
  let streams;
  try { streams = JSON.parse(result.stdout).streams || []; } catch (e) { return 'ffprobe gave no JSON'; }
  const first = type => { const s = streams.find(x => x.codec_type === type); return s ? parseFloat(s.duration) || 0 : null; };
  return { video: first('video'), audio: first('audio') };
}

/**
 * Check that the remux kept the whole recording. With reception errors, ffmpeg can exit 0 after dropping minutes of audio or video,
 * so the remux's first video and audio stream must each be as long as the recording's, less 2% (or 10 s): broken packets dropped
 * at the start or end. A type the remux doesn't have (remuxArgs without audio) isn't compared.
 * @returns {{error?: string, note: string}} error when the remux is incomplete; a note when ffprobe couldn't check it
 */
function checkRemux(source, part, cfg) {
  const before = streamDurations(cfg.ffprobe, source), after = streamDurations(cfg.ffprobe, part);
  const unchecked = [before, after].find(d => typeof d === 'string');
  if (unchecked) return { note: `; remux not checked: ${unchecked}` };
  for (const type of ['video', 'audio'])
    if (before[type] && after[type] !== null && after[type] < before[type] - Math.max(10, before[type] * 0.02))
      return { error: `${type} is ${Math.round(after[type])} s of ${Math.round(before[type])} s (damaged recording)`, note: '' };
  return { note: '' };
}

/**
 * Share (0-1) of scrambled packets in three samples of the recording (188-byte TS, or 192-byte with a timestamp prefix). 1 means
 * it was never descrambled (no B-CAS / ACAS card reader, or a channel you don't subscribe to), so no player can show it.
 * 0 when the file can't be read or isn't TS: this only decides whether a remux is worth trying.
 */
function scrambledShare(file) {
  let total = 0, scrambled = 0, fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, buf = Buffer.alloc(192 * 2000);
    for (const at of [0.1, 0.5, 0.9]) {
      const n = fs.readSync(fd, buf, 0, buf.length, Math.floor(size * at));
      let start = -1, step = 0; // find the packet grid: three sync bytes in a row
      for (let o = 0; o < 192 && start < 0; o++)
        for (const len of [188, 192]) if (buf[o] === 0x47 && buf[o + len] === 0x47 && buf[o + 2 * len] === 0x47) { start = o; step = len; break; }
      for (let i = start; start >= 0 && i + 4 <= n; i += step) {
        if (buf[i] !== 0x47) continue;
        const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
        if (pid < 0x100 || pid === 0x1fff) continue; // tables and null packets are never scrambled
        total++;
        if (buf[i + 3] >> 6) scrambled++;
      }
    }
  } catch (e) { return 0; } finally { if (fd !== undefined) fs.closeSync(fd); }
  return total ? scrambled / total : 0;
}

/**
 * Remux `source` to `dst` (MPEG-TS) via "<dst>.part", dropping packets the demuxer marks corrupt (reception errors), then check it.
 * A scrambled recording isn't remuxed at all.
 * @returns {{error?: string, note: string}} error when the remux failed or is incomplete; EEXIST is thrown
 */
function remux(source, dst, cfg) {
  if (scrambledShare(source) > 0.5) return { error: "the recording is scrambled (not descrambled), so it can't be played", note: '' };
  const part = dst + '.part';
  let error = runFfmpeg(cfg.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-fflags', '+discardcorrupt', ...PROBE_ARGS,
    '-i', source, ...cfg.remuxArgs, '-f', 'mpegts', '-y', part]) || (fs.existsSync(part) && fs.statSync(part).size > 0 ? undefined : 'ffmpeg wrote no output');
  let note = '';
  if (!error) ({ error, note } = checkRemux(source, part, cfg));
  if (!error) {
    try { publishPart(dst); return { note }; } catch (e) { fs.rmSync(part, { force: true }); throw e; }
  }
  fs.rmSync(part, { force: true });
  return { error, note };
}

/** Remux the video when enabled, else (or when that fails) link or copy it. */
function placeVideo(input, dst, cfg) {
  if (!cfg.remux) return { how: linkOrCopy(input, dst, cfg.link), note: '' };
  const { error, note } = remux(input, dst, cfg);
  if (!error) return { how: 'remuxed', note };
  return { how: linkOrCopy(input, dst, cfg.link), note: `; remux failed: ${error}` };
}

/** Caption sidecars: suffix, ffmpeg decoder/encoder arguments, clean-up. ASS keeps position and colour; SRT is plain text. */
const SUBTITLE = {
  ass: { suffix: '.ja.ass', decode: ['-c:s', 'libaribcaption', '-sub_type', 'ass'], encode: ['-c:s', 'ass', '-f', 'ass'], clean: cleanAss },
  srt: { suffix: '.ja.srt', decode: ['-c:s', 'libaribb24'], encode: ['-c:s', 'srt', '-f', 'srt'], clean: cleanSrt },
};

/** Drop empty "Dialogue:" events (ARIB clear-screen commands). */
function cleanAss(text) {
  return text.split(/\r?\n/).filter(line => !/^Dialogue:/.test(line) ||
    line.split(',').slice(9).join(',').replace(/\{[^}]*\}|\\[Nnh]/g, '').trim()).join('\n');
}

/** SRT as plain text: tags removed, empty cues dropped, cues renumbered. */
function cleanSrt(text) {
  const cues = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(cue => cue.trim().split('\n'))
    .map(([, time, ...lines]) => [time, lines.map(l => l.replace(/<[^>]*>/g, '').trim()).filter(Boolean)])
    .filter(([time, lines]) => /-->/.test(time) && lines.length);
  return cues.map(([time, lines], i) => `${i + 1}\n${time}\n${lines.join('\n')}\n`).join('\n');
}

/**
 * Extract the first caption stream in one format.
 * @returns {{ text?: string, error?: string }}
 */
function extractSubtitle(input, format, cfg) {
  const { decode, encode, clean } = SUBTITLE[format], out = path.join(os.tmpdir(), `epgXport-${process.pid}.${format}`);
  try {
    const error = runFfmpeg(cfg.subtitleFfmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...decode, '-i', input, '-map', '0:s:0', ...encode, '-y', out]);
    if (error) return { error };
    const text = clean(fs.readFileSync(out, 'utf8'));
    return /^Dialogue:|-->/m.test(text) ? { text } : { error: 'no captions' };
  } catch (e) { return { error: e.message }; } finally { fs.rmSync(out, { force: true }); }
}

/**
 * Place the caption files, never replacing one; captions are extracted only when a file is missing. On a new name an
 * existing file with other content is "kept" (the name is taken).
 * @returns {{ statuses: string[], created: string[] }}  statuses: "<suffix> written|exists|kept|skipped (<why>)"
 */
function placeSubtitles(formats, name, folderPath, get, ownName) {
  const statuses = [], created = [];
  for (const format of formats) {
    const { suffix } = SUBTITLE[format], file = path.join(folderPath, name + suffix);
    let status;
    if (fs.existsSync(file)) status = ownName || readIfExists(file) === get(format).text ? 'exists' : 'kept';
    else if (get(format).error) status = `skipped (${get(format).error})`;
    else {
      const part = path.join(folderPath, `.epgXport-${process.pid}${suffix}.part`);
      try {
        fs.writeFileSync(part, get(format).text);
        publishPart(file, part);
        status = 'written'; created.push(file);
      } catch (e) {
        fs.rmSync(part, { force: true });
        status = e.code === 'EEXIST' ? 'kept' : `skipped (${e.message})`;
      }
    }
    statuses.push(`${suffix} ${status}`);
  }
  return { statuses, created };
}

/** True when `file` is `source` (same inode) or a byte-identical copy. */
function sameContent(file, source) {
  try {
    const a = fs.statSync(file), b = fs.statSync(source);
    return a.ino === b.ino && a.dev === b.dev || a.size === b.size && fs.readFileSync(file).equals(fs.readFileSync(source));
  } catch (e) { return false; }
}

/**
 * Link or copy the thumbnail to each missing image path. An existing image is "exists" when it is this thumbnail, else
 * "kept" (another picture). A failed copy is only reported.
 * @returns {{ statuses: string[], created: string[] }}  statuses: 'linked'|'copied'|'exists'|'kept'|'failed: …'
 */
function placeImages(thumbnail, images, mode) {
  const statuses = [], created = [];
  for (const image of images) {
    if (thumbnail && !fs.existsSync(image)) {
      try { statuses.push(linkOrCopy(thumbnail, image, mode)); created.push(image); continue; } catch (e) {
        if (e.code !== 'EEXIST') { statuses.push(`failed: ${e.message}`); continue; }
      }
    }
    if (fs.existsSync(image)) statuses.push(thumbnail && sameContent(image, thumbnail) ? 'exists' : 'kept');
  }
  return { statuses, created };
}

/**
 * Put the recording at "<base>.ext" with its sidecars and NFO, never replacing another file; a taken name → "<base> (2)", ….
 * A name is this recording when the video is the same inode, or the NFO is identical and the video has the same size
 * (copied) or remux is on (remuxed); then only missing sidecars are added. Order: sidecars, NFO, video.
 * @returns {{ dst: string, how: string, note?: string, images: string[], subtitles: string[] }}
 */
function placeRecording(input, folderPath, base, ext, nfo, thumbnail, imageSuffixes, cfg) {
  const source = fs.statSync(input), extracted = {};
  const getSubtitle = format => extracted[format] || (extracted[format] = extractSubtitle(input, format, cfg));
  const sidecars = (name, imagePaths, ownName) => {
    const images = placeImages(thumbnail, imagePaths, cfg.link), subtitles = placeSubtitles(cfg.subtitles, name, folderPath, getSubtitle, ownName);
    return { images: images.statuses, subtitles: subtitles.statuses, created: [...images.created, ...subtitles.created] };
  };
  for (let n = 1; ; n++) {
    const name = base + (n > 1 ? ` (${n})` : '');
    const nfoPath = path.join(folderPath, name + '.nfo'), dst = path.join(folderPath, name + ext);
    const imagePaths = imageSuffixes.map(suffix => path.join(folderPath, name + suffix));
    const oldNfo = readIfExists(nfoPath), existing = fs.existsSync(dst) && fs.statSync(dst);
    if (existing && existing.ino === source.ino && existing.dev === source.dev) { // this recording, linked before
      if (oldNfo !== nfo) fs.writeFileSync(nfoPath, nfo);
      return { dst, how: 'exists', ...sidecars(name, imagePaths, true) };
    }
    if (existing) {
      if (oldNfo === nfo && (existing.size === source.size || cfg.remux)) return { dst, how: 'exists', ...sidecars(name, imagePaths, true) }; // copied or remuxed before
      continue;
    }
    if (oldNfo !== undefined && oldNfo !== nfo) continue; // the name belongs to another recording's NFO
    const placed = sidecars(name, imagePaths, false);
    const giveUp = () => placed.created.forEach(f => fs.rmSync(f, { force: true }));
    if ([...placed.images, ...placed.subtitles].some(status => /kept$/.test(status))) { giveUp(); continue; } // someone else's file at this name
    if (oldNfo === undefined) {
      try { fs.writeFileSync(nfoPath, nfo, { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') { giveUp(); continue; } throw e; }
    }
    try {
      return { dst, ...placeVideo(input, dst, cfg), images: placed.images, subtitles: placed.subtitles };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (oldNfo === undefined) fs.rmSync(nfoPath); // lost a race for the name
      giveUp();
    }
  }
}

// =====================================================================================================================
// 9. Configuration and main()
// =====================================================================================================================

/**
 * Settings: epgXport.json (or EPGXPORT_CONFIG), then environment overrides:
 *   library EPGXPORT_LIBRARY (required), tvDir EPGXPORT_TV_DIR ("TV"), movieDir EPGXPORT_MOVIE_DIR ("Movies"),
 *   logFile EPGXPORT_LOG_FILE, thumbnailDir EPGXPORT_THUMBNAIL_DIR ("../thumbnail"), thumbnailWait EPGXPORT_THUMBNAIL_WAIT (60),
 *   link EPGXPORT_LINK ("hardlink" | "copy"), remux EPGXPORT_REMUX (false), ffmpeg FFMPEG ("ffmpeg"), ffprobe FFPROBE ("ffprobe"), remuxArgs,
 *   subtitles EPGXPORT_SUBTITLES (false | "ass" | "srt" | "both"), subtitleFfmpeg EPGXPORT_SUBTITLE_FFMPEG.
 */
function loadConfig(env) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(env.EPGXPORT_CONFIG || path.join(__dirname, 'epgXport.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const cfg = { tvDir: 'TV', movieDir: 'Movies', thumbnailDir: path.join(__dirname, '..', 'thumbnail'), thumbnailWait: 60, link: 'hardlink', ...file };
  for (const [name, suffix] of [['library', 'LIBRARY'], ['tvDir', 'TV_DIR'], ['movieDir', 'MOVIE_DIR'], ['logFile', 'LOG_FILE'],
    ['thumbnailDir', 'THUMBNAIL_DIR'], ['thumbnailWait', 'THUMBNAIL_WAIT'], ['link', 'LINK']])
    if (env['EPGXPORT_' + suffix]) cfg[name] = env['EPGXPORT_' + suffix];
  if (env.EPGXPORT_REMUX) cfg.remux = env.EPGXPORT_REMUX;
  cfg.remux = /^(?:true|1|yes|on)$/i.test(String(cfg.remux));
  cfg.ffmpeg = env.FFMPEG || cfg.ffmpeg || 'ffmpeg';
  cfg.ffprobe = env.FFPROBE || cfg.ffprobe || 'ffprobe';
  cfg.remuxArgs = cfg.remuxArgs || REMUX_ARGS;
  if (!Array.isArray(cfg.remuxArgs) || !cfg.remuxArgs.every(a => typeof a === 'string')) throw new Error('remuxArgs must be an array of strings');
  if (env.EPGXPORT_SUBTITLES) cfg.subtitles = env.EPGXPORT_SUBTITLES;
  const subtitles = String(cfg.subtitles || 'false').toLowerCase();
  cfg.subtitles = new Map([['ass', ['ass']], ['srt', ['srt']], ['both', ['ass', 'srt']], ['false', []], ['off', []], ['none', []], ['0', []]]).get(subtitles);
  if (!cfg.subtitles) throw new Error(`subtitles must be false, "ass", "srt" or "both", not ${JSON.stringify(subtitles)}`);
  cfg.subtitleFfmpeg = env.EPGXPORT_SUBTITLE_FFMPEG || cfg.subtitleFfmpeg || cfg.ffmpeg;
  if (!['hardlink', 'copy'].includes(cfg.link)) throw new Error(`link must be "hardlink" or "copy", not ${JSON.stringify(cfg.link)}`);
  return cfg;
}

/** Run once for one recording, as EPGStation does (all input from the environment). */
function main(env = process.env) {
  const cfg = loadConfig(env);
  const input = env.INPUT;
  if (!input || !fs.existsSync(input)) throw new Error(`INPUT not set or missing: ${input}`);
  if (!cfg.library) throw new Error('library is not configured (env EPGXPORT_LIBRARY or "library" in epgXport.json)');

  const genres = [1, 2, 3].map(i => [env[`GENRE${i}`], env[`SUBGENRE${i}`]]).filter(([g]) => g !== undefined && g !== '').map(g => g.map(Number));
  const dir = path.basename((env.SUBDIR || env.DIR || '').trim()).normalize('NFKC');
  // A blank EPG name: the rule directory, else the channel, is the show.
  const parsed = norm(env.NAME) ? parse({ name: env.NAME, genres, dir }) : { kind: 'tv', show: dir || norm(env.CHANNELNAME) || '_', subtitle: '' };

  const start = +(env.START_AT || env.STARTAT) || fs.statSync(input).mtimeMs, endAt = +(env.END_AT || env.ENDAT) || start;
  const jst = new Date(start + 9 * 3600e3).toISOString(), date = jst.slice(0, 10), hhmm = jst.slice(11, 13) + jst.slice(14, 16);
  const rawName = norm(env.NAME), desc = env.DESCRIPTION || '', extendedText = env.EXTENDED || '';
  const { plot, people } = extended(desc, extendedText);
  const { showFields, flagTags } = genreFields(genres, norm(env.CHANNELNAME), rawName);
  /** Fields shared by episode and movie NFOs. */
  const nfoItem = (extraTags, plotSuffix) => [['outline', desc.trim()], ['plot', [plot, plotSuffix].filter(Boolean).join('\n\n')],
    ['runtime', Math.round((endAt - start) / 60000) || undefined], ...showFields, ...[...new Set([...extraTags, ...flagTags])].map(t => ['tag', t]), ...people];
  const ext = path.extname(input) || '.ts';

  // Wait for the thumbnail before writing anything (none without a RECORDEDID).
  const recordedId = String(env.RECORDEDID || '').trim(), wait = Math.max(0, +cfg.thumbnailWait || 0);
  let thumbnail, thumbLog = '';
  if (recordedId) {
    try { thumbnail = findThumbnail(cfg.thumbnailDir, recordedId, start, wait); } catch (e) { thumbLog = `; no thumbnail (${e.message})`; }
    if (!thumbnail && !thumbLog) thumbLog = `; no thumbnail ${recordedId}.jpg in ${cfg.thumbnailDir} after ${wait} s`;
  }

  const target = parsed.kind === 'movie'
    ? movieTarget({ cfg, parsed, desc, extendedText, nfoItem, rawName })
    : tvTarget({ cfg, parsed, dir, date, hhmm, ext, nfoItem, rawName, showFields });
  fs.mkdirSync(target.folderPath, { recursive: true });
  if (target.showNfo) { // written once, never overwritten
    try { fs.writeFileSync(path.join(target.folderPath, 'tvshow.nfo'), target.showNfo, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const { dst, how, note = '', images, subtitles } = placeRecording(input, target.folderPath, target.base, ext, target.nfo, thumbnail, THUMB_SUFFIXES[parsed.kind], cfg);
  if (thumbnail) thumbLog = `; thumbnail ${[...new Set(images)].join('+')} ${thumbnail}`;

  const line = `${new Date().toISOString()} ${how} ${input} -> ${dst}${note}${thumbLog}${subtitles.length ? `; subtitles ${subtitles.join(', ')}` : ''}\n`;
  process.stderr.write(line);
  if (cfg.logFile) fs.appendFileSync(cfg.logFile, line);
}

module.exports = { parse, norm, safe, trunc, extended };
if (require.main === module) try { main(); } catch (e) { process.stderr.write(`epgXport: ${e.message}\n`); process.exitCode = 1; }
