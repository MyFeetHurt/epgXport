# epgXport

epgXport puts [EPGStation](https://github.com/l3tnun/EPGStation) recordings into a **Jellyfin, Emby, Kodi or Plex** library.
It runs as an EPGStation "encode" command, but it doesn't encode anything. Instead it:

- **hardlinks** the recording into your library, which takes no extra disk space and no time. If the library is on another filesystem it copies the file instead
  (or always copies, if you set `link` to `copy`). For Jellyfin 12 it can optionally **remux** the recording instead (see Jellyfin 12 playback).
- works out a clean **show name**, episode number and subtitle from the messy Japanese EPG title, for example
  `[新]アニメ　薬屋のひとりごと　＃４９「毒見役」[字]` → `薬屋のひとりごと`, episode 49, `毒見役`.
- can also save the broadcast **captions** as `.ja.ass` / `.ja.srt` subtitle files (optional, see Subtitles).
- writes **NFO files** (the Kodi format, which all four servers read) with all the EPG data: description, the full extended text, cast and staff,
  channel, genres, runtime and broadcast flags (新番組, 最終回, 再放送, 字幕…).
- links **EPGStation's own thumbnail** of each recording next to it, as the episode (or movie) image.

It is one file, `epgXport.js`, with no dependencies. It uses the Node.js that EPGStation already runs on (Node.js 14.14 or newer; tested on 18 and 24)
and makes **no online lookups**.
Your media server's own scrapers (TMDB, TVDB…) still fetch artwork and metadata for shows they can find. For shows they can't find, the NFO data is used.

## Library layout

```
<library>/TV/<Show>/tvshow.nfo
<library>/TV/<Show>/<Show> - 2026-09-30 2300 - <subtitle>.ts   (+ .nfo, -thumb.jpg and .jpg with the same name, and optional .ja.ass/.ja.srt)
<library>/Movies/<Title> (<Year>)/<Title> (<Year>).ts           (+ .nfo and -thumb.jpg)
<library>/Movies/<Title> (<Year>)/<Title> (<Year>) - 吹替版.ts   (a dubbed or subtitled broadcast: - 吹替版 / - 字幕版)
```

- TV episodes are named by **air date and time**, with no season folders and no `S01E05`. All four servers recognise date-named episodes, and date
  matching keeps working online. An episode number from the EPG title goes into the NFO only.
- Specials, digests, 総集編 and short versions (`5min.`, `ミニ`/`mini`, `1分版`, `PR`, `20周年PR`, `直前SP`, `スペシャル`, `傑作選`, `ダイジェスト`) go into the same show folder;
  the suffix moves to the subtitle (`さわやか自然百景5min.(36)奈良…` → `さわやか自然百景`, subtitle `5min.(36) 奈良…`). A number glued to
  the suffix is the short version's own count, so it stays in the subtitle and is not used as the episode number.
- When a new title starts with the name of an **existing** show folder, followed by a natural break (a space, `!`, `?`, `☆`, `“`, `~`, `▽`, `／`…), the
  recording goes into that folder and the rest becomes the subtitle: `徹子の部屋 クワバタオハラ` joins `徹子の部屋`. The existing name must be at
  least 5 characters long (not counting spaces and punctuation), or 4 with a kanji among them (`時論公論`), or 3 ending in
  `!`/`?` (`ZIP!`), so short generic folders such as `ニュース`, `ラグビー` or `まもなく` never take in other shows. It is not applied when the rule
  sets a directory (DIR). Folders are never renamed, so this only helps when the plain show name was recorded first.
- A programme whose EPG title is empty goes into a folder named after the channel.
- A programme is treated as a movie when its EPG genre is 映画 (or it has the `[映]` flag) and its title has no episode number. The year comes from the
  title or the EPG text (for example `（１９９９年　１２０分）`). When there's no year, the folder is just `<Title>`.
- A movie broadcast marked as dubbed (`吹替版`, `日本語吹替版`, `[吹]`) or subtitled (`字幕版`, `字幕スーパー`) gets ` - 吹替版` or ` - 字幕版` after
  the name, in the same folder: Jellyfin, Emby and Plex show the recordings as versions of one movie. `[字]` alone means closed captions and is not a version.
- Characters that are illegal in file names (`/ \ : * ? " < > |`) become their full-width forms, and names are kept under 255 bytes.
- Dates and times in file names and NFOs are always **Japan time (JST)**, whatever the server's time zone is. This is intentional.
- If the show folder name contains something Kodi would read as an episode number (`Type2`, `Stage1`, `S1E2`), the file names leave out the show name
  (`2026-09-30 2300 - 決勝.ts`), and a subtitle like that is left out of the file name too (it stays in the NFO). Otherwise Kodi would take it as the
  episode number instead of the date.
- epgXport never deletes or replaces a file in the library (thumbnails included). If the name is already taken by a different recording (for example the same programme
  recorded from two channels, or two films with the same title), the new one gets ` (2)`, ` (3)`… after the name. Running it again for the same
  recording changes nothing (it's recognised by being the same file, or, when it was copied or remuxed, by an identical NFO).

## Thumbnails

epgXport puts EPGStation's thumbnail for each recording next to it: `<name>-thumb.jpg` and `<name>.jpg` for TV episodes, `<name>-thumb.jpg` for
movies. They are links to (or copies of) EPGStation's own thumbnail, so they take almost no space. Jellyfin, Emby and Kodi use `-thumb.jpg`; Plex uses
`<name>.jpg`. Show posters and backgrounds still come from your server's online scraper, and you can add your own `poster.jpg` / `fanart.jpg` to a
show or movie folder. epgXport never overwrites them. (A movie gets no `<name>.jpg`, because Jellyfin and Plex would use it as the poster.)

- **Plex:** turn on *Use local assets* (library → Edit → Advanced) or the thumbnails are ignored.
- **Jellyfin:** local thumbnails always win over downloaded episode images and the Screen Grabber; nothing to configure. Jellyfin no longer runs
  ffmpeg on the recording to make an episode image, so episodes it can't probe (see Known limitations) now get a thumbnail too.
  If you turn on *Save artwork into media folders* and then change an episode image by hand, Jellyfin also overwrites EPGStation's copy of that
  thumbnail (they are the same file, a hardlink).
- **Emby:** works with the default settings. `-thumb.jpg` becomes the episode image, and a movie's *Thumb* image (its poster still comes from
  the online providers).
- **Kodi:** works with the default settings. A recording that was added to Kodi before its thumbnail existed keeps Kodi's own frame until you
  choose *Refresh* on it.
- The picture is the frame EPGStation grabs a few seconds into the recording (`thumbnailPosition` in EPGStation's config), so with
  recording margins it is sometimes the end of the previous programme or an ad. If no thumbnail exists, epgXport carries on without one and the
  server makes its own.

How it finds the file: EPGStation passes the recording's ID (`RECORDEDID`) and saves the thumbnail as `<thumbnail folder>/<ID>.jpg`
(or `<ID>(1).jpg`, `<ID>(2).jpg`… when that name was taken; the highest number written after the programme started is used). EPGStation makes the
thumbnail at the same moment it starts epgXport, so epgXport waits for it, up to `thumbnailWait` seconds (default 60), and goes on without
one if it doesn't appear. The images are placed before the NFO and the video, so the server sees them on its first scan. Running epgXport again
for a recording adds a thumbnail that was missing the first time. Runs without a `RECORDEDID` (started by hand) add no images.
If your EPGStation's `thumbnail` setting isn't the default `%ROOT%/thumbnail`, set `thumbnailDir` (see Configuration).

## Install

1. Copy `epgXport.js` into EPGStation's `config/` directory.
2. Create `config/epgXport.json` next to it:

   ```json
   { "library": "/path/to/media" }
   ```

   Use an **absolute** path (a relative one is taken relative to EPGStation's working directory). On Windows, write it as `"D:/Media"` or
   `"D:\\Media"` (backslashes must be doubled in JSON); NTFS hardlinks work.
   `TV` and `Movies` folders are created inside it. For hardlinks to work, the library must be on the **same filesystem and the same mount** as
   EPGStation's recording directory. If it isn't, the file is copied instead (a reflink copy on btrfs/XFS when possible, which takes no extra space).
   Each log line says `linked`, `copied` or `remuxed`, so check it after the first recording.
3. Add an encode entry to EPGStation's `config/config.yml`. It must have **no `suffix`** and **`rate: 1.0`**:

   ```yaml
   encode:
       - name: Library
         cmd: '%NODE% %ROOT%/config/epgXport.js'
         rate: 1.0
   ```

   With no `suffix`, EPGStation treats the entry as a plain command: it doesn't expect an output file and doesn't add a second video to the recording.
   `rate` sets the timeout as a multiple of the recording length. Linking takes well under a second, so 1.0 is plenty.
4. Restart EPGStation. Then choose the "Library" encode mode in the rules (or reservations) whose recordings should go to your media server.
   You can also run it from a recording's page to add something recorded earlier.

**Docker:** mount **one parent directory** that contains both the recordings and the library, at the same path in the container (for example
`/data:/data`, with EPGStation's `recorded` directory set to `/data/recorded` and `library` to `/data/media`). Linux can't hardlink across two different
mounts, even two bind mounts of the same disk (`EXDEV`), so with separate volumes for `recorded` and the library every recording is **copied**, doubling
the disk use. The same happens across btrfs subvolumes. `library` is always the path **inside** the container.

The entry shares EPGStation's encode queue (`concurrentEncodeNum`), so a recording waits behind any real encodes that are running. Keep
`concurrentEncodeNum` at its default of 1 if you can: with several runs at once, two recordings of one show that start together can, rarely, create
two folders whose names differ only in spacing.

### "Delete original after encode": read this before ticking it

If you tick EPGStation's "delete original after encode" option for this mode, EPGStation deletes its copy of the recording once epgXport has finished.
The hardlink in your library survives, so the video stays in Jellyfin, Emby, Kodi or Plex. But the recording then has **no video in EPGStation**, and if the
library is on a different filesystem (so the file was copied, not linked) you are left with only the library copy. Leave the option off unless you
want "move into library" behaviour.

## Configuration

Settings come from `epgXport.json` next to the script. Environment variables override it, and `EPGXPORT_CONFIG` points at a different config file.

To give a second encode entry its own config file (for example a second library), use `env`, with the **full path to node**:

```yaml
    - name: epgXport (2nd library)
      cmd: '/usr/bin/env EPGXPORT_CONFIG=%ROOT%/config/epgXport-2.json /usr/bin/node %ROOT%/config/epgXport.js'
      rate: 1.0
```

EPGStation replaces `%NODE%` only when it is the first word of the command, so `%NODE%` after `env` fails with exit code 127. Use the node that
EPGStation itself runs on (`which node` as the EPGStation user).

| JSON key | env var | default | meaning |
|---|---|---|---|
| `library` | `EPGXPORT_LIBRARY` | (required) | library root (absolute path) |
| `tvDir` | `EPGXPORT_TV_DIR` | `TV` | TV folder inside the library |
| `movieDir` | `EPGXPORT_MOVIE_DIR` | `Movies` | movie folder inside the library |
| `logFile` | `EPGXPORT_LOG_FILE` | none | append one line per recording here: time, `linked` / `copied` / `remuxed` / `exists`, recording → library file, and the thumbnail result |
| `thumbnailDir` | `EPGXPORT_THUMBNAIL_DIR` | `../thumbnail` from the script (`%ROOT%/thumbnail`) | EPGStation's thumbnail folder (its `thumbnail` setting, absolute path) |
| `thumbnailWait` | `EPGXPORT_THUMBNAIL_WAIT` | `60` | seconds to wait for EPGStation to finish the thumbnail; `0` = look once, don't wait |
| `link` | `EPGXPORT_LINK` | `hardlink` | `hardlink`: hardlink the recording and its thumbnail, copy when that is impossible. `copy`: always copy (a reflink copy on btrfs/XFS when possible) |
| `remux` | `EPGXPORT_REMUX` | `false` | `true`: remux the video with ffmpeg instead of linking it (see Jellyfin 12 playback) |
| `ffmpeg` | `FFMPEG` | `ffmpeg` | the ffmpeg used for `remux`. EPGStation sets `FFMPEG` to its own ffmpeg, so this is rarely needed |
| `ffprobe` | `FFPROBE` | `ffprobe` | the ffprobe that checks a remux. EPGStation sets `FFPROBE`, so this is rarely needed |
| `remuxArgs` | (none) | see below | advanced: the ffmpeg arguments that select and copy the streams |
| `subtitles` | `EPGXPORT_SUBTITLES` | `false` | `ass`, `srt` or `both`: also save the broadcast captions as subtitle files (see Subtitles) |
| `subtitleFfmpeg` | `EPGXPORT_SUBTITLE_FFMPEG` | the `ffmpeg` above | an ffmpeg with ARIB caption decoders, for `subtitles` |

With `link` set to `copy` the library never shares a file with EPGStation, so nothing the media server does to the library (for example
Jellyfin's *Save artwork into media folders*) can change EPGStation's recording or thumbnail. Each copy takes disk space, unless the filesystem
makes it a reflink.

The script exits with a non-zero code on error, so failures show up as failed encodes in EPGStation. It also writes the same line (or the error
message) to stderr, but EPGStation logs an encode command's stderr only at its **debug** log level, so set `logFile` if you want a record.

## Jellyfin 12 playback

Jellyfin 12 can't play most Japanese broadcast recordings (`.ts` / `.m2ts`): besides video and audio they carry ARIB caption and data
broadcasting streams, which Jellyfin 12 doesn't handle. Jellyfin 10 plays the same files fine, and so do Kodi and Plex.

Set `"remux": true` (or `EPGXPORT_REMUX=true`) to put a cleaned-up copy into the library instead of a hardlink. epgXport then runs

```
ffmpeg -hide_banner -nostdin -loglevel error -fflags +discardcorrupt -analyzeduration 10M -probesize 32M -i <recording> \
       -map 0:v:0 -map 0:a? -c copy -ignore_unknown -dn -sn -max_muxing_queue_size 1024 -f mpegts -y <library file>.part
```

checks the result with ffprobe, and renames it to the library file name. This is a **stream copy, not an encode**: the first video stream and every audio stream
(including a second language or dual-mono audio) are copied unchanged into a new MPEG-TS file with the same extension. Captions (字幕) and data
broadcasting are left out of the library file (turn on `subtitles` to keep the captions as subtitle files). EPGStation's own recording is not changed.

- It costs **a full copy of disk space** per recording (minus the dropped streams), and some CPU and disk I/O while ffmpeg copies the file
  (typically a minute or two for a long HD recording; there is no encoding). The encode entry's `rate: 1.0` timeout is plenty.
- ffmpeg is the one EPGStation uses (it passes `FFMPEG` to encode commands); set `ffmpeg` to use another one.
- Reception errors (dropped packets, e.g. in heavy rain on BS) leave broken audio frames in a recording. `-fflags +discardcorrupt` drops the
  packets ffmpeg recognises as broken, so recordings with a few errors still remux.
- After the remux, epgXport compares the video and audio durations of the new file with the recording (ffprobe, which EPGStation passes as
  `FFPROBE`). With heavy reception errors, ffmpeg can finish "successfully" but lose minutes of audio or video, so a stream that comes out
  more than 2% (at least 10 s) shorter counts as a failed remux. Without ffprobe the check is skipped and the log line says `remux not checked`.
- If the remux fails, the partial file is deleted and the original recording is linked (or copied) instead, so it still appears in the library.
  The log line then says `linked` (or `copied`) followed by `; remux failed: <reason>`: ffmpeg's last error lines, or for example
  `audio is 1000 s of 3608 s (damaged recording)`.
- A recording that was never descrambled (no B-CAS card reader, or a channel you don't subscribe to) can't be played by anything. epgXport
  recognises it by sampling the file, links it without running ffmpeg, and the reason says `the recording is scrambled`.
- Running epgXport again for a recording that is already in the library doesn't remux it again. A library file is recognised as this
  recording's when its NFO is identical to the one epgXport would write now (with `remux` off, the file must also be the same file or the same size).
- Turning `remux` on or off only affects new recordings.
- Advanced: `remuxArgs` (in `epgXport.json` only) replaces the part from `-map` to `1024`, for example
  `"remuxArgs": ["-map", "0:v:0", "-map", "0:a:0", "-c", "copy"]` to keep only the first audio stream. The input, `-f mpegts` and the output
  are always added by epgXport.

## Subtitles

Japanese broadcasts carry their captions (字幕) as ARIB caption streams inside the recording, which media servers can't show. With
`"subtitles": "ass"`, `"srt"` or `"both"` (or `EPGXPORT_SUBTITLES`), epgXport extracts the first caption stream into subtitle files next to
the video, which Jellyfin, Kodi and Plex pick up as Japanese subtitles:

```
<library>/TV/<Show>/<Show> - 2026-09-30 2300 - <subtitle>.ja.ass
<library>/TV/<Show>/<Show> - 2026-09-30 2300 - <subtitle>.ja.srt
```

- **ASS** keeps the broadcast's position and colours (made with ffmpeg's `libaribcaption` decoder). **SRT** is plain text (made with
  `libaribb24`), for players that don't render ASS. `both` writes both files.
- It needs an **ffmpeg built with libaribcaption and/or libaribb24**. Most distribution packages and jellyfin-ffmpeg don't include them; the
  static builds from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) include both. Check with
  `ffmpeg -hide_banner -decoders | grep arib`. Point `subtitleFfmpeg` at that ffmpeg if it isn't the one EPGStation uses.
- If the decoder is missing, the recording has no captions, or nothing is said, no file is written and the log line says why
  (`; subtitles .ja.srt skipped (…)`). The recording itself is always placed.
- ffmpeg reads the whole recording once per format, which takes a little time and disk I/O. Running epgXport again only adds subtitle files
  that are missing, and an existing file is never replaced.
- Combined with `remux`, which removes the caption stream from the library's video, this is the way to keep the captions.

## Fixing a show name: the rule's directory (DIR)

EPG titles are messy, and no set of rules gets every show right. If a show lands in the wrong folder, open its EPGStation rule and type the show
name you want into the encode mode's **directory** field. epgXport uses that (its last path component) as the TV folder name, and still reads the episode
number and subtitle from the EPG title. When the title starts with the directory name, the subtitle is whatever follows it
(directory `午後LIVE ニュースーン` on `午後ＬＩＶＥ　ニュースーン　午後４時台　　中国のＡＩドラマ制作の現場` gives `午後4時台 中国のAIドラマ制作の現場`). The directory is ignored for movies, so that one rule doesn't put all its movies into one folder.
Use a real show name: the directory of an epgXport rule is only a name for epgXport, so don't point it at a folder you use for anything else. A directory
that has no usable name left after cleaning (such as `.`) gives a folder named `_`.

You can also pin the online entry the media server should use by adding its ID to the directory:

```
大岡越前 {tmdb-158199}
```

Jellyfin, Plex and Kodi read `{tmdb-N}` / `{tvdb-N}` from the folder name, so the show matches exactly. epgXport keeps the ID in the folder name, removes it
from the NFO titles and episode filenames, and writes it to `tvshow.nfo` as `<uniqueid>`, which lets Kodi match that show online too.

Folders are matched **ignoring the ID** (and spacing/punctuation), so recordings of the same show from other rules or manual reservations, without
the ID, still go into `大岡越前 {tmdb-158199}`. The reverse also holds: if the show already has a folder without an ID, a recording from a rule with
an ID keeps using that folder, and epgXport never renames folders. To pin an existing show, rename its folder yourself (add ` {tmdb-N}`) and delete its
`tvshow.nfo`, which the next recording then writes again with the `<uniqueid>`. When both `Show` and `Show {tmdb-N}` exist, an exact name match wins,
otherwise the pinned folder is used.

## NFO contents

| file | contains |
|---|---|
| episode `.nfo` | title (subtitle, or show + date), show title, season 1, episode number when the EPG has one, air date, outline (EPG description), plot (description plus every extended section, such as 出演者 and 原作・脚本), runtime, channel as studio, ARIB genres and subgenres, flag tags, cast (`<actor>` with the EPG role), `<director>`, `<credits>`, and the raw EPG title as `<originaltitle>` |
| `tvshow.nfo` | title, channel, genres and tags. It has no plot, date, or cast, so the media server can fill those from its online source. It is written once and never overwritten, so your own edits are safe. |
| movie `.nfo` | title, year (from the EPG text only), outline, plot (with the raw EPG title at the end), runtime, channel, genres, tags (including the edition and version, e.g. 完全版, 吹替版), cast, director and credits. It has no release date, so the broadcast date is never taken for one. |

Cast and staff come from EPG labels such as 【出演】, 【声】, 【語り】, 【監督】 and 【脚本】 (also written `[出演]` on a line of its own),
`役名：名前` lines, `【役名役】名前`, `（役名）名前` and `肩書…名前` (the part before `…` becomes the role). Credit lines in the description
and in other sections are read too: `出演：菅原文太／安藤昇　監督：深作欣二`, `出演者：渡瀬恒彦、平田満 ほか`, `原作：…／脚本：…／監督：…`, and
`声の出演：高山みなみ(江戸川コナン)`, where the part in brackets becomes the role. Years, ages and book titles after a name are dropped
(`香山美子 1966年`, `東野圭吾『虚ろな十字架』（光文社文庫刊）`). Names are never split on `・` (as in `ロバート・レッドフォード`).
Because the names are the same across recordings, a media server can show everything with one actor: tap 菅原文太 on one film and
you see his other recorded films and series.

The ARIB genre 福祉 with the subgenres 手話, 文字(字幕) or 音声解説 marks an accessibility service, not the content, so it is written as the tag
手話, 字幕 or 解説放送 (like the `[字]`/`[解]` flags) and not as a genre. The other 福祉 subgenres (高齢者, 障害者…) stay genres.
The extraction is best-effort, and the full text is always in the plot as well.

## Upgrading

Replace `epgXport.js`; no restart is needed, because EPGStation starts the script fresh for every recording. Only new recordings get the new file names and NFOs.
Note that Jellyfin **keeps tags from an older NFO** even after "Replace all metadata": if a newer version writes different tags or genres, existing
items keep the old ones too. To clean them up, edit the items, or remove the library from Jellyfin and add it again.

## Uninstall

Remove the encode entry from `config.yml`, restart EPGStation, and delete `config/epgXport.js` and `config/epgXport.json`. The files in the library are
ordinary hardlinks (or copies, or remuxed copies): deleting them doesn't touch EPGStation's recordings, and keeping them doesn't either.

## Media server settings

### Jellyfin

TV library (content type **Shows**):
- Preferred metadata language **Japanese**, country **Japan**.
- Metadata readers: **Nfo** on. Metadata savers: **Nfo off**. This matters: with the saver on, Jellyfin rewrites the NFOs.
- Series metadata downloaders: **TheMovieDb** on. If you've installed the TheTVDB plugin, turn it on too.
- Episode metadata downloaders: TheTVDB (plugin) on, **TheMovieDb off** (or below TheTVDB). epgXport writes season 1 for every episode, and TMDB
  matches episodes only by season and episode number, so it would pick the wrong episodes for long-running shows.
- Episode image fetchers: **Screen Grabber** first, so a wrongly matched episode can't bring a wrong thumbnail. (Only used for recordings that have
  no EPGStation thumbnail; see Thumbnails.)
- Automatically refresh metadata from the internet: Never.
- **Automatically merge series that are spread across multiple folders**: on. When one show ends up in two folders (for example
  `歴史探偵` and `歴史探偵 英雄たちのカルテ`, see Known limitations), Jellyfin shows them as one series if they match the same show online.

How it behaves: Jellyfin reads our NFO first. The online providers then only fill fields the NFO left empty (artwork, series plot, cast photos).
If the show isn't found online, our NFO data is what you see. Jellyfin searches with the **folder name**. If it picks the wrong show, use
"Identify" on the show, or put a `{tmdb-N}` in the rule's directory (see above).

Movie library: Nfo reader on, Nfo saver off, TheMovieDb on, language Japanese/Japan.

**EPG data only (no online lookups at all):** turn off every metadata downloader and every image fetcher except Screen Grabber.
Turning them off doesn't remove what was already downloaded: Jellyfin keeps provider IDs, posters and extra cast even after
"Replace all metadata". To start clean, remove the library, restart Jellyfin, run a library scan (this purges the old items), then add
the library again. Re-adding it straight away brings the old entries back, because Jellyfin derives item IDs from the file paths.
Actors are separate: Jellyfin fetches their photos, birth dates and biographies from TMDb through its own server-wide setting, not the
library's. To stop that, disable TheMovieDb for the **Person** type (Dashboard → Metadata, or `MetadataOptions` in `system.xml`). Photos
already downloaded stay in `metadata/People` and come back as local images, so delete those too.

### Emby

Tested with Emby Server 4.10.1.
- Movie library (content type **Movies**) and TV library (**TV shows**), preferred metadata language **Japanese**, country **Japan**.
- Metadata readers: **Nfo** on (the default). Leave NFO saving off (also the default), or Emby rewrites the NFOs.
- The default metadata and image downloaders (TheMovieDb, TheTVDB, FanArt) are fine.

How it behaves: Emby reads our NFO and keeps it: title, year, plot, genres, tags, channel (as the studio), and our cast and staff. The online
providers fill only what the NFO left empty: posters, logos, backgrounds, provider IDs, and the cast when our NFO has none. Unlike Jellyfin, it
doesn't add TMDB keywords or a second cast list next to ours. Episodes get their number, plot, cast and tags from the episode NFO (unlike Plex).
Recordings that weren't remuxed were probed without errors in our tests; playback in Emby's apps hasn't been tested.

**EPG data only:** turn off every metadata downloader and every image fetcher except Image Capture. As in Jellyfin, this doesn't remove
data that was already downloaded (series names can even stay in English). Remove the library and add it again to start clean.
Actor photos and biographies come from the TheMovieDb plugin regardless of library settings; uninstall the TheMovieDb, TheTVDB, OMDb and
Fanart.tv plugins if you want none at all.

### Kodi

- TV source: content **TV shows**, scraper **The Movie Database Python**, language ja-JP, "Use local information" on (the default).
- Movie source: content **Movies**, TMDB movie scraper, "Movies are in separate folders that match the movie title" on.

The trade-off, plainly: Kodi treats a complete NFO as final and **doesn't search online** for that show during a normal scan. So you always get our EPG
data, and every recording shows up even when the show isn't on TMDB. You don't automatically get online artwork or series plots.
To get them for a particular show, choose **Refresh** on it and let Kodi ignore local information; it then scrapes that show online. Kodi can't do "online
when found, NFO otherwise" automatically unless the NFO carries an online ID. epgXport doesn't look IDs up, but if you pin one in the rule's directory
(see above) it goes into `tvshow.nfo`, and Kodi then matches that show online. ("Local information only" as the
scraper also works, but then that per-show online refresh isn't available.)

### Plex

- Needs **Plex Media Server 1.43.1 or newer**, which added the official **Plex NFO** agents. Older versions ignore the NFO files.
  If the "Plex NFO Movie" / "Plex NFO Series" agents don't appear in the library's agent list after an update or after claiming the
  server, restart Plex Media Server.
- For NFO data only, use the "Plex NFO Series" / "Plex NFO Movie" agents. For online data plus NFO, create a custom metadata agent with Plex's online
  agent as the primary and add Plex Local Media and Plex NFO, ordered Local Media → NFO → online. In older 1.43.x releases, shows that the online agent
  couldn't match stayed blank instead of falling back to the NFO. Plex staff said in mid-2026 that a fix was coming, but this hasn't been tested here.
  If unmatched shows stay blank for you, use the plain Plex NFO agents.
- Switching an existing library to the NFO agents keeps the posters and backgrounds the online agent already downloaded. To start clean,
  remove the library and add it again with the NFO agent.
- **Limitation:** Plex applies an episode NFO only when it can match the episode's season and number from the file name. Date-named episodes don't have
  those, so Plex shows the **show-level** NFO data and takes episode titles from the file name, but **not** the per-episode plot and cast.
  Adding `S01E05` to the file names would break date matching in Jellyfin, Kodi and Plex, so epgXport doesn't do it.
- Plex merges two date-named files from the **same day** in one show into a single episode with two versions. For a show that airs twice a day,
  use two rules with different directory names.
- Plex plays `.ts`/`.m2ts` directly and accepts episodes directly in the show folder, without season folders.
- For the episode thumbnails, turn on **Use local assets** (library → Edit → Advanced); with a custom agent keep Plex Local Media in it.

## Known limitations

- **Show names are a best guess.** The title cleaner gets about 95% of a test set of real EPG titles right. The rest need the rule's directory
  (see above). Common trouble: names with several space-separated words (`にっぽん縦断 こころ旅`), a show name hidden in brackets, or a number that
  might be a season or an episode.
- The rules were built from Kansai channels and checked against a week of Tokyo EPG. They're general rules, but other regions' channel-specific
  title formats may need a directory override more often.
- Every episode gets season 1 (there are no season folders). Season words (第2期, Season 5…) are removed from the folder name.
- Episode numbers come from the title only (`#12`, `第12話`…), never from the description.
- Cast and staff parsing is best-effort. Lists separated only by spaces stay one entry, but the full text is always in the plot.
- Folder names that differ only in spacing or punctuation are merged (`プロフェッショナル仕事の流儀` goes into `プロフェッショナル 仕事の流儀`).
- The only artwork written is EPGStation's thumbnail per recording (see Thumbnails); show and movie posters and backgrounds come from online sources.
- Plex: no per-episode NFO data for date-named episodes (see above).
- **Same-day repeats become one episode with versions (Jellyfin, Emby and Plex).** These servers read the air date from the `YYYY-MM-DD` in the file name
  and ignore the time and subtitle, so two recordings of one show on the same date (news that airs several times a day, 帯 programmes, a rerun on the
  day of broadcast) are merged into a single episode with two "versions". Nothing is lost: both files are in the folder and both can be played
  from the version picker. Every date format that Jellyfin can parse merges this way, and dropping the date would break Kodi's date matching. If it
  matters for a show, give the second slot its own rule with a different directory name (for example `ニュース 夜`).
- **Jellyfin 12 can't probe or play many EPG recordings.** Recordings that carry extra streams of an unknown type (ARIB captions, data
  broadcasting) fail Jellyfin's ffprobe step (`Nullable object must have a value` in `ProbeResultNormalizer.GetAspectRatio`), so those episodes
  get no media info and don't play. Turn on `remux` (see Jellyfin 12 playback), or record only the needed streams in Mirakurun/EPGStation.
  They do get a thumbnail: EPGStation's (see Thumbnails). Series and movie artwork from TMDB/TVDB is not affected.
- **Jellyfin's real-time monitoring can miss new recordings for several minutes.** Add a scheduled library scan (Dashboard → Scheduled Tasks → Scan
  Media Library, e.g. every 15 minutes), or set EPGStation's `encodingFinishCommand` to a command that calls Jellyfin's `POST /Library/Refresh` with an API key.
- **Online providers add to our lists.** Jellyfin keeps our title, plot, genres, air date, episode titles and cast, and fills only empty fields
  (series plot, premiere date, artwork, provider IDs). List fields are merged instead: a matched show gets TMDB's English keywords as extra tags
  (`police`, `mystery`…), extra studios (`tv asahi`, `NHK`…) and TMDB's series cast next to ours. A wrong automatic match can add a wrong cast
  entry; fix it with "Identify" or a pinned ID.

## Development

```sh
node --test
```

The tests need Node.js 18 or newer (the script itself runs on 14.14+).

`test/titles.test.js` runs the title cleaner against `test/fixtures/titles.tsv`, a set of real EPG titles with expected results. Rows tagged
`[confirmed-conflict]` are titles whose expected answers contradict each other, so no single rule can get all of them right. They're reported separately.
The run fails only if the pass rate on the other rows drops below 95%. `VERBOSE=1` lists every mismatch.
New fixture rows are expected to pass: the pass rate is only just above 95%, so a new failing row can fail the suite.
`test/e2e.test.js` runs the script as EPGStation would, against a temporary library (the temp directory must support hardlinks). The copy-fallback test
uses `/dev/shm` as a second filesystem and is skipped where that isn't available.

## License

MIT. See [LICENSE](LICENSE).
