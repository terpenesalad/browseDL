The first release of browseDL: a browser you can log in to sites with, that finds the audio and video on every page and downloads it all through one organised queue.

**Download the file for your computer below:**

- Windows: `browseDL-windows-setup.exe` (installer) or `browseDL-windows-portable.exe` (no install)
- Mac (Apple silicon): `browseDL-macos-arm64.dmg`. Before the first launch, run `xattr -cr /Applications/browseDL.app` in Terminal, since the app isn't signed by Apple.
- Linux (x86-64): `browseDL-linux.AppImage`

### What it does

- **Built-in browser with tabs** that remembers your logins, so members-only, paid and age-restricted pages work.
- **Found panel** listing everything on the page you can save: whole playlists and channels on the 1,800+ sites yt-dlp supports, plus video, audio and HLS/DASH streams that play on any site, and links to media files. Tick what you want, pick a folder and a format, press Download.
- **Right-click to download** any video, audio or media link.
- **Download queue** with pause and resume (keeps partial downloads), stop, retry, download next, and Stop all. Up to six at once, and it carries on where it left off after a restart.
- **Library** of everything you've downloaded, grouped by site and folder, with search, video/audio filters, rename, move to folder and delete.
- **Organised folders**: site, then folder, by default; or site only, folder only, or flat, with optional separate Audio and Video folders.
- **No duplicates**: things already in your library aren't downloaded again.
- **Formats**: best video, 1080p, 720p, 480p, MP3, M4A, or original audio.
- **Update yt-dlp** from Settings when a site changes.

yt-dlp, ffmpeg and Deno are built in. Every build in this release was tested downloading a logged-in video, converting it to MP3, saving an HLS stream and joining a DASH stream's separate picture and sound before it was published.

DRM-protected streams (Netflix, Spotify and the like) can't be saved. Only download things you have the right to keep.
