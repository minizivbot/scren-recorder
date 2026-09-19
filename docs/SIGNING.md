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
3. Upload `TradeJournal-Setup.exe` and say what it is — a personal trading
   journal that records the screen

**The catch:** it clears *that exact file*. Change one line of code and the
next build has a different hash and warns again. Fine if you build rarely,
useless if you build every day.

## 2. Azure Trusted Signing — about $10 a month

The cheapest real certificate, and the one to pick if you intend to keep
building. Microsoft signs on your behalf; no hardware token to look after.

1. Azure portal → create a **Trusted Signing** account and a certificate
   profile
2. Verify your identity (individual accounts are allowed)
3. Create an app registration and give it the **Trusted Signing Certificate
   Profile Signer** role on that account
4. Add these five repository secrets:

| Secret | What goes in it |
| --- | --- |
| `AZURE_TENANT_ID` | Directory (tenant) ID of the app registration |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | A client secret for that app registration |
| `AZURE_CODE_SIGNING_NAME` | The Trusted Signing account name |
| `AZURE_CERT_PROFILE_NAME` | The certificate profile name |

Then add the endpoint to `build.win` in `package.json` — the one piece that
is not a secret, because it varies by region:

```json
"azureSignOptions": {
  "endpoint": "https://eus.codesigning.azure.net",
  "codeSigningAccountName": "your-account",
  "certificateProfileName": "your-profile"
}
```

Individual identity validation takes a few days. Run `npm run check:build`
after editing — it catches a mistyped key before a build wastes ten minutes
on it.

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

## Avoiding the screen without any of the above

Everything above removes the warning *for everyone*. This removes it for
whoever runs the install command, and costs nothing.

SmartScreen never looks inside the program. It reacts to the
**mark-of-the-web**, a tag that browsers attach to files they download.
`curl.exe` and `Invoke-WebRequest` do not attach it, so a file fetched with
either has nothing for SmartScreen to react to. The README's
[install commands](../README.md#installing-without-the-warning) do exactly
that, and check the file's SHA-512 against the hash in the build's own
`latest.yml` before running it.

Worth being precise about what that trade is, because it looks like skipping
a safety check and is not. The check being skipped is a reputation lookup on
a signing certificate. This build has no certificate, so the lookup can only
ever answer "unknown" — it never had an opinion about the contents. The hash
comparison that replaces it is the stronger of the two: reputation tells you
whether other people have run a file, a hash tells you the file is the one
the build produced, byte for byte.

What it does **not** do is vouch for the publisher. Someone you hand this to
still has to decide whether they trust you — the command just moves that
decision out of a dialog that calls your app unrecognised. If you are
distributing to strangers, sign it or use the Store.

## Clicking through it instead

The dialog hides the button you need. It shows only **Don't run**, and
**Run anyway** appears only after you click the small **More info** link under
the message. So: **More info → Run anyway**. Or, before opening the file:
right-click it → **Properties** → tick **Unblock** → **OK**.

**This is once per machine, not once per version.** The app updates itself,
and SmartScreen does not inspect updates that arrive that way — it checks
files that came down through a browser. So the warning is a one-time cost of
the first install, even though the app keeps changing.

For anyone else you give it to, they will see the same screen and have to make
the same decision about whether they trust you. That is the real cost of not
signing, and it is why option 1 or 2 is worth doing before handing this to
other traders.
