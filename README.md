# Trade Journal · Session Recorder

Record one continuous screen capture for a whole trading session, drop timestamped
markers into it as things happen, and review each moment afterwards with the full
chart context around it.

Nothing is ever cut. Review is a seek, not a clip.

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run test:e2e   # real recordings in real Chromium
```

It must be **served**, not opened as a file. `getDisplayMedia` and
`navigator.storage.persist()` both require a secure context; `http://localhost`
qualifies, `file://` does not.

---

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

## The hotkey limitation, stated plainly

**Marking only works while this tab is focused.** While you are working inside
Tradovate this tab is not focused, so its `keydown` listener receives nothing.
This is the one genuine weakness of the approach, and there is no browser API
that fixes it — a page cannot listen for keys globally.

The in-page listener is implemented (`e` entry, `x` exit, `n` note, all
rebindable). The UI states the limitation rather than implying it works globally.

Making it global needs a different trigger, and both options drive the same entry
point, `window.tradeJournal.mark({ kind })`, which is already exposed:

| Option | Covers | Does not cover |
| --- | --- | --- |
| Browser extension (`commands` permission, background service worker) | Any tab focused | Other applications, including the Tradovate desktop app |
| Desktop wrapper (Electron / Tauri, OS-level global shortcut) | Everything, desktop app included | — |

The practical fallback, today: **scrub to the moment in review and mark there.**
Markers added that way are flagged `addedDuringReview` and sorted into place.

---

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
src/session-recorder.js capture + storage core (the module this was built on)
src/player.js           duration resolution and seeking for header-less webm
src/review.js           player, marker rail, marker editing, scrub-and-mark
src/app.js              recording UI, library, settings, the marking entry point
src/settings.js         persisted settings, capture presets, size estimates
tests/unit/             chunk ordering, marker offsets, recovery, quota
tests/e2e/              real recordings in real Chromium, verified by playback
```

## Tests

`npm test` — 41 unit tests over the four areas that can silently ruin a session:
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
