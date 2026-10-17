Fixes downloads showing as **Failed** even though the file saved fine.

**Download the file for your computer below:**

- Windows: `browseDL-windows-setup.exe` (installer) or `browseDL-windows-portable.exe` (no install)
- Mac (Apple silicon): `browseDL-macos-arm64.dmg`. Before the first launch, run `xattr -cr /Applications/browseDL.app` in Terminal, since the app isn't signed by Apple.
- Linux (x86-64): `browseDL-linux.AppImage`

### Fixed: "The downloader stopped (code 0)"

On Windows, videos whose titles have accents or curly quotes (like *Emmanuelle Haïm* or *“Resurrection Symphony”*) reached "Adding details", saved properly, and were then marked Failed. yt-dlp's message saying where it saved the file arrived garbled, so browseDL couldn't find it.

- yt-dlp now also writes the saved file's location to a small UTF-8 file, which keeps every character intact.
- If that still can't be found, browseDL looks in the download folder for the video before giving up, and if it really can't find it, the error says which folder to check.
- Every release build now downloads a file with a long title full of accents and curly quotes into a long folder name as part of its self-test.

**Already have rows that say Failed?** Update, then press **Retry** on them. browseDL recognises the files you already have and marks them done without downloading them again.
