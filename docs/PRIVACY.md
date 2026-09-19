# Privacy

**Nothing you put into Trade Journal ever leaves your computer.**

That is not a promise about how carefully data is handled somewhere else. There
is no somewhere else: the app has no server, no account, no login, and makes no
network requests at all. It was checked — there is no `fetch`, no
`XMLHttpRequest`, no WebSocket, no analytics, no crash reporting, no telemetry,
and no third-party scripts or fonts.

## What is stored, and where

| What | Where |
| --- | --- |
| Screen recordings | Ordinary `.webm` files in the folder you choose in Settings |
| Trades, day notes, markers | The app's own local database on your machine |
| Settings and your setup list | Local storage on your machine |

In the desktop app the recordings folder defaults to
`Videos\Trade Journal` and you can point it anywhere — another drive, an
external disk, a synced folder if you want your own backup.

## What the recordings contain

Whatever was on the screen you chose to share. If your broker account, balance
or name was visible, it is in the file. The app never looks at the contents, but
you should treat the folder like any other folder of personal recordings —
especially before sharing a file or letting someone else use the machine.

Audio is never captured. The app requests video only.

## Deleting it

- A single session: open it and press **Delete**. The video file is removed too,
  not just the library entry.
- Everything: **Settings → Delete all data**. Trades, notes, markers, sessions,
  settings and every recording file in the folder.

Because nothing was ever sent anywhere, deleting locally is deletion. There is
no request to make of anyone and nothing to wait for.

## If you distribute this app

The above describes the app as written. If you add anything that talks to a
server — sync, accounts, a backup service, analytics — this document stops being
true and needs rewriting before you hand the app to anyone else.
