# Offline Tamers12345 Archive

An Electron‐based desktop app that lets you browse Tamers12345's YouTube channel, DeviantArt, and Tumblr blogs **fully offline**, with built-in auto-updating and missing-video detection

---

## Features

- ### YouTube Archive  
  - Grid of video thumbnails, titles & dates  
  - Separate Videos and Live Streams views (mark stream entries in `data/videos.json` with `"isLiveStream": true`)
  - Search, sort (newest/oldest), and “favorite” videos  
  - In-player: video controls (size/volume/speed), description, and synced live-chat playback
  - Custom playlist dropdown (e.g. Holiday Special, SU Lore Arc 1, etc…)
  - Easily create and export your own playlist to share with friends
  - Filters for “Everything”, “Everything but MLP”, “Only MLP”, "Everything but Dandy's World", "Everything but MLP and Dandy's World", "Only Dandy's World" and "Only MLP and Dandy's World"
  - View the YouTube comments section under every video
  - Use the YouTube auto generated subtitles for every single video that has them
  - Create video clips and gifs directly from the video, or take a screenshot of the current frame
- ### YouTube Posts
  - View every single YouTube post from Tamers' channel including polls, images, video announcements, etc.
- ### DeviantArt Gallery  
  - View all of Tamers12345's artworks  
  - Background music with full playlist controls  
- ### Tumblr Snapshots (1 & 2)  
  - Offline-viewable HTML page Tumblr blogs with Prev/Next navigation  
- ### Auto-Updater  
  - Checks GitHub Releases for new versions  
  - Prompts to download and install with release notes
- ### Missing-Video Detection  
  - After each update, scans your chosen video folder for any newly added files in `videos.json`  
  - Offers to download just those missing videos from GitHub assets  

---

## Adding Live Streams

Use `generate_videos_json_with_livestream_detection.py` as the replacement for the original videos.json generator. It scans the same shared metadata folder for every upload and recognizes completed streams from yt-dlp's `was_live` and `live_status` fields. Stream entries receive `"isLiveStream": true`; all other entries remain normal videos. The generator creates a `videos.json.bak` backup before replacing an existing manifest.

Live-stream thumbnails, metadata, comments, chat, and subtitles use the same `thumbnails`, `metadata`, `comments`, `chat`, and `subtitles` folders as ordinary videos.

---

## Installation

1. **Download** the latest Windows installer (`*.exe`) from [Releases](https://github.com/Tamersfan/offline-tamers12345-archive/releases).  
2. **Run** the installer—choose your installation directory when prompted.  
3. **Launch** “Offline Tamers12345 Archive” from your Start Menu or desktop shortcut.  
4. On first run, **select** your chosen videos folder where you’ve downloaded (or will download) the archived videos.

---
