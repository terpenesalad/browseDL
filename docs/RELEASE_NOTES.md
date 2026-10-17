Fixes **Save in → Choose a folder…** doing nothing.

**Download the file for your computer below:**

- Windows: `browseDL-windows-setup.exe` (installer) or `browseDL-windows-portable.exe` (no install)
- Mac (Apple silicon): `browseDL-macos-arm64.dmg`. Before the first launch, run `xattr -cr /Applications/browseDL.app` in Terminal, since the app isn't signed by Apple.
- Linux (x86-64): `browseDL-linux.AppImage`

### Fixed

- Picking **Choose a folder…** in the Save in list (next to Download, and in Add links) now opens the folder picker. In 1.1.0 it quietly went back to the default folder instead. The folder you pick is selected for that batch and added to the list for next time.

Everything else is as in 1.1.0: bulk downloading from linked pages, Save in, Digital Concert Hall logins, and the fix for downloads wrongly shown as Failed.
