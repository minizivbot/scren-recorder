# Trade Journal

A trading journal with the session recorded underneath it.

Log what you took and why, and get your numbers back — win rate, expectancy,
profit factor, and which of your own setups actually pay. Underneath, one
continuous screen recording of the session with timestamped markers, so any
trade can be watched back with the setup forming rather than described from
memory.

Nothing is ever cut. Review is a seek, not a clip.

## Your data

**Nothing you put into this app leaves your computer.** No server, no account,
no network request of any kind — no analytics, no crash reporting, no
third-party scripts or fonts. Recordings are ordinary `.webm` files in a folder
you choose; trades and notes are in a local database on your machine.

Because nothing was ever sent anywhere, deleting locally *is* deletion:
**Settings → Delete all data** removes every recording file, trade, note and
setting, and there is no copy elsewhere to ask anyone to remove.

See [Privacy](docs/PRIVACY.md) and [Terms of use](docs/TERMS.md). Those describe
the app honestly; they are not legal advice, and if you hand this to other
people — especially for money — have a lawyer look at them first.

## Where the numbers come from

Every statistic is computed from **trades you enter by hand**, and from nothing
else. Nothing is inferred from the recording, from a marker, or from anything
typed into a marker — a video is not a queryable record of what you traded, and
a number derived from one would be a guess wearing a number's clothes.

A marker says *something happened here*. A trade says what it was worth. They
are separate records, and a trade may link to a session so you can jump to the
footage — that is the whole relationship between them.

With no trades logged, the dashboard says so. It never shows a zero, because an
unknown win rate and a 0% win rate look identical on screen and mean opposite
things. Results are self-reported: this is your journal, not a broker statement.

## What it does

- **Overview** — net R, win rate, expectancy, profit factor, average win and
  loss, max drawdown and current streak, over 7/30/90 days or all time. The
  record button sits right underneath.
- **Journal** — every day you traded or recorded, with its R, its rating, your
  notes, each trade, and a link straight to that day's footage.
- **Trades** — the full table, editable, plus a breakdown by your own setups so
  you can see which ones are worth taking. Tags with too few trades behind them
  say so rather than pretending to be evidence.
- **Recordings** — the session library and the review player.
- **After every session** — rate the day, then log the trades while you still
  remember why you took them. All of it skippable; a journal you cannot skip is
  a journal you stop opening.

## Run it as an app (recommended)

Download **TradeJournalRecorder.exe** and double-click it. No terminal, no
server to leave running, no browser tab to keep open, and nothing else to
install — global hotkeys are built in.

Where to get it:

- **GitHub → Actions tab** → newest "Build Windows app" run → **Artifacts** →
  `TradeJournalRecorder`. A fresh build is produced on every push.
- Or build it yourself on Windows: `npm install` then `npm run dist:win`.
  The .exe lands in `dist/`.

It is portable: it runs from wherever you put it and installs nothing.
Recordings live in the app's own storage, not in the folder.

The installer runs straight through — no options to pick. It installs for the
current user and opens the app when it finishes.

### "Windows protected your PC"

Click **More info**, then **Run anyway**. It only asks once per machine.

Windows shows this for any program not signed with a paid certificate,
whatever is inside it. It cannot be turned off from the code — no build flag,
no installer format, no zip. [docs/SIGNING.md](docs/SIGNING.md) lists what
actually works, including a **free** route: Microsoft will clear a specific
file if you submit it, usually within a few days.

The build signs itself automatically once a certificate exists — add two
repository secrets and nothing else changes.

### Or run it in a browser

The browser version is still fully supported and is what the test suite mostly
exercises. It needs a terminal and a helper for global hotkeys:

```
npm install        # only needed for tests
node scripts/serve.mjs
```

Then open http://localhost:5173 in Chrome or Edge. It must be **served**, not
opened as a file: `getDisplayMedia` and `navigator.storage.persist()` both
require a secure context, which `http://localhost` satisfies and `file://` does
not.

```
npm test           # unit tests
npm run test:e2e   # real recordings in real Chromium, plus the desktop app
npm run app        # run the desktop app from source
```

## Why it records continuously

"Click to start the trade, click to stop" loses the most valuable part of the
recording. By the time you press start, the setup has already formed and you
have already decided — you capture the outcome, not the decision.

So: one recording for the session, a keypress drops a marker, review seeks to it.

- Nothing can be missed by reacting too slowly; the moment was already recorded.
- The minutes before entry come for free, and that is the footage worth watching.
- Zero video processing. No clipping, no re-encoding, no ffmpeg, no lost data.
- You can always scrub back for more context.

Clicking a marker lands **90 seconds before it** by default, because the setup is
what is being reviewed. Configurable in Settings, and directly under the player
where the thought actually occurs.

## What it deliberately does not do

**No audio detection of fill chimes.** Not implemented and not offered. A chime is
a side effect of a UI notification, not an execution record: it carries one bit —
not symbol, price, quantity, direction, or even entry versus exit. It breaks if
you mute, play music, get a notification from another app, or change output
volume. `getDisplayMedia` often cannot capture the audio at all, and if you use
the Tradovate desktop app there is no browser audio stream to capture. A keypress
is an exact timestamp with zero inference. Capture is requested with
`audio: false` on purpose.

**No performance statistics.** A recording is not queryable — you cannot compute
win rate, profit factor, expectancy or net P&L from it, and this app never tries.
Marker details you type are labels for finding footage, not an accounting record.
The UI says "no trade data source connected" rather than showing a computed zero.

Every marker carries `externalTradeId` and `externalSource`, always null. That is
the seam where an authoritative trade record gets joined later. The join is not
built.

---

## Marking while you trade

Marking works while Tradovate has focus — **browser or desktop app** — through a
local bridge. The page's own key handler cannot do this: a page only receives
`keydown` while its tab is focused, and no browser API changes that. So the fix
lives outside the browser.

The recorder's own server is already running during a session, so anything on
your machine that can make an HTTP request drops a marker:

```
POST http://localhost:5173/bridge/mark
Content-Type: application/json

{"command":"mark","kind":"entry","direction":"long","symbol":"MNQ"}
```

The page subscribes to an event stream and marks when a command arrives.

### In the app: nothing to set up

The desktop app registers the shortcuts with Windows itself, through Electron's
`globalShortcut`. They work the moment the app is open, with no helper installed.

| Key | Does |
| --- | --- |
| `Ctrl+Alt+E` | Entry |
| `Ctrl+Alt+X` | Exit |
| `Ctrl+Alt+N` | Note |
| `Ctrl+Alt+L` | Entry, long |
| `Ctrl+Alt+S` | Entry, short |
| `Ctrl+Alt+Q` | Stop the session |

If another application already owns one of these, the app says so on screen
rather than leaving you to discover it mid-trade. Rebind in Settings.

### In a browser: one helper

The browser version cannot register an OS shortcut, so it needs something
outside the browser to post to the bridge. Install
[AutoHotkey v2](https://www.autohotkey.com) and double-click
`tools/trade-journal-hotkeys.ahk`. Same keys as above.

Anything that can send an HTTP request works just as well — a Stream Deck, a
macro keyboard, a foot pedal.

### What a hotkey cannot do

**Start a recording.** `getDisplayMedia` requires a real user gesture in the
page before the browser will hand over the screen, so beginning a session is
always a click in the tab. Stopping one remotely is fine, and is bound above.

### Failing loudly

A hotkey that silently does nothing is worse than no hotkey, because you find
out at review time that the marker was never recorded. So:

- The response reports how many tabs received the command. `"delivered":0` means
  the recorder tab is not open, and the script says so rather than flashing a
  confirmation.
- If a hotkey fires while nothing is recording, the page raises a banner instead
  of discarding it quietly.
- The page shows **Global hotkeys: ready** / **not connected**, so the state is
  visible before you need it rather than after.

### Keeping it to your machine

The server binds `127.0.0.1` only, so nothing off the machine can reach it.
Commands must be `POST` with `Content-Type: application/json`, which a web page
cannot send cross-origin without a preflight — and no CORS headers are returned
anywhere, so the preflight fails. Any request carrying an `Origin` header is
rejected outright. That closes the case where a site you happen to be visiting
quietly injects markers into your journal.

### Still a fallback

Any marker you miss can be added afterwards by scrubbing to the moment in review
and marking there.

## Storage

- Chunks are written to IndexedDB **as they arrive** (2s timeslice). A crash or
  an accidental refresh costs at most one timeslice, never the session.
- Each chunk stores an explicit sequence number and reassembly sorts by it.
  IndexedDB iteration order is not relied on — a WebM stream is only valid in
  sequence.
- `navigator.storage.persist()` is offered in Settings so the browser will not
  evict recordings under storage pressure.
- Quota exceeded **stops the recording** and says so. Silently failing to persist
  means recording into the void, which is worse than stopping. Everything written
  before the failure stays playable.
- Usage is shown in the header; deleting a session deletes its chunks, not just
  its row, and reports the bytes freed.

The header meter shows **what the recordings occupy**, summed from the session
rows, not `navigator.storage.estimate()`. Chrome does not lower its own usage
figure for a long time after an IndexedDB delete — measured flat for 12 seconds
after removing 255 KB, because compaction is deferred and the number is padded.
A meter built on that would tell you a deletion had done nothing. The browser's
estimate is still read (it governs eviction and the quota warning) and is shown
in the meter's tooltip.

### Sizing

Defaults: 1280×720, 10fps, 1.5 Mbps ≈ **1.3 GB for a two-hour session**.

Charts are near-static, so a low frame rate saves enormously; the bitrate must
stay high enough that chart text remains readable. All three are configurable.
**If size needs to come down, reduce bitrate before resolution** — a smaller
frame makes the text unreadable, which defeats the point of the recording.

---

## Browser support

| | |
| --- | --- |
| Chrome, Edge | Supported, the target |
| Firefox | Works; ignores `preferCurrentTab` |
| Safari | **Refused up front.** It has both APIs, so a feature-detect says yes, and then recording a display stream fails or produces an unplayable file. Better to say so than to fail oddly two hours in. |

Ending the capture from the browser's own "Stop sharing" bar finalizes the
session correctly — the video track's `ended` event is what drives it, since the
app's own UI is bypassed entirely in that case.

---

## A note on MediaRecorder's output

A webm from `MediaRecorder` has **no duration in its header and no cue index** —
the encoder is streaming and does not know where the file ends. Freshly loaded,
`video.duration` is `Infinity` and seeking is unreliable. Since the entire review
flow is "seek to a marker", this is handled in two places
(`src/player.js`):

1. On load, the player seeks far past the end once, which makes the browser scan
   the file and establish the real duration. Seeking behaves normally afterwards.
2. The timeline never depends on that anyway — the recorder stores a duration
   derived from the chunks on disk, which is correct even for an interrupted
   session that was never finalized.

---

## Layout

```
index.html              app shell
electron/main.js        desktop app: window, OS shortcuts, screen picker
electron/preload.cjs    the only channel between the page and the OS
src/desktop.js          screen picker UI and desktop wiring
src/session-recorder.js capture + storage core (the module this was built on)
src/bridge-client.js    subscribes to the local bridge for global hotkeys
scripts/bridge.mjs      the mark bridge: hotkey in, event stream out
tools/*.ahk             global hotkeys for Windows
src/player.js           duration resolution and seeking for header-less webm
src/review.js           player, marker rail, marker editing, scrub-and-mark
src/app.js              recording UI, library, settings, the marking entry point
src/settings.js         persisted settings, capture presets, size estimates
tests/unit/             chunk ordering, marker offsets, recovery, quota
tests/e2e/              real recordings in real Chromium, verified by playback
```

## Tests

`npm test` — 57 unit tests over the areas that can silently ruin a session:
chunk ordering on reassembly, marker offset accuracy, recovery of an interrupted
session, and quota-exceeded handling.

`npm run test:e2e` — records real sessions in real Chromium and plays them back.
A recorder that produces an unplayable file passes every unit test and is still
worthless, so the e2e suite checks the artefact three independent ways:

- **Chrome plays it**, seeks to markers, and the frame that lands is read back
  and checked against the timestamp burned into it at capture time.
- **An independent WebM parser** (`tests/e2e/webm.js`) walks the container and
  confirms it parses cleanly to the last byte. Out-of-order reassembly leaves all
  the bytes present and only breaks the structure, so this is what catches it.
- **ffmpeg decodes a VP8 recording** outside the browser entirely, and the frames
  are checked in Node — so the file is not merely readable by the browser that
  wrote it.

### Measured

From `npm run test:e2e`, on the synthetic capture described below:

- 16.4 MB written across 37 chunks while JS heap went **6.3 MB → 5.0 MB**.
  Chunks are not accumulating in the tab; a two-hour session is bounded by disk,
  not memory.
- Extrapolated two-hour size at that bitrate: **1.57 GB**, in line with the
  ~1.3 GB the defaults are chosen for.
- A session interrupted by a real page reload recovered with its markers intact
  and a duration within one 2 s timeslice of where it was cut, and the partial
  file parsed cleanly and played.

### What the tests cannot cover here, and why

Display capture cannot be started in the container these were developed in. This
was diagnosed, not assumed:

- The X11 screen capturer **initialises successfully** — it attaches an X shared
  memory segment, reports MIT-SHM v1.2 with pixmaps and XRandR v1.6, and selects
  source `screen:0:0`. Device launch then fails with video capture error 31, and
  `getDisplayMedia` rejects with `NotReadableError`.
- Tab capture (`--auto-accept-this-tab-capture` with `preferCurrentTab`), which
  goes through the compositor rather than the X11 capturer, fails identically.
- A **fake camera device launches fine** and records — so the video capture stack
  itself works here. It is display capture specifically that will not start.
- Tried and ruled out: headless and headful under Xvfb (with RANDR, DAMAGE,
  COMPOSITE and MIT-SHM), `--ozone-platform=x11`, every
  `--auto-select-desktop-capture-source` name, `--disable-features=MojoVideoCapture`,
  SwiftShader, and the sandbox/shm flags. Installing real Google Chrome is
  blocked by the network proxy.

So the suite substitutes **the capture source only**, two ways:

- Most specs use a canvas-backed stream, because they need frame CONTENT that can
  be verified against known timestamps.
- `real-capture-stack.spec.js` uses a fake camera device, so one test drives the
  app with a track that genuinely came out of Chrome's capture pipeline — real
  constraints, real settings, a real device-level `ended`.

Everything downstream is real in both cases: real MediaRecorder encoding, real
timeslice chunks, real IndexedDB, real reassembly, real playback.

**The one step never exercised here is the OS handing screen frames to the
browser.** Run it locally once, pick a real screen, and confirm the picture is
your charts. Nothing after that point is untested.
