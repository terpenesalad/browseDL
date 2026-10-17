Download whole seasons, playlists and listing pages without opening each video, choose where each batch is saved, and no more downloads wrongly marked as failed.

**Download the file for your computer below:**

- Windows: `browseDL-windows-setup.exe` (installer) or `browseDL-windows-portable.exe` (no install)
- Mac (Apple silicon): `browseDL-macos-arm64.dmg`. Before the first launch, run `xattr -cr /Applications/browseDL.app` in Terminal, since the app isn't signed by Apple.
- Linux (x86-64): `browseDL-linux.AppImage`

### New: download from listing pages in bulk

On a page that links to lots of video pages (a season, search results, an artist page, a channel's home page), the Found panel now has **Linked … pages**: browseDL checks the page's links with yt-dlp and lists the ones that lead to videos, grouped by kind. Press **Tick all**, then **Download**. A linked page with several videos (a concert with several works, a playlist) is saved into its own folder with the works numbered in order.

### New: choose where each batch goes

**Save in**, next to Download (and in Add links), picks the folder for this batch: your default, a folder you've used recently, or **Choose a folder…**. Files are still organised by site and folder inside it.

### New: Digital Concert Hall

browseDL reads Digital Concert Hall's login token from its own browser and gives it to yt-dlp, so once you're logged in there in Browse:

- a concert page lists each work separately, ready to tick and download
- season, search and artist pages list their concerts under **Linked concert pages**

### Fixed: finished downloads shown as Failed

On Windows, videos whose titles have accents or curly quotes (like *Emmanuelle Haïm* or *“Resurrection Symphony”*) saved properly but were marked "The downloader stopped (code 0)". browseDL now gets the saved file's location from yt-dlp in a way that keeps every character, and looks in the folder before giving up. **Already have rows that say Failed?** Press **Retry** on them: browseDL recognises the files you already have and marks them done without downloading again.

Every build in this release passed its self-test on Windows, Mac and Linux: logged-in downloads, MP3 conversion, HLS and DASH streams, a long accented title in a long folder path, and a multi-work list saved into its own numbered folder.
