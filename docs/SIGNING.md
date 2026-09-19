# Making SmartScreen stop

**There is no way to remove it from the code.** Not a build flag, not a
manifest, not a different installer format, not a zip. Windows shows
"Windows protected your PC" because the file is not signed with a certificate
from an authority Microsoft trusts — it is a statement about the certificate,
not about what the program does. Three things that do **not** work, so you do
not waste time on them:

- **A self-signed certificate.** Windows does not trust it, so the warning
  stays and the publisher still reads as unknown.
- **Shipping a .zip or a portable .exe instead.** The mark-of-the-web travels
  with the file; both still warn.
- **Waiting for reputation.** SmartScreen builds reputation per signing
  certificate. An unsigned file has nothing to attach reputation to.

What actually works, cheapest first.

## 1. Ask Microsoft to clear this file — free

Microsoft takes submissions of files wrongly flagged and will unblock them.
Free, and usually answered within a few days.

1. Go to <https://www.microsoft.com/en-us/wdsi/filesubmission>
2. Choose **Software developer**, then **Incorrectly detected as malware**
3. Upload `TradeJournal-Setup-1.0.0.exe` and say what it is — a personal
   trading journal that records the screen

**The catch:** it clears *that exact file*. Change one line of code and the
next build has a different hash and warns again. Fine if you build rarely,
useless if you build every day.

## 2. Azure Trusted Signing — about $10 a month

The cheapest real certificate, and the one to pick if you intend to keep
building. Microsoft signs on your behalf; no hardware token to look after.

1. Azure portal → create a **Trusted Signing** account
2. Verify your identity (individual accounts are allowed)
3. Add the credentials as repository secrets and every build signs itself —
   see below

Individual identity validation takes a few days.

## 3. An EV certificate — $400 or more a year

From DigiCert, Sectigo and others. Arrives on a hardware token. Clears
SmartScreen immediately with no reputation period. Only worth it if you are
selling this.

## 4. The Microsoft Store — $19 once

Store-installed apps never show SmartScreen, and Microsoft signs them. The
cost is certification: your app has to pass review, and a screen recorder
needs its privacy disclosures in order. Slow to set up, free forever after.

---

## Once you have a certificate

Nothing in this repository needs editing. Add two repository secrets under
**Settings → Secrets and variables → Actions**:

| Secret | What goes in it |
| --- | --- |
| `WINDOWS_CERT_BASE64` | Your `.pfx` file, base64 encoded |
| `WINDOWS_CERT_PASSWORD` | The password for that `.pfx` |

To encode the certificate:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard
```

Push anything and the next build is signed. The build log says which it did.

## In the meantime

For you, once per machine: **More info → Run anyway**, or right-click the file
→ **Properties** → tick **Unblock** → OK.

For anyone else you give it to, they will see the same screen and have to make
the same decision about whether they trust you. That is the real cost of not
signing, and it is why option 1 or 2 is worth doing before handing this to
other traders.
