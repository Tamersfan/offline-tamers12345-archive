// === Storage Keys ===
const STORAGE_KEYS = {
  tagFilter: 'tagFilterValue',
  userPlaylists: 'userPlaylistsV1'
};

// === Global State ===
let chatFiles = new Set();
let showBadges = true;
let sortOrder = 'newest';
let tagFilter = localStorage.getItem(STORAGE_KEYS.tagFilter) || 'all';
let selectedPlaylist = 'all';
let rawVideoData = [];
let videoPath = "";
let favorites = new Set(JSON.parse(localStorage.getItem('favorites') || '[]'));
let subtitlesData = {};
let assRenderer = null;
let currentBlobUrl = null;
let subtitlesOctopusLoadPromise = null;
let subtitleLoadToken = 0;
let textSubtitleState = null;
let watchedVideos = new Set(JSON.parse(localStorage.getItem('watched') || '[]'));
let showWatched = true;
let progressInterval = null;
let lazyImageObserver = null;
let commentsLoadToken = 0;
let renderCurrentChatWindow = null;
let userPlaylists = loadUserPlaylists();

let altVideoURLs = {};

// --- YouTube playlist/queue state ---
let chatData = [];
let currentPlaylistVideos = [];
let currentPlaylistIndex = 0;
let originalPlaylistOrder = [];
let isPlaylistShuffled = false;
let isPlaylistReversed = false;
let originalQueueOrder = [];
let isQueueShuffled = false;
let isQueueReversed = false;
let currentVideoFilename = null;
let currentPlaybackFilename = null;
let currentAltVideo = null;
let postsTabInitialized = false;
let postsDataCache = [];
let postOverrides = null;
const POSTS_CHANNELS = Object.freeze([
  Object.freeze({
    id: 'UCEvOnTvFBnDxR0e11qJuP7g',
    label: 'Tamers12345mlp',
    domKey: 'tamers12345mlp',
    tabId: 'youtube-posts-tamers12345mlp-tab',
    panelId: 'youtube-posts-tamers12345mlp-panel',
    feedId: 'youtube-posts-tamers12345mlp-feed'
  }),
  Object.freeze({
    id: 'UCaU7caX6HLTF3jUTHIY4Alw',
    label: 'TamersDandysWorld',
    domKey: 'tamersdandysworld',
    tabId: 'youtube-posts-tamersdandysworld-tab',
    panelId: 'youtube-posts-tamersdandysworld-panel',
    feedId: 'youtube-posts-tamersdandysworld-feed'
  })
]);
let activePostsChannelId = POSTS_CHANNELS[0].id;
const POSTS_PROFILE_PICS = [...Array(36)].map((_, i) => `PFPs/pfp${i + 1}.png`);
const TAMERS_PRIMARY_PFP = 'PFPs/tamers.png';
const TAMERS_DANDYS_WORLD_PFP = 'PFPs/tamers2.jpg';
const POSTS_UPLOADER_NAMES = new Set([
  'tamersdandysworld',
  'tamers official',
  'tamers12345mlp',
  'tamers12345official',
  'tamers12345'
]);
const LAZY_IMAGE_PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="9" viewBox="0 0 16 9"%3E%3Crect width="16" height="9" fill="%23222"/%3E%3C/svg%3E';
const USER_PLAYLIST_PREFIX = 'user:';
const USER_PLAYLIST_FILE_FORMAT = 'offline-tamers12345-archive-playlist';

function createUserPlaylistId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `pl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeUserPlaylist(playlist) {
  const id = String(playlist?.id || createUserPlaylistId());
  const name = String(playlist?.name || 'Untitled Playlist').trim() || 'Untitled Playlist';
  const seen = new Set();
  const videoFilenames = [];
  const sourceVideos = Array.isArray(playlist?.videoFilenames)
    ? playlist.videoFilenames
    : Array.isArray(playlist?.videos)
      ? playlist.videos.map(v => typeof v === 'string' ? v : v?.filename)
      : [];

  sourceVideos.forEach(filename => {
    const clean = String(filename || '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      videoFilenames.push(clean);
    }
  });

  return {
    id,
    name,
    videoFilenames,
    createdAt: playlist?.createdAt || new Date().toISOString(),
    updatedAt: playlist?.updatedAt || new Date().toISOString()
  };
}

function loadUserPlaylists() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.userPlaylists) || '[]');
    return Array.isArray(parsed) ? parsed.map(normalizeUserPlaylist) : [];
  } catch (e) {
    console.warn('Could not load user playlists:', e);
    return [];
  }
}

function saveUserPlaylists() {
  localStorage.setItem(STORAGE_KEYS.userPlaylists, JSON.stringify(userPlaylists));
  const savePromise = window.electronAPI?.saveUserPlaylists?.(userPlaylists);
  if (savePromise?.catch) {
    savePromise.catch(e => console.warn('Could not save user playlists to app data:', e));
  }
}

async function hydrateUserPlaylistsFromDisk() {
  if (!window.electronAPI?.getUserPlaylists) return;

  try {
    const result = await window.electronAPI.getUserPlaylists();
    const diskPlaylists = Array.isArray(result?.playlists)
      ? result.playlists.map(normalizeUserPlaylist)
      : [];

    if (result?.exists) {
      userPlaylists = diskPlaylists;
      localStorage.setItem(STORAGE_KEYS.userPlaylists, JSON.stringify(userPlaylists));
      return;
    }

    if (userPlaylists.length) {
      await window.electronAPI.saveUserPlaylists(userPlaylists);
    }
  } catch (e) {
    console.warn('Could not load user playlists from app data:', e);
  }
}

function getUserPlaylistSelectValue(playlist) {
  return `${USER_PLAYLIST_PREFIX}${playlist.id}`;
}

function isUserPlaylistValue(value) {
  return String(value || '').startsWith(USER_PLAYLIST_PREFIX);
}

function getUserPlaylistFromValue(value) {
  if (!isUserPlaylistValue(value)) return null;
  const id = String(value).slice(USER_PLAYLIST_PREFIX.length);
  return userPlaylists.find(playlist => playlist.id === id) || null;
}

function getVideoByFilename(filename) {
  return rawVideoData.find(video => video.filename === filename) || null;
}

function getVideoFilenameBase(filename) {
  return String(filename || '').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
}

function getVideoPlaybackCandidates(video) {
  const filename = typeof video === 'string' ? video : video?.filename;
  const base = getVideoFilenameBase(filename);
  const candidates = [
    filename,
    ...(Array.isArray(video?.previousFilenames) ? video.previousFilenames : []),
    base ? `${base}.mp4` : '',
    base ? `${base}.webm` : ''
  ];
  const seen = new Set();
  return candidates
    .map(candidate => String(candidate || '').trim())
    .filter(candidate => {
      if (!candidate || seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
}

async function resolveAvailableVideoFilename(video) {
  const fallback = typeof video === 'string' ? video : video?.filename;
  if (!videoPath) return fallback || '';

  for (const candidate of getVideoPlaybackCandidates(video)) {
    if (await fileExistsInVideoFolder(candidate)) return candidate;
  }

  return fallback || '';
}

function getCurrentPlaybackFilename() {
  return currentPlaybackFilename || currentVideoFilename;
}

function buildCurrentVideoFilenameByBase() {
  const byBase = new Map();
  rawVideoData.forEach(video => {
    const key = getVideoFilenameBase(video.filename).toLowerCase();
    if (key && !byBase.has(key)) byBase.set(key, video.filename);
  });
  return byBase;
}

function remapVideoFilenameToCurrent(filename, byBase = buildCurrentVideoFilenameByBase()) {
  const clean = String(filename || '').trim();
  if (!clean) return '';
  if (rawVideoData.some(video => video.filename === clean)) return clean;
  return byBase.get(getVideoFilenameBase(clean).toLowerCase()) || clean;
}

function migrateStoredVideoFilenameReferences() {
  if (!Array.isArray(rawVideoData) || !rawVideoData.length) return;

  const byBase = buildCurrentVideoFilenameByBase();
  const migrateList = list => {
    const seen = new Set();
    const migrated = [];
    (Array.isArray(list) ? list : []).forEach(filename => {
      const next = remapVideoFilenameToCurrent(filename, byBase);
      if (next && !seen.has(next)) {
        seen.add(next);
        migrated.push(next);
      }
    });
    return migrated;
  };

  const queue = loadQueue();
  const migratedQueue = migrateList(queue);
  if (JSON.stringify(queue) !== JSON.stringify(migratedQueue)) {
    saveQueue(migratedQueue);
  }

  let playlistsChanged = false;
  userPlaylists = userPlaylists.map(playlist => {
    const migrated = migrateList(playlist.videoFilenames);
    if (JSON.stringify(playlist.videoFilenames) === JSON.stringify(migrated)) return playlist;
    playlistsChanged = true;
    return { ...playlist, videoFilenames: migrated, updatedAt: new Date().toISOString() };
  });
  if (playlistsChanged) saveUserPlaylists();
}

function getUserPlaylistVideos(playlist) {
  if (!playlist) return [];
  return playlist.videoFilenames
    .map(getVideoByFilename)
    .filter(Boolean);
}

function getVideosForPlaylistSelection(value) {
  if (value === 'all') return rawVideoData.slice();
  const userPlaylist = getUserPlaylistFromValue(value);
  if (userPlaylist) return getUserPlaylistVideos(userPlaylist);
  return rawVideoData.filter(v => Array.isArray(v.tags) && v.tags.includes(value));
}

function makeUniquePlaylistName(name) {
  const base = String(name || 'Imported Playlist').trim() || 'Imported Playlist';
  const existing = new Set(userPlaylists.map(p => p.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;

  let suffix = 2;
  while (existing.has(`${base} (${suffix})`.toLowerCase())) suffix += 1;
  return `${base} (${suffix})`;
}

function getSafePlaylistFileName(name) {
  const safe = String(name || 'playlist')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${safe || 'playlist'}.playlist`;
}

function revealLazyImage(img) {
  if (!img || !img.dataset.src) return;
  img.src = img.dataset.src;
  delete img.dataset.src;
  img.classList.remove('lazy-media');
  if (lazyImageObserver) lazyImageObserver.unobserve(img);
}

function getLazyImageObserver() {
  if (lazyImageObserver || !('IntersectionObserver' in window)) return lazyImageObserver;
  lazyImageObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) revealLazyImage(entry.target);
    });
  }, { rootMargin: '240px 0px' });
  return lazyImageObserver;
}

function lazyLoadImage(img, src) {
  if (!img || !src) return;
  img.dataset.src = src;
  img.src = LAZY_IMAGE_PLACEHOLDER;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.classList.add('lazy-media');

  const observer = getLazyImageObserver();
  if (observer) {
    observer.observe(img);
  } else {
    revealLazyImage(img);
  }
}

function unobserveLazyImages(container) {
  if (!lazyImageObserver || !container) return;
  container.querySelectorAll('img[data-src]').forEach(img => lazyImageObserver.unobserve(img));
}

function loadVisibleLazyImages(container = document) {
  container.querySelectorAll('img[data-src]').forEach(img => {
    if (isElementInViewport(img, 240)) revealLazyImage(img);
  });
}

function ensureSubtitlesOctopusLoaded() {
  if (window.SubtitlesOctopus) return Promise.resolve();
  if (subtitlesOctopusLoadPromise) return subtitlesOctopusLoadPromise;

  subtitlesOctopusLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'libs/libass/subtitles-octopus.js';
    script.onload = () => resolve();
    script.onerror = () => {
      subtitlesOctopusLoadPromise = null;
      reject(new Error('Failed to load ASS subtitle renderer.'));
    };
    document.head.appendChild(script);
  });

  return subtitlesOctopusLoadPromise;
}

function syncTagFilterUIFromState() {
  const sel = document.getElementById('tagFilter');
  if (!sel) return;

  const hasOption = Array.from(sel.options).some(o => o.value === tagFilter);
  if (hasOption) {
    sel.value = tagFilter;
  } else {
    tagFilter = 'all';
    sel.value = 'all';
    localStorage.setItem(STORAGE_KEYS.tagFilter, 'all');
  }
}

// === YouTube Tab Initialization Flag ===
let youtubeTabInitialized = false;

// === Mini Preview Functions ===
function isElementInViewport(el, margin = 80) {
  const rect = el.getBoundingClientRect();
  return rect.bottom >= -margin &&
    rect.right >= -margin &&
    rect.top <= window.innerHeight + margin &&
    rect.left <= window.innerWidth + margin;
}

function stopThumbnailPreview(thumb) {
  if (thumb._previewTimer) {
    clearTimeout(thumb._previewTimer);
    thumb._previewTimer = null;
  }
  if (thumb._previewVideo) {
    thumb._previewVideo.pause();
    thumb._previewVideo.remove();
    thumb._previewVideo = null;
  }

  const img = thumb.querySelector('.thumbnail-container img');
  if (img) img.style.opacity = 1;
}

function setupThumbnailPreviews(container = document) {
  container.querySelectorAll('.video-thumbnail').forEach(thumb => {
    if (thumb._previewBound) return;
    thumb._previewBound = true;

    const container = thumb.querySelector('.thumbnail-container');
    if (!container) return;
    const img = container.querySelector('img');
    const filename = (thumb.dataset.filename || "").trim() || getFilenameFromThumb(thumb);
    if (!img || !filename) return;

    thumb.addEventListener('mouseenter', () => {
      if (thumb._previewVideo || thumb._previewTimer || !isElementInViewport(thumb)) return;

      thumb._previewTimer = setTimeout(async () => {
        thumb._previewTimer = null;
        if (!thumb.matches(':hover') || !isElementInViewport(thumb)) return;
        const videoEntry = getVideoByFilename(filename) || rawVideoData.find(video => getVideoFilenameBase(video.filename) === getVideoFilenameBase(filename));
        const previewFilename = await resolveAvailableVideoFilename(videoEntry || filename);
        if (!thumb.matches(':hover') || !isElementInViewport(thumb)) return;

        const previewVideo = document.createElement('video');
        thumb._previewVideo = previewVideo;
        previewVideo.className = 'thumbnail-preview-video';
        previewVideo.muted = true;
        previewVideo.playsInline = true;
        previewVideo.loop = false;
        previewVideo.preload = 'metadata';
        previewVideo.src = "file://" + videoPath + "/" + previewFilename;
        previewVideo.style.display = 'none';

        previewVideo.addEventListener('loadedmetadata', () => {
          if (thumb._previewVideo !== previewVideo) return;
        // If longer than 30s, start at 15; else start at 0
        const start = previewVideo.duration > 30 ? 15 : 0;
        // End the preview after 15s or at the end of the video
        const loopEnd = Math.min(start + 15, previewVideo.duration);

        previewVideo.currentTime = start;
        previewVideo.style.display = 'block';
        img.style.opacity = 0.15;
        previewVideo.play();

        previewVideo.ontimeupdate = () => {
          if (previewVideo.currentTime >= loopEnd || previewVideo.ended) {
            previewVideo.currentTime = start;
            previewVideo.play();
          }
        };
        });

        previewVideo.addEventListener('error', () => stopThumbnailPreview(thumb), { once: true });
        container.appendChild(previewVideo);
      }, 150);
    });

    thumb.addEventListener('mouseleave', () => {
      stopThumbnailPreview(thumb);
    });
  });
}



// Helper for thumbnails: fallback if data-filename is missing
function getFilenameFromThumb(thumb) {
  const img = thumb.querySelector('img');
  if (!img) return "";
  const rawSrc = img.src.split('/').pop();
  let src = rawSrc;
  try { src = decodeURIComponent(rawSrc); } catch {}
  const base = src.replace(/\.(png|jpg|jpeg|webp)$/i, "");
  const video = rawVideoData.find(item => getVideoFilenameBase(item.filename) === base);
  return video?.filename || `${base}.mp4`;
}


// === Time helpers (GIF and Clip) ===
function parseHMS(hms) {
  if (typeof hms !== "string") return 0;
  let parts = hms.split(":").map(Number);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}
function formatHMS(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = Math.floor(sec%60);
  return h > 0
    ? [h,m,s].map(v=>v.toString().padStart(2,"0")).join(":")
    : [m,s].map(v=>v.toString().padStart(2,"0")).join(":");
}

// === CLIP MAKER LOGIC ===
const clipBtn = document.getElementById('clip-btn');
const clipExportContainer = document.getElementById('clip-export-container');
const clipStartTime = document.getElementById('clip-start-time');
const clipEndTime = document.getElementById('clip-end-time');
const clipUseCurrentStart = document.getElementById('clip-use-current-start');
const clipUseCurrentEnd = document.getElementById('clip-use-current-end');
const clipPreviewBtn = document.getElementById('clip-preview-btn');
const clipStopPreviewBtn = document.getElementById('clip-stop-preview-btn');
const clipExportMP4Btn = document.getElementById('clip-export-mp4-btn');
const clipExportWebMBtn = document.getElementById('clip-export-webm-btn');
const clipExportStatus = document.getElementById('clip-export-status');

let clipPreviewing = false;
let clipStart = 0, clipEnd = 5; // seconds

clipBtn.addEventListener('click', () => {
  // Hide GIF panel when opening Clip Maker, and vice versa
  document.getElementById('gif-export-container').style.display = 'none';
  if (clipExportContainer.style.display === 'block') {
    clipExportContainer.style.display = 'none';
    clipExportMP4Btn.disabled = true;
    clipExportWebMBtn.disabled = true;
    clipExportStatus.textContent = "";
  } else {
    clipExportContainer.style.display = 'block';
    updateClipBtns();
    clipExportStatus.textContent = "";
  }
});

clipUseCurrentStart.addEventListener('click', () => {
  const player = window.player;
  clipStartTime.value = formatHMS(player.currentTime);
  updateClipBtns();
});
clipUseCurrentEnd.addEventListener('click', () => {
  const player = window.player;
  clipEndTime.value = formatHMS(player.currentTime);
  updateClipBtns();
});

function updateClipBtns() {
  let s = parseHMS(clipStartTime.value);
  let e = parseHMS(clipEndTime.value);
  let valid = (e > s && s >= 0 && e <= player.duration);
  clipExportMP4Btn.disabled = clipExportWebMBtn.disabled = !valid;
}

clipStartTime.addEventListener('input', updateClipBtns);
clipEndTime.addEventListener('input', updateClipBtns);

// Preview selected segment in main player
clipPreviewBtn.addEventListener('click', () => {
  const player = window.player;
  clipStart = parseHMS(clipStartTime.value);
  clipEnd = parseHMS(clipEndTime.value);
  if (clipEnd <= clipStart) return;
  player.currentTime = clipStart;
  player.play();
  clipPreviewing = true;
  clipStopPreviewBtn.style.display = '';
  clipPreviewBtn.disabled = true;
  player.addEventListener('timeupdate', stopClipPreviewIfNeeded);
});
clipStopPreviewBtn.addEventListener('click', stopClipPreview);


function stopClipPreviewIfNeeded() {
  const player = window.player;
  if (clipPreviewing && player.currentTime >= clipEnd) {
    stopClipPreview();
  }
}
function stopClipPreview() {
  const player = window.player;
  player.pause();
  clipPreviewing = false;
  clipStopPreviewBtn.style.display = 'none';
  clipPreviewBtn.disabled = false;
  player.removeEventListener('timeupdate', stopClipPreviewIfNeeded);
}

//=== Export with Save Dialog ===
clipExportMP4Btn.addEventListener('click', async () => {
  clipExportMP4Btn.disabled = true;
  await exportClip('mp4');
  clipExportMP4Btn.disabled = false;
});
clipExportWebMBtn.addEventListener('click', async () => {
  clipExportWebMBtn.disabled = true;
  await exportClip('webm');
  clipExportWebMBtn.disabled = false;
});

async function exportClip(format) {
  clipExportStatus.textContent = 'Exporting...';
  let s = parseHMS(clipStartTime.value);
  let e = parseHMS(clipEndTime.value);
  let duration = e - s;
  const playbackFilename = getCurrentPlaybackFilename();
  if (!playbackFilename) {
    clipExportStatus.textContent = "No video loaded!";
    return;
  }
  let file = videoPath + '/' + playbackFilename;
  let defaultExt = (format === 'mp4') ? 'mp4' : 'webm';
  let defaultBase = currentVideoFilename.replace(/\.\w+$/, '');
  let defaultFileName = `${defaultBase}_${clipStartTime.value.replace(/:/g,'-')}-${clipEndTime.value.replace(/:/g,'-')}.${defaultExt}`;
  let outputPath = await window.electronAPI.showSaveDialog(defaultFileName);
  if (!outputPath) {
    clipExportStatus.textContent = "❌ Export cancelled.";
    return;
  }
  try {
    await window.electronAPI.exportClip({
      file, start: s, duration, format, outputPath
    });
    clipExportStatus.textContent = 'Export complete!';
  } catch (err) {
    clipExportStatus.textContent = 'Error: ' + (err?.message || err);
    console.error(err);
  }
}

// --- DOM ---
const gifStartInput = document.getElementById('gif-start-time');
const gifEndInput   = document.getElementById('gif-end-time');
const gifUseCurrentStart = document.getElementById('gif-use-current-start');
const gifUseCurrentEnd   = document.getElementById('gif-use-current-end');
const gifPreviewBtn      = document.getElementById('gif-preview-btn');
const gifStopPreviewBtn  = document.getElementById('gif-stop-preview-btn');
const gifExportBtn       = document.getElementById('gif-export-btn');
const gifExportStatus    = document.getElementById('gif-export-status');

function updateExportButtonState() {
  let s = parseHMS(gifStartInput.value);
  let e = parseHMS(gifEndInput.value);
  let valid = (e > s && s >= 0 && e <= player.duration && (e - s) > 0.5);
  gifExportBtn.disabled = !valid;
}
function validateGifTimes() {
  let s = parseHMS(gifStartInput.value);
  let e = parseHMS(gifEndInput.value);
  return (e > s && s >= 0 && e <= player.duration && (e - s) > 0.5);
}

// --- State ---
let gifPreviewActive = false;
let gifPreviewLoopId = null;
let extractedGifFrames = []; // Array of {url, index}
let currentPreviewFrame = 0;
let previewFramesTimer = null;

// --- Wire up input events ---
gifStartInput.oninput = gifEndInput.oninput = updateExportButtonState;

gifUseCurrentStart.onclick = function() {
  const player = window.player;
  gifStartInput.value = formatHMS(player.currentTime);
  updateExportButtonState();
};
gifUseCurrentEnd.onclick = function() {
  const player = window.player;
  gifEndInput.value = formatHMS(player.currentTime);
  updateExportButtonState();
};



// --- Preview with frames and frame editor ---
gifPreviewBtn.onclick = async function() {
  let start = parseHMS(gifStartInput.value);
  let end   = parseHMS(gifEndInput.value);
  if (!validateGifTimes()) return;

  gifPreviewBtn.disabled = true;
  gifPreviewBtn.textContent = 'Extracting frames...';
  gifExportStatus.textContent = "Extracting frames for GIF preview...";

  // Ask main process to extract frames (returns array of base64 images)
  const playbackFilename = getCurrentPlaybackFilename();
  const inputPath = playbackFilename ? (videoPath + '/' + playbackFilename) : null;
  if (!inputPath) {
    gifExportStatus.textContent = "No video loaded!";
    gifPreviewBtn.disabled = false;
    gifPreviewBtn.textContent = 'Preview GIF';
    return;
  }
  const duration = end - start;

  // Clear any previous frames shown
  showGifFramesEditor([]);
  extractedGifFrames = [];

  try {
    // This should return an array of { url: 'data:image/png;base64,...' }
    // Assumes window.electronAPI.extractGifFrames({inputPath, start, duration, fps: 15})
    const frames = await window.electronAPI.extractGifFrames({ inputPath, start, duration, fps: 15 });
if (!Array.isArray(frames) || frames.length === 0) throw new Error("No frames extracted");
extractedGifFrames = frames.map((f, i) => ({ url: f.url, filePath: f.filePath, index: i }));
showGifFramesEditor(extractedGifFrames);

previewGifFramesSequence(extractedGifFrames, 1000 / 15);


    // Preview: play the sequence in an <img> below video
    previewGifFramesSequence(extractedGifFrames, 1000 / 15);

    gifExportStatus.textContent = "";
  } catch (err) {
    gifExportStatus.textContent = "❌ Failed to extract frames: " + (err.message || err);
  }
  gifPreviewBtn.disabled = false;
  gifPreviewBtn.textContent = 'Preview GIF';
};

gifStopPreviewBtn.onclick = function() {
  stopPreviewGifFrames();
};

function previewGifFramesSequence(frames, interval) {
  stopPreviewGifFrames();

  if (!frames.length) return;
  const previewDiv = document.getElementById('gif-preview-anim');
  if (!previewDiv) return;
  previewDiv.innerHTML = '';
  const img = document.createElement('img');
  img.style.maxWidth = '400px';
  img.style.display = 'block';
  previewDiv.appendChild(img);

  let idx = 0;
  function showNextFrame() {
    if (!frames.length) return;
    img.src = frames[idx % frames.length].url;
    idx++;
    if (idx < frames.length) {
      previewFramesTimer = setTimeout(showNextFrame, interval);
    } else {
      // Pause on last frame for 2 seconds, then loop
      previewFramesTimer = setTimeout(() => {
        idx = 0;
        showNextFrame();
      }, 2000);
    }
  }
  showNextFrame();
}

function stopPreviewGifFrames() {
  if (previewFramesTimer) {
    clearTimeout(previewFramesTimer);
    previewFramesTimer = null;
  }
  const previewDiv = document.getElementById('gif-preview-anim');
  if (previewDiv) previewDiv.innerHTML = '';
}

// === Frame Deletion / Editor UI ===
function showGifFramesEditor(frames) {
  // Container for preview animation 
  let previewDiv = document.getElementById('gif-preview-anim');
  if (!previewDiv) {
    previewDiv = document.createElement('div');
    previewDiv.id = 'gif-preview-anim';
    previewDiv.style.margin = "18px 0";
    document.getElementById('gif-export-container').appendChild(previewDiv);
  } else {
    previewDiv.innerHTML = '';
  }

  // Container for frame thumbnails with delete buttons
  let thumbDiv = document.getElementById('gif-frames-thumbnails');
  if (!thumbDiv) {
    thumbDiv = document.createElement('div');
    thumbDiv.id = 'gif-frames-thumbnails';
    thumbDiv.style.display = "flex";
    thumbDiv.style.flexWrap = "wrap";
    thumbDiv.style.gap = "6px";
    thumbDiv.style.marginTop = "12px";
    document.getElementById('gif-export-container').appendChild(thumbDiv);
  } else {
    thumbDiv.innerHTML = '';
  }

  // Display all frame thumbnails (and delete buttons)
  frames.forEach((frame, i) => {
    // If frames are objects: frame.url; if just strings, use frame directly.
    const frameUrl = typeof frame === 'string' ? frame : frame.url;

    const wrap = document.createElement('div');
    wrap.style.position = 'relative';

    // === Here is the img for each frame ===
    let img = document.createElement('img');
    img.src = frameUrl;
    img.style.width = '70px';
    img.style.height = 'auto';
    img.style.border = "1px solid #888";
    img.style.borderRadius = "5px";
    wrap.appendChild(img);

    // === Delete button for each frame ===
    const del = document.createElement('button');
    del.textContent = "✕";
    del.title = "Delete this frame";
    del.style.position = "absolute";
    del.style.top = "1px";
    del.style.right = "1px";
    del.style.background = "#d22";
    del.style.color = "#fff";
    del.style.border = "none";
    del.style.borderRadius = "3px";
    del.style.cursor = "pointer";
    del.onclick = () => {
      extractedGifFrames.splice(i, 1);
      showGifFramesEditor(extractedGifFrames);
      previewGifFramesSequence(extractedGifFrames, 1000 / 15);
    };
    wrap.appendChild(del);

    thumbDiv.appendChild(wrap);
  });
}

// Escape key cancels preview
document.addEventListener('keydown', function(e){
  if (gifPreviewActive && e.key === "Escape") gifStopPreviewBtn.onclick();
});

document.addEventListener('fullscreenchange', () => {
  if (assRenderer && typeof assRenderer.resize === 'function') {
    assRenderer.resize();
  }
});

// --- Export Logic ---
gifExportBtn.onclick = async function() {
  const playbackFilename = getCurrentPlaybackFilename();
  let inputPath = playbackFilename ? (videoPath + '/' + playbackFilename) : null;
  if (!inputPath) {
    gifExportStatus.textContent = "No video loaded!";
    return;
  }
  let start = parseHMS(gifStartInput.value);
  let end   = parseHMS(gifEndInput.value);
  let duration = end - start;
  if (!validateGifTimes()) {
    gifExportStatus.textContent = "Invalid times.";
    return;
  }
  let defaultFileName = currentVideoFilename.replace(/\.\w+$/, '') + `_${gifStartInput.value.replace(/:/g,'-')}-${gifEndInput.value.replace(/:/g,'-')}.gif`;
  let outputPath = await window.electronAPI.showSaveDialog(defaultFileName);
  if (!outputPath) {
    gifExportStatus.textContent = "❌ Export cancelled.";
    return;
  }
  gifExportStatus.textContent = 'Exporting...';
  try {
    let result;
    if (Array.isArray(extractedGifFrames) && extractedGifFrames.length && extractedGifFrames[0].filePath) {
      // deleted frames, export using ONLY those frames
      let framePaths = extractedGifFrames.map(f => f.filePath);
      result = await window.electronAPI.makeGifFromFrames({
        framePaths,
        outputPath,
        fps: 15
      });
    } else {
      result = await window.electronAPI.makeGif({ inputPath, start, duration, outputPath });
    }
    if (result && result.success) {
      gifExportStatus.textContent = '✅ GIF exported: ' + result.outputPath;
      setTimeout(() => { gifExportStatus.textContent = ""; }, 2500);
    }
  } catch (e) {
    gifExportStatus.textContent = "❌ Failed: " + e.message;
  }
};


function hideGifExportUI() {
  document.getElementById('gif-export-container').style.display = 'none';
  stopPreviewGifFrames();
}
function showGifExportUI() {
  document.getElementById('gif-export-container').style.display = '';
  updateExportButtonState();
  showGifFramesEditor([]); // Clear previous frames
  stopPreviewGifFrames();
}



// === YouTube Tab Initialization Function ===
async function initializeYouTubeTab(force = false) {
  if (youtubeTabInitialized && !force) return;
  youtubeTabInitialized = true;

  await loadChatFiles();
  await loadAltVideoURLs();

  const res = await fetch('data/videos.json');
  rawVideoData = await res.json();
  await hydrateUserPlaylistsFromDisk();
  migrateStoredVideoFilenameReferences();

  try {
    const subs = await fetch('data/subtitles.json');
    subtitlesData = await subs.json();
  } catch (e) {
    console.warn("Could not load data/subtitles.json");
  }

  populatePlaylistOptions();
  syncTagFilterUIFromState()
  renderVideoGrid();

  // === Set up all YouTube grid/queue/filter controls ===
  if (!initializeYouTubeTab._listenersAdded) {
    const sizeSelector = document.getElementById('sizeSelector');
    if (sizeSelector) {
      let savedSize = localStorage.getItem('videoSizeMode') || 'normal';
      sizeSelector.value = savedSize;
      sizeSelector.addEventListener('change', e => {
        resizePlayer(e.target.value);
      });
    }

    const sortOrderEl = document.getElementById('sortOrder');
    if (!sortOrderEl) return;
    sortOrderEl.addEventListener('change', e => {
      sortOrder = e.target.value;
      renderVideoGrid();
    });

    const badgeToggle = document.getElementById('badge-toggle');
    if (badgeToggle) badgeToggle.addEventListener('change', e => {
      showBadges = e.target.checked;
      renderVideoGrid();
    });

    const watchedToggle = document.getElementById('watchedToggle');
    if (watchedToggle) watchedToggle.addEventListener('change', e => {
      showWatched = e.target.checked;
      renderVideoGrid();
    });

    const favoritesToggle = document.getElementById('favoritesToggle');
    if (favoritesToggle) favoritesToggle.addEventListener('change', () => {
      renderVideoGrid();
    });

    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.addEventListener('input', () => {
      renderVideoGrid();
    });

    const filterSelect = document.getElementById('tagFilter');
    if (filterSelect) {
      filterSelect.addEventListener('change', e => {
        tagFilter = e.target.value;
        localStorage.setItem(STORAGE_KEYS.tagFilter, tagFilter);
        renderVideoGrid();
      });
    }

    const playlistSelect = document.getElementById('playlistSelect');
    if (playlistSelect) {
      playlistSelect.addEventListener('change', e => {
        selectedPlaylist = e.target.value;
        updatePlaylistActionButtons();
        renderVideoGrid();
        if (selectedPlaylist === 'all') {
          renderQueue();
        }
      });
    }

    document.getElementById('create-playlist-btn')?.addEventListener('click', handleCreateUserPlaylist);
    document.getElementById('export-playlist-btn')?.addEventListener('click', handleExportUserPlaylist);
    document.getElementById('import-playlist-btn')?.addEventListener('click', handleImportUserPlaylist);
    document.getElementById('delete-playlist-btn')?.addEventListener('click', handleDeleteUserPlaylist);

    // Shuffle/reverse buttons (sidebar)
    const shuffleBtn = document.getElementById('shuffle-playlist-btn');
    if (shuffleBtn && !shuffleBtn._listenerSet) {
      shuffleBtn.addEventListener('click', function() { handleShuffle(true); });
      shuffleBtn._listenerSet = true;
    }
    const reverseBtn = document.getElementById('reverse-playlist-btn');
    if (reverseBtn && !reverseBtn._listenerSet) {
      reverseBtn.addEventListener('click', function() { handleReverse(true); });
      reverseBtn._listenerSet = true;
    }

    // Shuffle/reverse
    const shuffleGridBtn = document.getElementById('shuffle-grid-btn');
    const reverseGridBtn = document.getElementById('reverse-grid-btn');
    if (shuffleGridBtn) {
      shuffleGridBtn.addEventListener('click', function() {
        handleShuffle(false);
      });
    }
    if (reverseGridBtn) {
      reverseGridBtn.addEventListener('click', function() {
        handleReverse(false);
      });
    }

    initializeYouTubeTab._listenersAdded = true;
  }

  // Only check for missing videos ONCE
    if (!initializeYouTubeTab._missingCheckDone) {
    const missing = await window.electronAPI.checkMissingVideos();
    if (missing.length) {
      if (confirm(`You’re missing or have older versions of ${missing.length} videos. Download them now?`)) {
        try {
          await window.electronAPI.downloadVideos(missing);
          alert('All missing or updated videos have been downloaded!');
        } catch (e) {
          alert('Failed to download videos: ' + e.message);
        }
      }
    }
    initializeYouTubeTab._missingCheckDone = true;
  }

  renderQueue();
}

// === Attach Random Video Button Event Handler after videos are loaded ===
  const randomBtn = document.getElementById('randomVideoBtn');
if (randomBtn && !randomBtn._handlerAdded) {
  randomBtn.addEventListener('click', () => {
    if (!rawVideoData.length) {
      alert('Videos not loaded yet!');
      return;
    }
    selectedPlaylist = 'all';
    tagFilter = 'all';
    localStorage.setItem(STORAGE_KEYS.tagFilter, 'all');
    document.getElementById('playlistSelect').value = 'all';
    document.getElementById('tagFilter').value = 'all';
    renderVideoGrid();

    const idx = Math.floor(Math.random() * rawVideoData.length);
    const video = rawVideoData[idx];
    if (video) {
      showPlayer(video, rawVideoData, idx);
    }
  });
  randomBtn._handlerAdded = true;
}


function getDebugOverlay() {
  return null;
}

// === Queue Videos ===
function loadQueue() {
  return JSON.parse(localStorage.getItem('videoQueue') || '[]');
}
function saveQueue(queue) {
  localStorage.setItem('videoQueue', JSON.stringify(queue));
}
function addToQueue(filename) {
  let queue = loadQueue();
  if (!queue.includes(filename)) {
    queue.push(filename);
    saveQueue(queue);
    renderQueue();
  }
}
function removeFromQueue(filename) {
  let queue = loadQueue();
  queue = queue.filter(f => f !== filename);
  saveQueue(queue);
  renderQueue();
  renderVideoGrid();
}

function renderQueue() {
  const queueDiv = document.getElementById('playlist-queue');
  const queue = loadQueue();
  unobserveLazyImages(queueDiv);
  queueDiv.innerHTML = '';
  const currentFile = currentVideoFilename;

  queue.forEach(filename => {
    const video = rawVideoData.find(v => v.filename === filename);
    if (!video) return;
    const item = document.createElement('div');
    item.className = 'queue-item';
    if (currentFile === filename) {
      item.classList.add('current');
    }
    const img = document.createElement('img');
    img.className = 'queue-thumb';
    img.alt = video.title || 'Thumbnail';
    lazyLoadImage(img, video.thumbnail);

    const title = document.createElement('span');
    title.className = 'queue-title';
    title.textContent = video.title || '';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-queue-btn';
    removeBtn.textContent = '✕';

    item.append(img, title, removeBtn);

    item.onclick = (e) => {
      if (e.target.classList.contains('remove-queue-btn')) return;
      const queue = loadQueue();
      const idx = queue.indexOf(video.filename);
      const videos = queue.map(f => rawVideoData.find(v => v.filename === f)).filter(Boolean);
      showPlayer(video, videos, idx);
    };

    removeBtn.onclick = (ev) => {
      ev.stopPropagation();
      removeFromQueue(video.filename);
    };

    queueDiv.appendChild(item);
  });
  document.getElementById('playlist-queue-container').style.display = queue.length ? 'block' : 'none';
  loadVisibleLazyImages(queueDiv);
}

// === Watched Progress Bar ===
function loadWatchedProgress() {
  return JSON.parse(localStorage.getItem('watchedProgress') || '{}');
}
function saveWatchedProgress(progress) {
  localStorage.setItem('watchedProgress', JSON.stringify(progress));
}

// === Universal Download Progress Bar ===

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showMainDownloadProgress(status, percent, received, total, detail = '') {
  const bar = document.getElementById('main-download-bar');
  const wrap = document.getElementById('main-download-progress');
  const label = document.getElementById('main-download-label');
  const statusDiv = document.getElementById('main-download-status');
  if (!wrap || !bar || !label || !statusDiv) return;
  wrap.style.display = 'block';
  const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  bar.style.width = Math.round(safePercent) + '%';
  statusDiv.textContent = status;
  const hasByteTotal = Number.isFinite(received) && Number.isFinite(total) && total > 0;
  const byteText = hasByteTotal
    ? `${formatBytes(received)} / ${formatBytes(total)} (${Math.round(safePercent)}%)`
    : (safePercent ? `${Math.round(safePercent)}%` : '');
  label.textContent = detail && byteText ? `${detail} - ${byteText}` : detail || byteText;
}

function hideMainDownloadProgress() {
  const wrap = document.getElementById('main-download-progress');
  if (wrap) wrap.style.display = 'none';
}

window.electronAPI.onUpdateProgress?.(function (progress) {
  showMainDownloadProgress(
    "Downloading program update...",
    progress.percent,
    progress.transferred,
    progress.total
  );
  if (progress.percent >= 100) setTimeout(hideMainDownloadProgress, 2000);
});

window.electronAPI.onVideoDownloadProgress?.(function (data) {
  const hasBatchCount = Number.isFinite(data.totalVideos) && data.totalVideos > 0;
  const completed = hasBatchCount
    ? Math.min(Number.isFinite(data.completed) ? data.completed : 0, data.totalVideos)
    : 0;
  const current = hasBatchCount
    ? Math.min(Number.isFinite(data.current) ? data.current : completed || 1, data.totalVideos)
    : 0;
  const countText = hasBatchCount ? `${completed} / ${data.totalVideos} videos downloaded` : '';
  const status = data.done
    ? (hasBatchCount ? `Downloaded ${completed} / ${data.totalVideos} videos` : 'Downloaded videos')
    : hasBatchCount
      ? `Downloading video ${current} of ${data.totalVideos}: ${data.filename || ''}`
      : `Downloading video: ${data.filename || ''}`;
  showMainDownloadProgress(
    status,
    data.percent,
    data.received,
    data.total,
    countText
  );
  if (data.done) setTimeout(hideMainDownloadProgress, 2000);
});

async function loadChatFiles() {
  try {
    const res = await fetch('data/chat_index.json');
    const list = await res.json();
    list.forEach(f => chatFiles.add(f));
  } catch (e) {
    console.warn("Could not load chat_index.json");
  }
}

async function loadComments(video, sortType = localStorage.getItem('commentSortType') || "newest") {
  const loadToken = ++commentsLoadToken;
  const isStale = () =>
    loadToken !== commentsLoadToken ||
    currentVideoFilename !== video.filename ||
    document.getElementById('video-player')?.style.display === 'none';
  // Map any video extension (.mp4/.webm/etc.) to matching comments json files.
  const safeFilename = video.filename.replace(/\.[^/.]+$/, '.json');
  const commentFilenameCandidates = [safeFilename];
  // Windows-safe archive exports have used both the big solidus (⧸) and
  // fullwidth solidus (／) for slashes. Try both spellings when they differ.
  const alternateSlashFilename = safeFilename.includes('⧸')
    ? safeFilename.replaceAll('⧸', '／')
    : safeFilename.includes('／')
      ? safeFilename.replaceAll('／', '⧸')
      : safeFilename;
  if (alternateSlashFilename !== safeFilename) {
    commentFilenameCandidates.push(alternateSlashFilename);
  }
  const sharedAudioVariantFilename = safeFilename.replace(/\s+\(Bad Audio\)(?=\.json$)/i, '');
  if (sharedAudioVariantFilename !== safeFilename) {
    commentFilenameCandidates.push(sharedAudioVariantFilename);
  }
  const commentContainer = document.getElementById('comments-section');
  commentContainer.innerHTML = '';
  commentContainer.style.display = 'none';

  // --- CONFIGURATION ---
  const profilePics = [...Array(36)].map((_, i) => `PFPs/pfp${i + 1}.png`);
  const TAMERS_AUTHORS = ["@Tamers12345Official", "Tamers12345Official", "@Tamers12345mlp", "Tamers12345mlp", "@Tamers12345MLP", "Tamers12345MLP", "@Tamers12345", "Tamers12345", "@tamers12345", "tamers12345", "@TamersDandysWorld", "TamersDandysWorld"];

  // --- HELPERS ---
  function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function isUploaderComment(comment) {
    const normalizedAuthor = String(comment?.author || '').trim().toLowerCase();
    const matchesKnownTamersName = TAMERS_AUTHORS
      .some(author => String(author).trim().toLowerCase() === normalizedAuthor);
    return !!(comment?.author_is_uploader || matchesKnownTamersName);
  }
  function getAvatar(commentOrAuthor, fallbackPic) {
    const comment = typeof commentOrAuthor === 'object'
      ? commentOrAuthor
      : { author: commentOrAuthor };
    return isUploaderComment(comment) ? getTamersProfilePicture(comment.author) : fallbackPic;
  }
  function hasTamersReply(comment) {
    return Array.isArray(comment.replies) &&
      comment.replies.some(reply => isUploaderComment(reply));
  }
  function getPinnedByName(sourceComments) {
    const stack = [...sourceComments];
    while (stack.length) {
      const current = stack.shift();
      if (isUploaderComment(current) && current.author) return current.author;
      if (Array.isArray(current.replies)) stack.push(...current.replies);
    }
    return '';
  }
  async function getMetadataUploaderName() {
    for (const candidate of commentFilenameCandidates) {
      try {
        const metadata = await fetchJsonFile('metadata', candidate);
        if (metadata?.channel || metadata?.uploader) return metadata.channel || metadata.uploader;
      } catch (err) {
        // Keep pinned labels working even if metadata is missing.
      }
    }
    return '';
  }
  function getUploaderOnlyComments(sourceComments) {
    const uploaderComments = [];
    sourceComments.forEach(comment => {
      const uploaderReplies = Array.isArray(comment.replies)
        ? comment.replies.filter(reply => isUploaderComment(reply))
        : [];

      if (isUploaderComment(comment)) {
        uploaderComments.push({ ...comment, replies: uploaderReplies });
      } else {
        uploaderReplies.forEach(reply => {
          uploaderComments.push({ ...reply, replies: [] });
        });
      }
    });
    return uploaderComments;
  }
  async function fetchJsonFile(folder, filename) {
    if (window.electronAPI?.readArchiveJson) {
      const data = await window.electronAPI.readArchiveJson(folder, filename);
      if (data) return data;
    }

    const res = await fetch(`${folder}/${encodeURIComponent(filename)}`);
    if (!res.ok) return null;
    return await res.json();
  }

  // --- Fetch comments (modern or legacy) ---
  let comments = null;
  let usedLegacy = false;
  try {
    for (const candidate of commentFilenameCandidates) {
      try {
        comments = await fetchJsonFile('comments', candidate);
        if (comments) break;
      } catch (err) {
        console.warn('Failed to load comments candidate:', candidate, err);
      }
    }
    if (!comments) throw new Error('No comments file');
    if (isStale()) return;
  } catch (e) {
    const dateStr = (video.date || '').trim();
    const isOldVideo = /^\d{8}$/.test(dateStr) && parseInt(dateStr, 10) < 20250213;
    if (isOldVideo) {
      try {
        for (const candidate of commentFilenameCandidates) {
          const metadata = await fetchJsonFile('metadata', candidate);
          if (metadata && Array.isArray(metadata.comments)) {
            comments = metadata.comments;
            usedLegacy = true;
            break;
          }
        }
      } catch (err) {
        // Silent fail
      }
    }
  }
  if (isStale()) return;
  if (!comments || !comments.length) {
    commentContainer.style.display = 'block';
    commentContainer.innerHTML = `<h3>No comments available for this video.</h3>`;
    return;
  }

  // === Sorting logic ===
  function sortComments(comments, sortType) {
    let sorted = sortType === "tamers_comments"
      ? getUploaderOnlyComments(comments)
      : [...comments];
    if (sortType === "oldest") {
      sorted.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    } else if (sortType === "newest") {
      sorted.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    } else if (sortType === "likes") {
      sorted.sort((a, b) => (b.like_count || 0) - (a.like_count || 0));
    } else if (sortType === "tamers_reply") {
      sorted.sort((a, b) => {
        const aHas = hasTamersReply(a) ? 1 : 0;
        const bHas = hasTamersReply(b) ? 1 : 0;
        if (bHas !== aHas) return bHas - aHas;
        return (b.timestamp || 0) - (a.timestamp || 0);
      });
    } else if (sortType === "favorited") {
      sorted.sort((a, b) => {
        const aFav = a.is_favorited ? 1 : 0;
        const bFav = b.is_favorited ? 1 : 0;
        if (bFav !== aFav) return bFav - aFav;
        return (b.timestamp || 0) - (a.timestamp || 0);
      });
    } else if (sortType === "tamers_comments") {
      sorted.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
    const pinned = sorted.filter(comment => comment.is_pinned);
    const unpinned = sorted.filter(comment => !comment.is_pinned);
    return [...pinned, ...unpinned];
  }
  const sortedComments = sortComments(comments, sortType);
  const hasVisiblePinnedComment = sortedComments.some(comment =>
    comment.is_pinned ||
    (Array.isArray(comment.replies) && comment.replies.some(reply => reply.is_pinned))
  );
  const uploaderName = await getMetadataUploaderName() || getPinnedByName(comments) || 'Tamers12345';
  const uploaderPfp = getTamersProfilePicture(uploaderName);
  const pinnedByName = hasVisiblePinnedComment ? uploaderName : '';
  if (isStale()) return;

  commentContainer.style.display = 'block';
  commentContainer.innerHTML =
    `<h3>Comments</h3>
     <div id="comment-sort-container" style="margin-bottom: 10px;">
      <label for="comment-sort-select" style="font-size:0.98em;">Sort by:</label>
      <select id="comment-sort-select">
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="likes">Most Likes</option>
        <option value="tamers_reply">Tamers Replied</option>
        <option value="tamers_comments">Tamers Comments</option>
        <option value="favorited">Favorited</option>
      </select>
     </div>` +
    (usedLegacy ? `
      <p style="color:#999;font-size:12px;margin-top:-10px;">
        Unfortunately I was not able to archive all of the comments from Tamers' old channel. At the time, I did not have a consistent way to scrape the comments like I do now. What you see below are only some of the comments that were preserved in the video's metadata files, and they do not reflect the actual number or full range of comments these videos once had. On top of that some of the information such as the day the comment was posted might be wrong, not sure why that is but it is.


      </p>` : '') +
    (sortedComments.length ? sortedComments.map((comment, index) => {
      // Randomize comment PFP
      const randomPic = profilePics[Math.floor(Math.random() * profilePics.length)];
      const avatarPic = getAvatar(comment, randomPic);
      const isTamers = isUploaderComment(comment);
      const commentId = `comment-${index}`;
      const likeCount = typeof comment.like_count !== "undefined"
        ? `<span class="comment-likes"><span class="like-emoji">👍</span> ${comment.like_count}</span>` : '';
      const postDate = comment.timestamp ? `<span class="comment-date">${formatDate(comment.timestamp)}</span>` : '';
      const pinnedBadge = comment.is_pinned
        ? `<div class="comment-pinned"><span class="comment-pinned-icon">📌</span> Pinned by ${escapeHtml(pinnedByName)}</div>`
        : '';
      const favoritedBadge = comment.is_favorited
        ? `
          <span class="comment-favorited">
            <img class="uploader-fav-pfp" src="${uploaderPfp}" alt="Uploader">
            <span class="fav-heart">&#10084;&#65039;</span>
          </span>
        `
        : '';

      let repliesHTML = '';
      if (Array.isArray(comment.replies) && comment.replies.length > 0) {
        // Detect if Tamers replied
        const tamersReply = comment.replies.find(reply => isUploaderComment(reply));
        // PFP badge if Tamers replied
        const tamersBadge = tamersReply
          ? `<img src="${getTamersProfilePicture(tamersReply.author)}" title="Uploader replied" style="width:16px;height:16px;border-radius:50%;vertical-align:middle;margin-left:6px;box-shadow:0 0 2px #0005;">`
          : '';

        repliesHTML = `
          <div class="replies" id="${commentId}-replies" style="display:none; margin-left: 50px;">
            ${comment.replies.map(reply => {
              const replyRandomPic = profilePics[Math.floor(Math.random() * profilePics.length)];
              const replyAvatarPic = getAvatar(reply, replyRandomPic);
              const replyLikeCount = typeof reply.like_count !== "undefined"
                ? `<span class="comment-likes"><span class="like-emoji">👍</span> ${reply.like_count}</span>` : '';
              const replyPostDate = reply.timestamp ? `<span class="comment-date">${formatDate(reply.timestamp)}</span>` : '';
              const replyPinnedBadge = reply.is_pinned
                ? `<div class="comment-pinned"><span class="comment-pinned-icon">📌</span> Pinned by ${escapeHtml(pinnedByName)}</div>`
                : '';
              const replyFavoritedBadge = reply.is_favorited
                ? `<span class="comment-favorited">
                    <img class="uploader-fav-pfp" src="${uploaderPfp}" alt="Uploader">
                    <span class="fav-heart">&#10084;&#65039;</span>
                  </span>` : '';
              return `
                <div class="comment">
                  <img src="${replyAvatarPic}" class="comment-avatar" alt="pfp">
                  <div class="comment-content">
                    ${replyPinnedBadge}
                    <a href="#" onclick="window.electronAPI.openExternal('${reply.author_url || '#'}'); return false;">
                      ${reply.author || 'Anonymous'}
                      ${isUploaderComment(reply) ? '<span class="yt-uploader-label" style="font-size:12px;color:#e43c53;margin-left:4px;">Uploader</span>' : ''}
                    </a>
                    <div class="comment-meta-row">
                      ${replyPostDate}
                      ${replyLikeCount}
                      ${replyFavoritedBadge}
                    </div>
                    <p>${reply.text}</p>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          <div class="reply-toggle" style="margin-left: 50px; margin-bottom: 10px;">
            <button class="show-replies-btn" onclick="
              document.getElementById('${commentId}-replies').style.display = 'block';
              this.style.display = 'none';
              document.getElementById('${commentId}-hide-btn').style.display = 'inline';
            ">
              Show ${comment.replies.length} repl${comment.replies.length === 1 ? 'y' : 'ies'}
              ${tamersBadge}
            </button>
            <button id="${commentId}-hide-btn" class="hide-replies-btn" style="display: none;" onclick="
              document.getElementById('${commentId}-replies').style.display = 'none';
              this.style.display = 'none';
              this.previousElementSibling.style.display = 'inline';
            ">
              Hide replies
            </button>
          </div>
        `;
      }

      return `
        <div class="comment">
          <img src="${avatarPic}" class="comment-avatar" alt="pfp">
          <div class="comment-content">
            ${pinnedBadge}
            <a href="#" onclick="window.electronAPI.openExternal('${comment.author_url || '#'}'); return false;">
              ${comment.author || 'Anonymous'}
              ${isTamers ? '<span class="yt-uploader-label" style="font-size:12px;color:#e43c53;margin-left:4px;">Uploader</span>' : ''}
            </a>
            <div class="comment-meta-row">
              ${postDate}
              ${likeCount}
              ${favoritedBadge}
            </div>
            <p>${comment.text}</p>
          </div>
        </div>
        ${repliesHTML}
      `;
    }).join('') : `<p class="comments-empty">No Tamers comments found for this video.</p>`);

  // --- comment sort by dropdown event handling ---
  const sortSelect = document.getElementById('comment-sort-select');
    if (sortSelect) {
    sortSelect.value = sortType;
    sortSelect.onchange = null;
    sortSelect.addEventListener('change', function(e) {
      localStorage.setItem('commentSortType', e.target.value);
      loadComments(video, e.target.value);
    });
  }
  commentContainer.querySelectorAll('img.comment-avatar, img.uploader-fav-pfp').forEach(img => {
    lazyLoadImage(img, img.getAttribute('src'));
  });
  loadVisibleLazyImages(commentContainer);
  const _c = document.getElementById('comments-section');
  if (_c) _c.scrollTop = 0;
}



// === Alt Video URLs loaded from JSON ===
async function loadAltVideoURLs() {
  try {
    const res = await fetch('data/altvideos.json');
    altVideoURLs = await res.json();
  } catch (e) {
    console.error("Could not load altvideos.json", e);
    altVideoURLs = {};
  }
}

async function fileExistsInVideoFolder(filename) {
  if (!videoPath) return false;
  return await window.electronAPI.fileExists(`${videoPath}/${filename}`);
}
async function saveAltVideoToFolder(filename, arrayBuffer) {
  if (!videoPath) throw new Error("No video path selected!");
  return await window.electronAPI.saveAltVideo(`${videoPath}/${filename}`, arrayBuffer);
}

// === Build the "Missing Alt Videos" list and checkboxes ===
async function renderMissingAltVideos() {
  const listDiv = document.getElementById('missing-alt-video-list');
  if (!listDiv) return;
  listDiv.innerHTML = '<strong>Missing Alt Videos:</strong><br>';

  if (!altVideoURLs || !Object.keys(altVideoURLs).length) {
    await loadAltVideoURLs();
  }

  let subs = subtitlesData;
  if (!subs || !Object.keys(subs).length) {
    try {
      const r = await fetch('data/subtitles.json');
      if (r.ok) subs = await r.json();
    } catch (_) {}
  }
  if (!subs || !Object.keys(subs).length) {
    listDiv.innerHTML += '<p>❌ No subtitles metadata available, cannot detect alt videos.</p>';
    return;
  }

  const referenced = new Set();
  const stack = [subs];
  while (stack.length) {
    const node = stack.pop();
    if (node && typeof node === 'object') {
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') {
          if (Object.prototype.hasOwnProperty.call(v, 'altVideo') && v.altVideo) {
            referenced.add(String(v.altVideo));
          }
          stack.push(v);
        }
      }
    }
  }

  const candidates = [...referenced].filter(name => !!altVideoURLs[name]);

  const missing = [];
  for (const filename of candidates) {
    const exists = await fileExistsInVideoFolder(filename);
    if (!exists) missing.push(filename);
  }

  if (missing.length === 0) {
    listDiv.innerHTML += '<p>✅ All alt videos are present.</p>';
    return;
  }

  let formHtml = '<form id="alt-video-form" style="margin-top:6px;">';
  formHtml += missing.map(f => `
    <label style="display:block;margin:3px 0;">
      <input type="checkbox" name="alt" value="${f}" checked> ${f}
    </label>`).join('');
  formHtml += '</form>';
  listDiv.innerHTML += formHtml;
}

// === Download selected alt videos to the video folder ===
async function downloadAltVideosHandler() {
  const form = document.getElementById('alt-video-form');
  const listDiv = document.getElementById('missing-alt-video-list');
  const force = !!document.getElementById('force-redownload')?.checked;

  if (!form) {
    alert('Nothing to download.');
    return;
  }

  const selected = [...form.querySelectorAll('input[name="alt"]:checked')].map(i => i.value);
  if (!selected.length) {
    alert('Select at least one alt video.');
    return;
  }

  if (!videoPath) {
    alert('Select your video folder first in Settings.');
    return;
  }

  const statusId = 'alt-dl-status';
  let status = document.getElementById(statusId);
  if (!status) {
    status = document.createElement('div');
    status.id = statusId;
    status.style.marginTop = '8px';
    listDiv.appendChild(status);
  }

  let ok = 0, fail = 0;
  for (const filename of selected) {
    const url = altVideoURLs[filename];
    if (!url) { fail++; continue; }

    try {
      if (!force) {
        const exists = await fileExistsInVideoFolder(filename);
        if (exists) { ok++; continue; }
      }

      status.textContent = `Downloading ${filename} …`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();

      await saveAltVideoToFolder(filename, buf);
      ok++;
    } catch (e) {
      console.error('Alt video download failed:', filename, e);
      fail++;
    }
  }

  status.textContent = `Done. Success: ${ok}, Failed: ${fail}.`;
  await renderMissingAltVideos();
}

function isAss(path) {
  return path.toLowerCase().endsWith('.ass');
}

function isSrt(path) {
  return path.toLowerCase().endsWith('.srt');
}

function getSubtitlePathCandidates(subtitlePath) {
  const cleanPath = String(subtitlePath || '').trim();
  if (!cleanPath) return [];

  const candidates = [cleanPath];
  if (/^subtitles[\\/]/i.test(cleanPath) && cleanPath.includes(':')) {
    candidates.push(cleanPath.replace(/:/g, '\uFF1A'));
  }

  return [...new Set(candidates)];
}

async function fetchSubtitleText(subtitlePath) {
  const candidates = getSubtitlePathCandidates(subtitlePath);
  let lastError = null;

  for (const candidate of candidates) {
    const url = new URL(candidate, window.location.href).href;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) {
        return {
          path: candidate,
          text: await response.text()
        };
      }
      lastError = new Error(`Subtitle fetch failed with ${response.status}: ${candidate}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Subtitle file could not be loaded: ${subtitlePath}`);
}

function convertSrtToWebVtt(text) {
  const body = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}\.\d{3} -->)/gm, '');

  return body.startsWith('WEBVTT') ? body : `WEBVTT\n\n${body}`;
}

function parseSubtitleTime(timeText) {
  const parts = String(timeText || '').replace(',', '.').split(':');
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) return NaN;
  return (hours * 3600) + (minutes * 60) + seconds;
}

function decodeSubtitleEntities(text) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
}

function cleanSubtitleCueText(text) {
  return String(text || '')
    .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
    .replace(/<\d{2}:\d{2}\.\d{3}>/g, '')
    .replace(/<\/?c(?:\.[^>]*)?>/g, '')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map(line => decodeSubtitleEntities(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseWebVttCues(text) {
  const normalized = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '');

  const cues = [];
  const blocks = normalized.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split('\n').filter(line => line.trim() !== '');
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex === -1) continue;

    const timingMatch = lines[timingIndex].match(/(\d{1,2}:\d{2}(?::\d{2})?[\.,]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[\.,]\d{3})/);
    if (!timingMatch) continue;

    const start = parseSubtitleTime(timingMatch[1]);
    const end = parseSubtitleTime(timingMatch[2]);
    const text = cleanSubtitleCueText(lines.slice(timingIndex + 1).join('\n'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;

    cues.push({ start, end, text });
  }

  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

function getTextSubtitleOverlay() {
  let overlay = document.getElementById('text-subtitle-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'text-subtitle-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  document.getElementById('video-fullscreen-container')?.appendChild(overlay);
  return overlay;
}

function findActiveSubtitleCues(cues, currentTime) {
  return cues.filter(cue => cue.start <= currentTime && cue.end >= currentTime);
}

function renderTextSubtitleOverlay(overlay, cues, currentTime) {
  const active = findActiveSubtitleCues(cues, currentTime);
  if (!active.length) {
    overlay.textContent = '';
    overlay.style.display = 'none';
    return;
  }

  overlay.textContent = '';
  const line = document.createElement('span');
  line.className = 'text-subtitle-line';
  line.textContent = active.map(cue => cue.text).join('\n');
  overlay.appendChild(line);
  overlay.style.display = 'block';
}

function clearTextSubtitleOverlay() {
  if (textSubtitleState) {
    const { video, update } = textSubtitleState;
    video.removeEventListener('timeupdate', update);
    video.removeEventListener('seeked', update);
    video.removeEventListener('loadedmetadata', update);
    video.removeEventListener('play', update);
    textSubtitleState = null;
  }

  const overlay = document.getElementById('text-subtitle-overlay');
  if (overlay) {
    overlay.textContent = '';
    overlay.style.display = 'none';
  }
}

function setupTextSubtitleOverlay(video, cues) {
  clearTextSubtitleOverlay();
  const overlay = getTextSubtitleOverlay();
  if (!overlay || !cues.length) return;

  const update = () => renderTextSubtitleOverlay(overlay, cues, video.currentTime || 0);
  textSubtitleState = { video, update };

  video.addEventListener('timeupdate', update);
  video.addEventListener('seeked', update);
  video.addEventListener('loadedmetadata', update);
  video.addEventListener('play', update);
  update();
}

async function loadTextSubtitleTrack(track, subtitlePath, lang, loadToken) {
  const { path, text } = await fetchSubtitleText(subtitlePath);
  if (loadToken !== subtitleLoadToken) return;

  const subtitleText = isSrt(path)
    ? convertSrtToWebVtt(text)
    : String(text || '').replace(/^\uFEFF/, '');
  const cues = parseWebVttCues(subtitleText);

  if (track.track) {
    track.track.mode = 'disabled';
    track.track.oncuechange = null;
  }
  track.removeAttribute('src');
  track.label = lang;
  track.srclang = 'en';

  if (!cues.length) {
    console.warn(`Subtitle file loaded but no cues were parsed: ${subtitlePath}`);
    return;
  }

  setupTextSubtitleOverlay(window.player, cues);
}

function clearAssSubtitle() {
  clearTextSubtitleOverlay();
  if (assRenderer) {
    assRenderer.dispose();
    assRenderer = null;
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

async function loadAssSubtitle(subtitlePath, videoElement) {
  clearAssSubtitle();
  try {
    await ensureSubtitlesOctopusLoaded();
    const response = await fetch(subtitlePath);
    if (!response.ok) throw new Error(`Failed to fetch subtitle file: ${subtitlePath}`);
    const assText = await response.text();
    const parent = document.getElementById('video-fullscreen-container');
    assRenderer = new window.SubtitlesOctopus({
      video: videoElement,
      subContent: assText,
      workerUrl: window.SubtitlesOctopusWorkerUrl,
      legacyWorkerUrl: window.SubtitlesOctopusWorkerUrl,
      parent: parent
    });
  } catch (e) {
    console.error("❌ Failed to load .ass subtitle:", e);
  }
}

// === Playlist UI / Filtering / Rendering ===

function updatePlaylistActionButtons() {
  const isUserPlaylist = !!getUserPlaylistFromValue(selectedPlaylist);
  const exportBtn = document.getElementById('export-playlist-btn');
  const deleteBtn = document.getElementById('delete-playlist-btn');
  if (exportBtn) exportBtn.disabled = !isUserPlaylist;
  if (deleteBtn) deleteBtn.disabled = !isUserPlaylist;
}

function closeUserPlaylistDialog(overlay, resolve, value) {
  document.removeEventListener('keydown', overlay._keydownHandler);
  overlay.remove();
  resolve(value);
}

function showUserPlaylistNameDialog({ title = 'Playlist Name', message = '', defaultValue = '' } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'playlist-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'playlist-dialog';

    const heading = document.createElement('h3');
    heading.textContent = title;
    dialog.appendChild(heading);

    if (message) {
      const body = document.createElement('p');
      body.textContent = message;
      dialog.appendChild(body);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'playlist-dialog-input';
    input.value = defaultValue;
    input.autocomplete = 'off';
    dialog.appendChild(input);

    const error = document.createElement('div');
    error.className = 'playlist-dialog-error';
    dialog.appendChild(error);

    const actions = document.createElement('div');
    actions.className = 'playlist-dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = 'OK';

    actions.append(cancelBtn, okBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const submit = () => {
      const value = input.value.trim();
      if (!value) {
        error.textContent = 'Please enter a playlist name.';
        input.focus();
        return;
      }
      closeUserPlaylistDialog(overlay, resolve, value);
    };

    cancelBtn.addEventListener('click', () => closeUserPlaylistDialog(overlay, resolve, null));
    okBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
    });
    overlay._keydownHandler = e => {
      if (e.key === 'Escape') closeUserPlaylistDialog(overlay, resolve, null);
    };
    document.addEventListener('keydown', overlay._keydownHandler);

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

function showUserPlaylistConfirmDialog(message) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'playlist-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'playlist-dialog';

    const heading = document.createElement('h3');
    heading.textContent = 'Confirm';
    dialog.appendChild(heading);

    const body = document.createElement('p');
    body.textContent = message;
    dialog.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'playlist-dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = 'Delete';

    actions.append(cancelBtn, okBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    cancelBtn.addEventListener('click', () => closeUserPlaylistDialog(overlay, resolve, false));
    okBtn.addEventListener('click', () => closeUserPlaylistDialog(overlay, resolve, true));
    overlay._keydownHandler = e => {
      if (e.key === 'Escape') closeUserPlaylistDialog(overlay, resolve, false);
    };
    document.addEventListener('keydown', overlay._keydownHandler);
    requestAnimationFrame(() => cancelBtn.focus());
  });
}

function showUserPlaylistPickerDialog(video) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'playlist-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'playlist-dialog';

    const heading = document.createElement('h3');
    heading.textContent = 'Add to Playlist';
    dialog.appendChild(heading);

    const body = document.createElement('p');
    body.textContent = `Choose a playlist for "${video.title || video.filename}".`;
    dialog.appendChild(body);

    const list = document.createElement('div');
    list.className = 'playlist-dialog-list';
    userPlaylists.forEach(playlist => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = playlist.name;
      btn.addEventListener('click', () => closeUserPlaylistDialog(overlay, resolve, playlist));
      list.appendChild(btn);
    });
    dialog.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'playlist-dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(cancelBtn);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    cancelBtn.addEventListener('click', () => closeUserPlaylistDialog(overlay, resolve, null));
    overlay._keydownHandler = e => {
      if (e.key === 'Escape') closeUserPlaylistDialog(overlay, resolve, null);
    };
    document.addEventListener('keydown', overlay._keydownHandler);
    requestAnimationFrame(() => list.querySelector('button')?.focus());
  });
}

function createUserPlaylist(name) {
  const cleanName = makeUniquePlaylistName(name);
  const playlist = normalizeUserPlaylist({
    id: createUserPlaylistId(),
    name: cleanName,
    videoFilenames: []
  });
  userPlaylists.push(playlist);
  saveUserPlaylists();
  selectedPlaylist = getUserPlaylistSelectValue(playlist);
  populatePlaylistOptions();
  renderVideoGrid();
  return playlist;
}

async function handleCreateUserPlaylist() {
  const name = await showUserPlaylistNameDialog({ title: 'New Playlist' });
  if (!name) return;
  createUserPlaylist(name);
}

function getSelectedUserPlaylistOrAlert(action) {
  const playlist = getUserPlaylistFromValue(selectedPlaylist);
  if (!playlist) {
    alert(`Select one of your own playlists before you ${action}. Built-in playlists cannot be changed.`);
    return null;
  }
  return playlist;
}

async function handleExportUserPlaylist() {
  const playlist = getSelectedUserPlaylistOrAlert('export');
  if (!playlist) return;

  const payload = {
    format: USER_PLAYLIST_FILE_FORMAT,
    version: 1,
    name: playlist.name,
    exportedAt: new Date().toISOString(),
    videos: playlist.videoFilenames.map(filename => {
      const video = getVideoByFilename(filename);
      return {
        filename,
        title: video?.title || '',
        date: video?.date || ''
      };
    })
  };

  try {
    const savedPath = await window.electronAPI.exportUserPlaylist(payload, getSafePlaylistFileName(playlist.name));
    if (savedPath) alert(`Playlist exported:\n${savedPath}`);
  } catch (e) {
    alert(`Failed to export playlist: ${e.message || e}`);
  }
}

function extractImportedPlaylistVideoFilenames(imported) {
  const sourceVideos = Array.isArray(imported?.videos)
    ? imported.videos
    : Array.isArray(imported?.videoFilenames)
      ? imported.videoFilenames
      : [];
  const seen = new Set();
  const filenames = [];

  sourceVideos.forEach(entry => {
    const filename = typeof entry === 'string' ? entry : entry?.filename;
    const clean = String(filename || '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      filenames.push(clean);
    }
  });

  return filenames;
}

async function handleImportUserPlaylist() {
  try {
    const result = await window.electronAPI.importUserPlaylist();
    if (!result?.playlist) return;

    const imported = result.playlist;
    const filenames = extractImportedPlaylistVideoFilenames(imported);
    if (!filenames.length) {
      alert('That playlist file does not contain any videos.');
      return;
    }

    const localFilenames = new Set(rawVideoData.map(video => video.filename));
    const byBase = buildCurrentVideoFilenameByBase();
    const remappedFilenames = filenames.map(filename => remapVideoFilenameToCurrent(filename, byBase));
    const available = [...new Set(remappedFilenames.filter(filename => localFilenames.has(filename)))];
    const missingCount = filenames.length - available.length;
    if (!available.length) {
      alert('None of the videos in that playlist were found in this archive.');
      return;
    }

    const playlist = normalizeUserPlaylist({
      id: createUserPlaylistId(),
      name: makeUniquePlaylistName(imported.name || 'Imported Playlist'),
      videoFilenames: available,
      importedAt: new Date().toISOString()
    });
    userPlaylists.push(playlist);
    saveUserPlaylists();
    selectedPlaylist = getUserPlaylistSelectValue(playlist);
    populatePlaylistOptions();
    renderVideoGrid();
    alert(`Imported "${playlist.name}" with ${available.length} video${available.length === 1 ? '' : 's'}.${missingCount ? `\n${missingCount} video${missingCount === 1 ? '' : 's'} were not found locally.` : ''}`);
  } catch (e) {
    alert(`Failed to import playlist: ${e.message || e}`);
  }
}

async function handleDeleteUserPlaylist() {
  const playlist = getSelectedUserPlaylistOrAlert('delete');
  if (!playlist) return;
  const confirmed = await showUserPlaylistConfirmDialog(`Delete your playlist "${playlist.name}"? This will not delete any videos.`);
  if (!confirmed) return;

  userPlaylists = userPlaylists.filter(p => p.id !== playlist.id);
  saveUserPlaylists();
  selectedPlaylist = 'all';
  populatePlaylistOptions();
  renderVideoGrid();
}

async function chooseUserPlaylistForVideo(video) {
  if (!userPlaylists.length) {
    const name = await showUserPlaylistNameDialog({
      title: 'New Playlist',
      message: 'You do not have any user playlists yet. Create one now to add this video.'
    });
    if (name) return createUserPlaylist(name);
    return null;
  }

  if (userPlaylists.length === 1) return userPlaylists[0];

  return showUserPlaylistPickerDialog(video);
}

function addVideoToUserPlaylist(video, playlist) {
  if (!video || !playlist) return;
  if (!playlist.videoFilenames.includes(video.filename)) {
    playlist.videoFilenames.push(video.filename);
    playlist.updatedAt = new Date().toISOString();
    saveUserPlaylists();
  }
}

function removeVideoFromUserPlaylist(video, playlist) {
  if (!video || !playlist) return;
  playlist.videoFilenames = playlist.videoFilenames.filter(filename => filename !== video.filename);
  playlist.updatedAt = new Date().toISOString();
  saveUserPlaylists();
}

async function handleVideoPlaylistButton(video) {
  const selectedUserPlaylist = getUserPlaylistFromValue(selectedPlaylist);
  if (selectedUserPlaylist) {
    if (selectedUserPlaylist.videoFilenames.includes(video.filename)) {
      removeVideoFromUserPlaylist(video, selectedUserPlaylist);
    } else {
      addVideoToUserPlaylist(video, selectedUserPlaylist);
    }
    populatePlaylistOptions();
    renderVideoGrid();
    return;
  }

  const target = await chooseUserPlaylistForVideo(video);
  if (!target) return;
  addVideoToUserPlaylist(video, target);
  populatePlaylistOptions();
  renderVideoGrid();
}

function populatePlaylistOptions() {
  const playlistSelect = document.getElementById('playlistSelect');
  if (!playlistSelect || !Array.isArray(rawVideoData)) return;

  const previousValue = selectedPlaylist;
  playlistSelect.innerHTML = '<option value="all">All</option>';

  // Tags that should NOT appear as playlist options, these are for the filters
 const excluded = new Set(['mlp', "Dandy's World"]);

  const tagSet = new Set();

  rawVideoData.forEach(video => {
    if (Array.isArray(video.tags)) {
      video.tags.forEach(t => {
        if (!excluded.has(t)) tagSet.add(t);
      });
    }
  });

  const tagArray = Array.from(tagSet);

  const customOrder = [
    'SU Episodes',
    'MLP Episodes',
    "Dandy's World Episodes",
    'SU Lore Arc 1 (The Prophecy/The Boys)',
    'Obama Arc', 'Parodies', 'Zatch Bell', 'Holiday Special', 'Christmas',
    'Halloween', 'Thanksgiving', "Valentine's Day", '4th of July',
    "St. Patrick's Day", '9/11'
  ];

  tagArray.sort((a, b) => {
    const ai = customOrder.indexOf(a), bi = customOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });

  if (userPlaylists.length) {
    const userGroup = document.createElement('optgroup');
    userGroup.label = 'Your Playlists';
    userPlaylists
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .forEach(playlist => {
        const opt = document.createElement('option');
        opt.value = getUserPlaylistSelectValue(playlist);
        opt.textContent = `${playlist.name} (${playlist.videoFilenames.length})`;
        userGroup.appendChild(opt);
      });
    playlistSelect.appendChild(userGroup);
  }

  const builtinGroup = document.createElement('optgroup');
  builtinGroup.label = 'Built-in Playlists';
  tagArray.forEach(tag => {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    builtinGroup.appendChild(opt);
  });
  if (tagArray.length) playlistSelect.appendChild(builtinGroup);

  const hasPreviousValue = Array.from(playlistSelect.options).some(option => option.value === previousValue);
  selectedPlaylist = hasPreviousValue ? previousValue : 'all';
  playlistSelect.value = selectedPlaylist;
  updatePlaylistActionButtons();
}

function formatRuntime(seconds) {
  seconds = Number(seconds);
  if (!isFinite(seconds) || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
}

const videoGridVirtualState = {
  queueSet: new Set(),
  watchedProgress: {}
};

function getFilteredVideoGridItems() {
  const query = (document.getElementById('searchInput')?.value || '').toLowerCase();
  let videos = getVideosForPlaylistSelection(selectedPlaylist).filter(video =>
    String(video.title || '').toLowerCase().includes(query)
  );

  if (document.getElementById('favoritesToggle')?.checked) {
    videos = videos.filter(video => {
      const id = video.filename.split('/').pop().replace(/\.[^/.]+$/, '');
      return favorites.has(id);
    });
  }

  videos.sort((a, b) =>
    sortOrder === 'oldest'
      ? a.date.localeCompare(b.date)
      : b.date.localeCompare(a.date)
  );

  if (selectedPlaylist !== 'all') {
    return videos.filter(v =>
      isUserPlaylistValue(selectedPlaylist) || (Array.isArray(v.tags) && v.tags.includes(selectedPlaylist))
    );
  }

  const normalizeTag = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hasNormTag = (v, norm) => Array.isArray(v.tags) && v.tags.some(t => normalizeTag(t) === norm);
  const isMLP = (v) => hasNormTag(v, 'mlp');
  const isDandysWorld = (v) => hasNormTag(v, 'dandysworld');

  if (tagFilter === 'only-mlp') return videos.filter(isMLP);
  if (tagFilter === 'no-mlp') return videos.filter(v => !isMLP(v));
  if (tagFilter === 'only-dandys-world') return videos.filter(isDandysWorld);
  if (tagFilter === 'no-dandys-world') return videos.filter(v => !isDandysWorld(v));
  if (tagFilter === 'no-mlp-no-dandys-world') return videos.filter(v => !isMLP(v) && !isDandysWorld(v));
  if (tagFilter === 'only-mlp-dandys-world') return videos.filter(v => isMLP(v) || isDandysWorld(v));

  return videos;
}

function buildVideoThumbnail(video) {
  const baseName = video.filename.split('/').pop().replace(/\.[^/.]+$/, '');
  const hasChat = chatFiles.has(baseName);
  const div = document.createElement('div');
  div.className = 'video-thumbnail';
  div.dataset.filename = video.filename;

  const thumbnailContainer = document.createElement('div');
  thumbnailContainer.className = 'thumbnail-container';

  const img = document.createElement('img');
  img.alt = video.title || '';
  lazyLoadImage(img, video.thumbnail);
  thumbnailContainer.appendChild(img);

  if (hasChat && showBadges) {
    const badge = document.createElement('span');
    badge.className = 'chat-badge top-center';
    badge.textContent = 'LIVE CHAT AVAILABLE';
    thumbnailContainer.appendChild(badge);
  }

  const title = document.createElement('h3');
  title.textContent = video.title || '';

  const date = document.createElement('p');
  date.textContent = formatDate(video.date || '');

  div.append(thumbnailContainer, title, date);

  const star = document.createElement('span');
  star.className = 'favorite-star';
  star.textContent = '\u2605';
  if (favorites.has(baseName)) star.classList.add('favorited');
  star.onclick = (e) => {
    e.stopPropagation();
    if (favorites.has(baseName)) {
      favorites.delete(baseName);
      star.classList.remove('favorited');
    } else {
      favorites.add(baseName);
      star.classList.add('favorited');
    }
    localStorage.setItem('favorites', JSON.stringify([...favorites]));
    if (document.getElementById('favoritesToggle')?.checked) renderVideoGrid();
  };
  div.appendChild(star);

  const queueBtn = document.createElement('span');
  queueBtn.className = 'queue-btn';
  if (videoGridVirtualState.queueSet.has(video.filename)) {
    queueBtn.classList.add('queued');
    queueBtn.textContent = '\u23ed';
    queueBtn.title = 'Remove from queue';
  } else {
    queueBtn.textContent = '\u2795';
    queueBtn.title = 'Add to queue';
  }
  queueBtn.onclick = (e) => {
    e.stopPropagation();
    const queue = loadQueue();
    if (queue.includes(video.filename)) {
      removeFromQueue(video.filename);
      videoGridVirtualState.queueSet.delete(video.filename);
      queueBtn.classList.remove('queued');
      queueBtn.textContent = '\u2795';
      queueBtn.title = 'Add to queue';
    } else {
      addToQueue(video.filename);
      videoGridVirtualState.queueSet.add(video.filename);
      queueBtn.classList.add('queued');
      queueBtn.textContent = '\u23ed';
      queueBtn.title = 'Remove from queue';
    }
    renderQueue();
  };
  div.appendChild(queueBtn);

  const userPlaylist = getUserPlaylistFromValue(selectedPlaylist);
  const playlistBtn = document.createElement('span');
  playlistBtn.className = 'user-playlist-btn';
  if (userPlaylist?.videoFilenames.includes(video.filename)) {
    playlistBtn.classList.add('in-playlist');
    playlistBtn.textContent = 'P-';
    playlistBtn.title = `Remove from ${userPlaylist.name}`;
  } else {
    playlistBtn.textContent = 'P+';
    playlistBtn.title = userPlaylist ? `Add to ${userPlaylist.name}` : 'Add to one of your playlists';
  }
  playlistBtn.onclick = (e) => {
    e.stopPropagation();
    handleVideoPlaylistButton(video);
  };
  div.appendChild(playlistBtn);

  if (watchedVideos.has(baseName) && showWatched) {
    const check = document.createElement('span');
    check.className = 'watched-checkmark';
    check.textContent = '\u2714';
    thumbnailContainer.appendChild(check);
  }

  if (video.runtime) {
    const runtimeSpan = document.createElement('span');
    runtimeSpan.className = 'runtime-overlay';
    runtimeSpan.textContent = formatRuntime(video.runtime);
    thumbnailContainer.appendChild(runtimeSpan);
  }

  const watchedProgress = videoGridVirtualState.watchedProgress;
  if (watchedProgress[baseName] && watchedProgress[baseName].duration > 10) {
    const percent = Math.min(100, Math.round(
      100 * watchedProgress[baseName].current / watchedProgress[baseName].duration
    ));
    if (percent < 98) {
      const progressBar = document.createElement('div');
      progressBar.className = 'watched-progress-bar';
      progressBar.style.position = 'absolute';
      progressBar.style.left = 0;
      progressBar.style.bottom = 0;
      progressBar.style.height = '5px';
      progressBar.style.background = '#f00';
      progressBar.style.width = percent + '%';
      progressBar.style.zIndex = 2;
      progressBar.style.borderRadius = '0 0 8px 8px';
      progressBar.style.pointerEvents = 'none';
      thumbnailContainer.appendChild(progressBar);
    }
  }

  div.onclick = () => {
    const playlist = selectedPlaylist !== 'all'
      ? getVideosForPlaylistSelection(selectedPlaylist)
      : rawVideoData;
    const index = playlist.findIndex(v => v.filename === video.filename);
    showPlayer(video, playlist, index);
  };

  return div;
}

function renderVideoGrid() {
  const gridEl = document.getElementById('video-grid');
  if (!gridEl) return;

  gridEl.querySelectorAll('.video-thumbnail').forEach(stopThumbnailPreview);
  unobserveLazyImages(gridEl);
  videoGridVirtualState.queueSet = new Set(loadQueue());
  videoGridVirtualState.watchedProgress = loadWatchedProgress();

  const fragment = document.createDocumentFragment();
  getFilteredVideoGridItems().forEach(video => {
    fragment.appendChild(buildVideoThumbnail(video));
  });

  gridEl.style.paddingTop = '';
  gridEl.style.paddingBottom = '';
  gridEl.style.overflowAnchor = '';
  gridEl.replaceChildren(fragment);
  setupThumbnailPreviews(gridEl);
  loadVisibleLazyImages(gridEl);
  renderQueue();
}

function toggleGifExportUI() {
  const gifContainer = document.getElementById('gif-export-container');
  if (!gifContainer) return;
  if (gifContainer.style.display === 'none' || gifContainer.style.display === '') {
    // Show the container
    gifContainer.style.display = 'block';
    updateExportButtonState();
    showGifFramesEditor([]);
    stopPreviewGifFrames();
  } else {
    // Hide the container
    gifContainer.style.display = 'none';
    stopPreviewGifFrames();
  }
}

function hideClipExportUI() {
  if (clipExportContainer) {
    clipExportContainer.style.display = 'none';
    clipExportMP4Btn.disabled = true;
    clipExportWebMBtn.disabled = true;
    clipExportStatus.textContent = "";
  }
}

function updateChatPaneMetrics() {
  const layout = document.getElementById('player-layout');
  const videoBox = document.getElementById('video-fullscreen-container');
  if (!layout || !videoBox) return;

  const layoutRect = layout.getBoundingClientRect();
  const videoRect = videoBox.getBoundingClientRect();
  if (!layoutRect.height || !videoRect.height) return;

  layout.style.setProperty('--chat-offset-top', `${Math.max(0, videoRect.top - layoutRect.top)}px`);
  layout.style.setProperty('--chat-video-height', `${Math.round(videoRect.height)}px`);
  layout.style.setProperty('--player-video-width', `${Math.round(videoRect.width)}px`);
}

function scheduleChatPaneMetricsUpdate() {
  requestAnimationFrame(() => {
    updateChatPaneMetrics();
    requestAnimationFrame(updateChatPaneMetrics);
  });
}

window.addEventListener('resize', scheduleChatPaneMetricsUpdate, { passive: true });

function placeQueueInPlayerSidebar() {
  const sidebar = document.getElementById('chat-and-queue');
  const queueContainer = document.getElementById('playlist-queue-container');
  const chatPane = document.getElementById('chat-pane');
  if (!sidebar || !queueContainer) return;

  if (queueContainer.parentElement !== sidebar) {
    sidebar.appendChild(queueContainer);
  }
  queueContainer.style.marginTop = chatPane?.style.display === 'block' ? '16px' : '0';
}

function placeQueueInMainLayout() {
  const layout = document.getElementById('main-content-layout');
  const queueContainer = document.getElementById('playlist-queue-container');
  if (!layout || !queueContainer) return;

  if (queueContainer.parentElement !== layout) {
    layout.appendChild(queueContainer);
  }
  queueContainer.style.marginTop = '0';
}

function toggleVideoPlayback(player = window.player) {
  if (!player || !player.src) return;
  if (player.paused || player.ended) {
    player.play().catch(err => console.warn('Video play failed:', err));
  } else {
    player.pause();
  }
}

function isMiddleVideoClick(player, e) {
  if (!player || e.button !== 0) return false;
  const rect = player.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  return (
    x > rect.width * 0.2 &&
    x < rect.width * 0.8 &&
    y > rect.height * 0.2 &&
    y < rect.height * 0.8
  );
}

function setupPlayerClickHandlers(player) {
  if (!player) return;
  player.addEventListener('click', e => {
    if (!isMiddleVideoClick(player, e)) return;
    e.preventDefault();
    toggleVideoPlayback(player);
  });
  player.addEventListener('dblclick', e => {
    e.preventDefault();
  });
}

async function showPlayer(video, playlist = [], index = 0, autoplay = false) {
  const oldPlayer = document.getElementById('player-video');
  if (oldPlayer) {
    const parent = oldPlayer.parentElement;
    const newPlayer = oldPlayer.cloneNode(false);
    newPlayer.id = oldPlayer.id;
    newPlayer.className = oldPlayer.className;
    parent.replaceChild(newPlayer, oldPlayer);
    window.player = newPlayer;
  }

  const player = window.player;
  setupPlayerClickHandlers(player);
  placeQueueInPlayerSidebar();
  hideGifExportUI();
  currentPlaylistVideos = playlist.slice();
  currentPlaylistIndex = index;

  if (selectedPlaylist !== 'all') {
    originalPlaylistOrder = playlist.slice();
    isPlaylistShuffled = false;
    isPlaylistReversed = false;
    const shuffleBtn = document.getElementById('shuffle-playlist-btn');
    if (shuffleBtn) shuffleBtn.textContent = 'Shuffle';
    const reverseBtn = document.getElementById('reverse-playlist-btn');
    if (reverseBtn) reverseBtn.textContent = 'Reverse';
  } else {
    const queueFilenames = loadQueue();
    originalQueueOrder = queueFilenames.map(fn => rawVideoData.find(v => v.filename === fn)).filter(Boolean);
    isQueueShuffled = false;
    isQueueReversed = false;
    const shuffleBtn = document.getElementById('shuffle-playlist-btn');
    if (shuffleBtn) shuffleBtn.textContent = 'Shuffle';
    const reverseBtn = document.getElementById('reverse-playlist-btn');
    if (reverseBtn) reverseBtn.textContent = 'Reverse';
  }

  document.getElementById('video-grid').style.display = 'none';
  document.getElementById('video-player').style.display = 'block';
  document.getElementById('player-title').innerText = video.title;
  document.getElementById('player-description').innerText = video.description;
    document.getElementById('player-date').innerText = formatDate(video.date);
  currentVideoFilename = video.filename;
  currentPlaybackFilename = await resolveAvailableVideoFilename(video);
  currentAltVideo = null;
  commentsLoadToken++;
  const commentContainer = document.getElementById('comments-section');
  if (commentContainer) {
    commentContainer.style.display = 'block';
    commentContainer.innerHTML = '<h3>Comments</h3><p>Loading comments...</p>';
  }
  requestAnimationFrame(() => loadComments(video));

  history.scrollRestoration = 'manual';
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    const layout = document.getElementById('player-layout');
    if (layout) layout.scrollIntoView({ block: 'start' });
    const comments = document.getElementById('comments-section');
    if (comments) comments.scrollTop = 0;
    const chat = document.getElementById('chat-pane');
    if (chat) chat.scrollTop = 0;
  });

  document.getElementById('gif-btn').onclick = toggleGifExportUI;


  const subtitleSelector = document.getElementById('subtitleSelector');
  const subtitleLabel = document.getElementById('subtitle-label');

  player.src = "file://" + videoPath + "/" + currentPlaybackFilename;
  player.load();

  const baseName = video.filename.split('/').pop().replace(/\.[^/.]+$/, '');
  const watchedProgress = loadWatchedProgress();
  player.addEventListener('loadedmetadata', function restoreProgressOnce() {
    if (
      watchedProgress[baseName] &&
      watchedProgress[baseName].current > 0 &&
      watchedProgress[baseName].duration > 10 &&
      watchedProgress[baseName].current < (player.duration - 2)
    ) {
      player.currentTime = watchedProgress[baseName].current;
    }
    player.removeEventListener('loadedmetadata', restoreProgressOnce);
  });

  let savedSize = localStorage.getItem('videoSizeMode') || 'normal';
  player.className = savedSize;
  const sizeSelector = document.getElementById('sizeSelector');
  if (sizeSelector) sizeSelector.value = savedSize;
  scheduleChatPaneMetricsUpdate();
  player.volume = document.getElementById('volumeSlider').value;
  player.playbackRate = parseFloat(document.getElementById('speedSelector').value);

  player.onloadedmetadata = () => {
    if (autoplay) {
      player.play().catch(err => {
        console.warn("Autoplay failed:", err);
      });
    }
  };

  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    if (player.duration > 0 && player.currentTime > 0 && player.currentTime < player.duration - 2) {
      const progress = loadWatchedProgress();
      progress[baseName] = { current: player.currentTime, duration: player.duration };
      saveWatchedProgress(progress);
    }
  }, 4000);

  player.onpause = player.onseeked = () => {
    const progress = loadWatchedProgress();
    if (
      player.currentTime > 0 &&
      player.currentTime < player.duration - 2 &&
      player.duration > 10
    ) {
      progress[baseName] = { current: player.currentTime, duration: player.duration };
      saveWatchedProgress(progress);
    }
    if (player.currentTime < 2) {
      delete progress[baseName];
      saveWatchedProgress(progress);
    }
  };

  // === Subtitle track clearing ===
  const videoElem = player;
  const selector = subtitleSelector;
  const label = subtitleLabel;

  [...videoElem.querySelectorAll('track')].forEach(tr => {
    tr.src = '';
    tr.mode = 'disabled';
    tr.remove();
  });
  const newTrack = document.createElement('track');
  newTrack.id = 'video-subtitle';
  newTrack.kind = 'subtitles';
  newTrack.label = '';
  newTrack.srclang = '';
  videoElem.appendChild(newTrack);

  newTrack.mode = "disabled";
  selector.innerHTML = '<option value="">None</option>';
  selector.style.display = 'none';
  label.style.display = 'none';

  if (videoElem.textTracks && videoElem.textTracks.length) {
    for (let i = 0; i < videoElem.textTracks.length; ++i) {
      videoElem.textTracks[i].mode = 'disabled';
    }
  }

  const subInfo = subtitlesData[video.filename];
  if (subInfo) {
    for (const [lang] of Object.entries(subInfo)) {
      const opt = document.createElement('option');
      opt.value = lang;
      opt.textContent = lang;
      subtitleSelector.appendChild(opt);
    }
    subtitleSelector.style.display = 'inline-block';
    subtitleLabel.style.display = 'inline-block';
    subtitleSelector.onchange = () => {
      const lang = subtitleSelector.value;
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            changeSubtitle(lang);
          });
        });
      }, 100);
    };
  }

  // === Live Chat loading ===
  const chatPane = document.getElementById('chat-pane');
  const chatBox = document.getElementById('chat-messages');
  const toggleBtn = document.querySelector('button[onclick="toggleChat()"]');

  chatBox.innerHTML = "";
  chatPane.style.display = 'none';
  toggleBtn.style.display = 'none';
  chatData = [];
  renderCurrentChatWindow = null;
  let nextChatIndex = 0;
  let lastRenderedChatTime = 0;

  const chatFile = `chat/${video.filename.split('/').pop().replace(/\.[^/.]+$/, '')}.csv`;

  try {
    const res = await fetch(chatFile);
    if (!res.ok) throw new Error();
    const txt = await res.text();
    chatData = parseChatCsv(txt);

    const settings = await window.electronAPI.getSettings();
    const chatVisible = settings?.chatVisible !== false;

    chatPane.style.display = chatVisible ? 'block' : 'none';
    toggleBtn.style.display = 'inline-block';
    placeQueueInPlayerSidebar();
  } catch (e) {
    chatPane.style.display = 'none';
    toggleBtn.style.display = 'none';
    placeQueueInPlayerSidebar();
  }

  const isChatScrolledToBottom = () => {
    return chatPane.scrollHeight - chatPane.scrollTop - chatPane.clientHeight <= 8;
  };

  const appendChatRange = (startIndex, endIndex) => {
    if (endIndex <= startIndex) return false;
    const fragment = document.createDocumentFragment();
    for (let i = startIndex; i < endIndex; i++) {
      fragment.appendChild(createChatMessageElement(chatData[i]));
    }
    chatBox.appendChild(fragment);
    return true;
  };

  const resetChatToCurrentTime = () => {
    if (!chatData.length) return;
    const current = player.currentTime || 0;
    const endIndex = upperBoundChatTime(chatData, current);

    chatBox.textContent = '';
    appendChatRange(0, endIndex);
    nextChatIndex = endIndex;
    lastRenderedChatTime = current;
    chatPane.scrollTop = chatPane.scrollHeight;
  };

  const renderChatWindow = (force = false) => {
    if (!chatData.length) return;
    const current = player.currentTime || 0;

    if (chatPane.style.display === 'none') {
      chatBox.textContent = '';
      nextChatIndex = upperBoundChatTime(chatData, current);
      lastRenderedChatTime = current;
      return;
    }

    if (force || current + 0.25 < lastRenderedChatTime) {
      resetChatToCurrentTime();
      return;
    }

    const endIndex = upperBoundChatTime(chatData, current);
    const shouldFollowNewMessages = isChatScrolledToBottom();
    const appended = appendChatRange(nextChatIndex, endIndex);
    nextChatIndex = Math.max(nextChatIndex, endIndex);
    lastRenderedChatTime = current;

    if (appended && shouldFollowNewMessages) {
      chatPane.scrollTop = chatPane.scrollHeight;
    }
  };

  renderCurrentChatWindow = renderChatWindow;
  renderChatWindow(true);
  player.ontimeupdate = () => renderChatWindow();
  player.addEventListener('seeked', () => renderChatWindow(true));

  player.onended = () => {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = null;
    const base = video.filename.split('/').pop().replace(/\.[^/.]+$/, '');
    const progress = loadWatchedProgress();
    delete progress[base];
    saveWatchedProgress(progress);
    watchedVideos.add(base);
    localStorage.setItem('watched', JSON.stringify([...watchedVideos]));
    renderVideoGrid();

    if (selectedPlaylist !== 'all') {
      const nextIndex = currentPlaylistIndex + 1;
      if (nextIndex < currentPlaylistVideos.length) {
        showPlayer(currentPlaylistVideos[nextIndex], currentPlaylistVideos, nextIndex, true);
        return;
      }
    }

    if (selectedPlaylist === 'all') {
      const queue = loadQueue();
      const idx = queue.indexOf(video.filename);
      if (idx !== -1 && idx + 1 < queue.length) {
        const nextFile = queue[idx + 1];
        const nextVideo = rawVideoData.find(v => v.filename === nextFile);
        if (nextVideo) {
          showPlayer(nextVideo, [], 0, true);
        }
      }
    }
  };

  if (selectedPlaylist !== 'all') {
    renderPlaylistQueue();
  } else {
    renderQueue();
    const container = document.getElementById('playlist-queue-container');
    const queue = loadQueue();
    if (container) container.style.display = queue.length ? 'block' : 'none';
  }
}


function renderPlaylistQueue() {
  const wrap = document.getElementById('playlist-queue-container');
  const queueContainer = document.getElementById('playlist-queue');

  if (!wrap || !queueContainer || currentPlaylistVideos.length === 0) {
    if (wrap) wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'block';
  unobserveLazyImages(queueContainer);
  queueContainer.innerHTML = '';

  currentPlaylistVideos.forEach((vid, idx) => {
    const isCurrent = idx === currentPlaylistIndex;

    const div = document.createElement('div');
    div.className = 'queue-item' + (isCurrent ? ' current' : '');
    div.style.cursor = 'pointer';
    div.style.marginBottom = '8px';
    div.style.padding = '6px';
    div.style.borderRadius = '4px';
    div.style.background = isCurrent ? '#444' : '#222';

    const img = document.createElement('img');
    img.className = 'queue-thumb';
    img.alt = vid.title || 'Thumbnail';
    img.style.width = '80px';
    img.style.marginRight = '8px';
    img.style.verticalAlign = 'middle';
    lazyLoadImage(img, vid.thumbnail);

    const title = document.createElement('span');
    title.className = 'queue-title';
    title.style.verticalAlign = 'middle';
    title.textContent = vid.title;

    div.appendChild(img);
    div.appendChild(title);

    div.onclick = () => showPlayer(vid, currentPlaylistVideos, idx);

    queueContainer.appendChild(div);
  });
  loadVisibleLazyImages(queueContainer);
}


// --- Shuffle and Reverse for playlist queue ---

function shuffleArray(array) {
  let arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function updateShuffleButton(isShuffled) {
  const btn = document.getElementById('shuffle-playlist-btn');
  if (btn) btn.textContent = isShuffled ? 'Unshuffle' : 'Shuffle';
}
function updateReverseButton(isReversed) {
  const btn = document.getElementById('reverse-playlist-btn');
  if (btn) btn.textContent = isReversed ? 'Unreverse' : 'Reverse';
}
function handleShuffle(isSidebar = true) {
  if (selectedPlaylist !== 'all') {
    const currentVideo = currentPlaylistVideos[currentPlaylistIndex];
    if (!isPlaylistShuffled) {
      let otherVideos = (originalPlaylistOrder || []).filter(v => v && v.filename !== currentVideo.filename);
      let shuffled = shuffleArray(otherVideos);
      currentPlaylistVideos = [currentVideo, ...shuffled];
      isPlaylistShuffled = true;
      isPlaylistReversed = false;
      currentPlaylistIndex = 0;
    } else {
      currentPlaylistVideos = (originalPlaylistOrder || []).filter(Boolean);
      isPlaylistShuffled = false;
      isPlaylistReversed = false;
      const current = currentVideo.filename;
      currentPlaylistIndex = currentPlaylistVideos.findIndex(v => v && v.filename === current);
    }
    updateShuffleButton(isPlaylistShuffled);
    updateReverseButton(isPlaylistReversed);
    if (isSidebar) renderPlaylistQueue();
    else renderVideoGrid();
  } else {
    let queueFilenames = loadQueue().filter(Boolean);
    if (!queueFilenames.length) return;
    let queueVideos = queueFilenames.map(fn => rawVideoData.find(v => v.filename === fn)).filter(Boolean);
    const currentVideo = rawVideoData.find(v => v.filename === currentVideoFilename);
    let baseOrder = (originalQueueOrder && originalQueueOrder.length ? originalQueueOrder : queueVideos).filter(Boolean);
    if (!isQueueShuffled) {
      let otherVideos = baseOrder.filter(v => v.filename !== currentVideoFilename);
      let shuffled = shuffleArray(otherVideos);
      let shuffledVideos = [currentVideo, ...shuffled].filter(Boolean);
      let shuffledFilenames = shuffledVideos.map(v => v.filename);
      saveQueue(shuffledFilenames);
      isQueueShuffled = true;
      isQueueReversed = false;
      currentVideoFilename = shuffledFilenames[0];
    } else {
      let restored = (originalQueueOrder && originalQueueOrder.length ? originalQueueOrder : queueVideos).filter(Boolean);
      let restoredFilenames = restored.map(v => v.filename);
      saveQueue(restoredFilenames);
      isQueueShuffled = false;
      isQueueReversed = false;
    }
    updateShuffleButton(isQueueShuffled);
    updateReverseButton(isQueueReversed);
    if (isSidebar) renderQueue();
    else renderVideoGrid();
  }
}
function handleReverse(isSidebar = true) {
  if (selectedPlaylist !== 'all') {
    currentPlaylistVideos = currentPlaylistVideos.filter(Boolean).reverse();
    isPlaylistReversed = !isPlaylistReversed;
    isPlaylistShuffled = false;
    const current = currentVideoFilename;
    currentPlaylistIndex = currentPlaylistVideos.findIndex(v => v && v.filename === current);
    updateReverseButton(isPlaylistReversed);
    updateShuffleButton(isPlaylistShuffled);
    if (isSidebar) renderPlaylistQueue();
    else renderVideoGrid();
  } else {
    let queueFilenames = loadQueue().filter(Boolean);
    if (!queueFilenames.length) return;
    let queueVideos = queueFilenames.map(fn => rawVideoData.find(v => v.filename === fn)).filter(Boolean).reverse();
    saveQueue(queueVideos.map(v => v.filename));
    isQueueReversed = !isQueueReversed;
    isQueueShuffled = false;
    updateReverseButton(isQueueReversed);
    updateShuffleButton(isQueueShuffled);
    if (isSidebar) renderQueue();
    else renderVideoGrid();
  }
}

async function changeSubtitle(lang) {
  const video = window.player;
  const track = document.getElementById('video-subtitle');
  const currentTime = video.currentTime;
  const loadToken = ++subtitleLoadToken;

  clearAssSubtitle();
  if (track?.track) track.track.mode = 'disabled';

  const currentVideoTitle = document.getElementById('player-title').innerText;
  const videoEntry =
    rawVideoData.find(v => v.filename === currentVideoFilename) ||
    rawVideoData.find(v => v.title === currentVideoTitle);
  if (!videoEntry) return;
  if (!currentPlaybackFilename) currentPlaybackFilename = await resolveAvailableVideoFilename(videoEntry);

  const subInfo = subtitlesData[videoEntry.filename];

  if (!lang || !subInfo || !subInfo[lang]) {
    const playbackFilename = getCurrentPlaybackFilename();
    const shouldRestoreOriginalVideo = currentAltVideo && playbackFilename;
    if (currentAltVideo && playbackFilename) {
      video.src = "file://" + videoPath + "/" + playbackFilename;
      video.load();
      video.onloadedmetadata = () => {
        video.currentTime = currentTime;
        currentAltVideo = null;
      };
    }
    track.removeAttribute('src');
    if (track?.track) track.track.mode = 'disabled';
    if (!shouldRestoreOriginalVideo) return;
    return;
  }

  const entry = subInfo[lang];
  const subtitlePath = typeof entry === 'string' ? entry : entry.path;
  const altVideo = typeof entry === 'object' ? entry.altVideo : null;

  if (!currentVideoFilename) currentVideoFilename = videoEntry.filename;
  if (!currentPlaybackFilename) currentPlaybackFilename = await resolveAvailableVideoFilename(videoEntry);

  if (altVideo && altVideo !== currentAltVideo) {
    const altPath = `${videoPath}/${altVideo}`;
    fetch(`file://${altPath}`)
      .then(r => {
        if (r.ok) {
          video.src = "file://" + altPath;
          currentAltVideo = altVideo;
        } else {
          video.src = "file://" + videoPath + "/" + getCurrentPlaybackFilename();
          currentAltVideo = null;
        }
      })
      .catch(() => {
        video.src = "file://" + videoPath + "/" + getCurrentPlaybackFilename();
        currentAltVideo = null;
      })
      .finally(() => {
        video.load();
        video.onloadedmetadata = () => {
          video.currentTime = currentTime;
        };
      });
  } else if (currentAltVideo) {
    video.src = "file://" + videoPath + "/" + getCurrentPlaybackFilename();
    currentAltVideo = null;
    video.load();
    video.onloadedmetadata = () => {
      video.currentTime = currentTime;
    };
  }

  if (subtitlePath) {
    if (isAss(subtitlePath)) {
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            loadAssSubtitle(subtitlePath, video);
          });
        });
      }, 100);
    } else {
      try {
        await loadTextSubtitleTrack(track, subtitlePath, lang, loadToken);
      } catch (error) {
        console.warn("Subtitle could not be loaded:", error);
      }
    }
  }
}

function closePlayer() {
  commentsLoadToken++;
  renderCurrentChatWindow = null;
  currentVideoFilename = null;
  currentPlaybackFilename = null;
  currentAltVideo = null;
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  clearAssSubtitle();
  const player = window.player;
  const sizeSelector = document.getElementById('sizeSelector');
  let savedSize = localStorage.getItem('videoSizeMode') || 'normal';
  player.className = savedSize;
  if (sizeSelector) sizeSelector.value = savedSize;
  player.pause();
  player.currentTime = 0;
  player.src = "";
  document.getElementById('chat-messages').innerHTML = "";
  document.getElementById('video-player').style.display = 'none';
  document.getElementById('video-grid').style.display = 'grid';
  placeQueueInMainLayout();
  renderQueue();
  renderVideoGrid();
  hideGifExportUI(); 
  hideClipExportUI();
}

window.closePlayer = closePlayer;

function resizePlayer(mode) {
  document.getElementById('player-video').className = mode;
  localStorage.setItem('videoSizeMode', mode);
  scheduleChatPaneMetricsUpdate();
}
window.resizePlayer = resizePlayer;

function setVolume(v) {
  document.getElementById('player-video').volume = v;
}
window.setVolume = setVolume;

function setPlaybackSpeed(v) {
  const rate = parseFloat(v);
  if (!Number.isFinite(rate)) return;
  const player = document.getElementById('player-video');
  const selector = document.getElementById('speedSelector');
  if (player) player.playbackRate = rate;
  if (selector && Array.from(selector.options).some(option => Number(option.value) === rate)) {
    selector.value = String(rate);
  }
}
window.setPlaybackSpeed = setPlaybackSpeed;

window.toggleChat = toggleChat;

async function toggleChat() {
  const chatPane = document.getElementById('chat-pane');
  const showing = chatPane.style.display === 'block';
  const newDisplay = showing ? 'none' : 'block';
  chatPane.style.display = newDisplay;
  placeQueueInPlayerSidebar();
  if (!showing && typeof renderCurrentChatWindow === 'function') {
    renderCurrentChatWindow(true);
  }
  scheduleChatPaneMetricsUpdate();
  await window.electronAPI.setSetting('chatVisible', newDisplay === 'block');
}

function parseChatCsvLine(row) {
  return row
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(value => value.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
}

function parseChatCsv(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map(row => {
      const [timestamp, author, ...messageParts] = parseChatCsvLine(row);
      return {
        time: parseTimestamp(timestamp || ''),
        author,
        message: messageParts.join(',')
      };
    })
    .filter(m => Number.isFinite(m.time))
    .sort((a, b) => a.time - b.time);
}

function upperBoundChatTime(messages, target) {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].time <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function parseTimestamp(ts) {
  return ts.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
}

function createChatMessageElement(msg) {
  const row = document.createElement('div');
  row.className = 'chat-message';

  const author = document.createElement('strong');
  author.textContent = `${msg.author || ''}:`;
  row.append(author, ` ${msg.message || ''}`);

  return row;
}

function formatDate(d) {
  return d.length === 8
    ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`
    : d;
}

function seekFrame(video, direction) {
  if (!video || !Number.isFinite(video.duration)) return;
  const fps = 29.97;
  const step = 1 / fps;
  let next = video.currentTime + direction * step;
  next = Math.max(0, Math.min(video.duration, next));
  video.currentTime = next;
}

function isTypingInFormControl(e) {
  const target = e.target || document.activeElement;
  const tag = target?.tagName?.toLowerCase();
  return !!(target?.isContentEditable || ['input', 'textarea', 'select'].includes(tag));
}

function isVideoPlayerOpen() {
  const player = window.player;
  const playerContainer = document.getElementById('video-player');
  return !!(player && playerContainer && playerContainer.style.display !== 'none');
}

function shouldHandleVideoShortcutEvent(e) {
  if (!isVideoPlayerOpen()) return false;
  if (isTypingInFormControl(e)) return false;
  return !(e.ctrlKey || e.altKey || e.metaKey);
}

function getSpeedOptions() {
  const selector = document.getElementById('speedSelector');
  if (!selector) return [];
  return Array.from(selector.options)
    .map(option => Number(option.value))
    .filter(value => Number.isFinite(value));
}

function adjustPlaybackSpeedBySetting(direction) {
  const player = window.player || document.getElementById('player-video');
  const speeds = getSpeedOptions();
  if (!player || !speeds.length) return;

  const current = Number(player.playbackRate) || 1;
  let nextSpeed = current;
  if (direction > 0) {
    nextSpeed = speeds.find(speed => speed > current + 0.001) ?? speeds[speeds.length - 1];
  } else {
    nextSpeed = [...speeds].reverse().find(speed => speed < current - 0.001) ?? speeds[0];
  }

  setPlaybackSpeed(nextSpeed);
}

document.addEventListener('keydown', function(e) {
  if (!shouldHandleVideoShortcutEvent(e)) return;

  const key = getEventKeybindKey(e);
  if (key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) toggleVideoPlayback(window.player);
  } else if (key === ',' || key === '<') {
    e.preventDefault();
    seekFrame(window.player, -1);
  } else if (key === '.' || key === '>') {
    e.preventDefault();
    seekFrame(window.player, 1);
  } else if (key === currentKeybinds.screenshot) {
    e.preventDefault();
    if (!e.repeat) takeScreenshot();
  } else if (key === currentKeybinds.speedUp) {
    e.preventDefault();
    adjustPlaybackSpeedBySetting(1);
  } else if (key === currentKeybinds.speedDown) {
    e.preventDefault();
    adjustPlaybackSpeedBySetting(-1);
  }
}, true);

document.addEventListener('keyup', function(e) {
  if (!shouldHandleVideoShortcutEvent(e)) return;
  if (getEventKeybindKey(e) === ' ') {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderCreditsPage() {
  const creditsSection = document.getElementById('credits-section');

  let patreonDiv = document.getElementById('patreon-supporters');
  if (!patreonDiv) {
    patreonDiv = document.createElement('div');
    patreonDiv.id = 'patreon-supporters';
    creditsSection.prepend(patreonDiv);
  } else {
    patreonDiv.innerHTML = '';
  }

  let detailsDiv = document.getElementById('credits-details');
  if (!detailsDiv) {
    detailsDiv = document.createElement('div');
    detailsDiv.id = 'credits-details';
    patreonDiv.insertAdjacentElement('afterend', detailsDiv);
  } else if (detailsDiv.previousElementSibling !== patreonDiv) {
    patreonDiv.insertAdjacentElement('afterend', detailsDiv);
  }
  detailsDiv.innerHTML = '';

  let data = null;
try {
  const res = await fetch('data/credits.json');
  if (res.ok) {
    data = await res.json();
  }
} catch (e) {
  console.error("Failed to load credits.json", e);
}


  if (data) {
    // Patreon supporters
    const patreon = data.patreon || {};
    const patreonURL = patreon.url || 'https://www.patreon.com/TamersArchiver';
    const patreonMsg = patreon.message || 'Thank you to the following people for supporting this project:';
    const supporters = Array.isArray(patreon.supporters) ? patreon.supporters : [];

    patreonDiv.innerHTML = `
      <h2>Patreon Supporters</h2>
      <p>${escapeHtml(patreonMsg)} <a href="${patreonURL}" target="_blank" rel="noopener">Support on Patreon</a></p>
      <ul class="supporter-list">
        ${
          supporters.length
            ? supporters.map(n => `<li>${escapeHtml(n)}</li>`).join('')
            : '<li><em>Add supporter names in data/credits.json → patreon.supporters</em></li>'
        }
      </ul>
      <hr>
    `;

    // Build the rest of credits
    let html = '';
    if (data.creator) {
      html += `<h2 style="margin-bottom:0.25em;">${escapeHtml(data.creator)}</h2>`;
    }
    if (Array.isArray(data.creatorLinks) && data.creatorLinks.length) {
      html += `<div style="margin-bottom:1em;">` +
        data.creatorLinks.map(link =>
          `<a href="${link.url}" target="_blank" rel="noopener" style="margin-right: 10px; color:#4af;">${escapeHtml(link.label)}</a>`
        ).join('') +
        `</div>`;
    }
    html += `<h2>Credits</h2>`;

    if (data.collabHeader || data.pfpcollabheader) {
      html += `<p>${escapeHtml(data.collabHeader || data.pfpcollabheader)}</p>`;
    }
    if (Array.isArray(data.collabContributors) && data.collabContributors.length) {
      html += `<ul>`;
      for (const c of data.collabContributors) {
        html += `<li>`;
        if (c.link) {
          html += `<strong><a href="${c.link}" target="_blank" rel="noopener" style="color:#4af;text-decoration:underline;">${escapeHtml(c.name)}</a></strong>`;
        } else {
          html += `<strong>${escapeHtml(c.name)}</strong>`;
        }
        if (Array.isArray(c.pfp) && c.pfp.length) {
          html += `:<ul style="margin:0; padding-left: 1.5em; color:#7cf;">${c.pfp.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
        } else if (c.pfp) {
          html += `: <span style="color:#7cf;">${escapeHtml(c.pfp)}</span>`;
        }
        html += `</li>`;
      }
      html += `</ul>`;
    }

    if (data.subtitleheader || data.header) {
      html += `<p>${escapeHtml(data.subtitleheader || data.header)}</p>`;
    }
    if (Array.isArray(data.contributors) && data.contributors.length) {
      html += `<ul>`;
      for (const c of data.contributors) {
        if (c.link) {
          html += `<li><strong><a href="${c.link}" target="_blank" rel="noopener" style="color:#4af;text-decoration:underline;">${escapeHtml(c.name)}</a></strong>:<ul>`;
        } else {
          html += `<li><strong>${escapeHtml(c.name)}</strong>:<ul>`;
        }
        for (const w of c.works) {
          html += `<li>${escapeHtml(w.video)} <span style="color:#666;">(${escapeHtml(w.language)})</span></li>`;
        }
        html += `</ul></li>`;
      }
      html += `</ul>`;
    }

    html += `
      <div id="alt-video-explanation" style="margin:16px 0 6px 0;padding:10px 16px;background:#222;border-radius:6px;color:#f1f1f1;font-size:15px;">
        <strong>What are “Alt Videos”?</strong><br>
        <span style="color:#b7e;">Alt videos are alternate versions of some original videos—usually versions with on-screen translations. They are optional extras and are not required to watch the main archive. These files are large and are downloaded separately to save space.
                                  If an alt video is downloaded, it will automatically be swapped in when you select its corresponding subtitles in the video player. For example, choosing the Polish subtitles for "My Little Pony： Fluttershy's Hot Pot Party" will load "My Little Pony： Impreza Z Gorącymi Garnkami Fluttershy" (if you have it downloaded). Turning subtitles off will return you to the original video.
                                  If you do not have the alt video downloaded, the subtitles will simply display over the original video as normal.
        </span>
      </div>
      <div id="missing-alt-video-list" style="margin-top: 10px;"></div>
      <label><input type="checkbox" id="force-redownload"> Force Redownload</label><br>
      <button id="download-selected-alt-videos">Download Selected Alt Videos</button>
    `;
    detailsDiv.innerHTML = html;
  }

  // Missing-alt list render (safe)
  const missingListEl = document.getElementById('missing-alt-video-list');
  if (typeof renderMissingAltVideos === 'function') {
    await renderMissingAltVideos();
  } else if (missingListEl) {
    missingListEl.innerHTML = '';
  }

  // Download handler wiring (safe)
  const dlBtn = document.getElementById('download-selected-alt-videos');
  if (dlBtn && typeof downloadAltVideosHandler === 'function') {
    dlBtn.onclick = downloadAltVideosHandler;
  } else if (dlBtn) {
    dlBtn.style.display = 'none';
  }

  // External link handler for Electron
  if (creditsSection && !creditsSection._externalLinkHandlerSet) {
    creditsSection.addEventListener('click', function (event) {
      const a = event.target.closest('a[target="_blank"]');
      if (a && a.href.startsWith('http')) {
        event.preventDefault();
        window.electronAPI.openExternal(a.href);
      }
    });
    creditsSection._externalLinkHandlerSet = true;
  }
}



// === YouTube Posts Tab ===
async function initializePostsTab(force = false) {
  if (postsTabInitialized && !force) return;
  postsTabInitialized = true;

  initializePostsChannelTabs();
  setPostsFeedsMessage('Loading posts...', 'yt-posts-loading');

  if (!window.electronAPI || typeof window.electronAPI.readPostsData !== 'function') {
    setPostsFeedsMessage('Posts data source is unavailable.');
    return;
  }

  try {
    await loadPostOverrides();
    const items = await window.electronAPI.readPostsData();
    postsDataCache = Array.isArray(items) ? items : [];
    const ordered = await orderPostsByIndex(postsDataCache);
    postsDataCache = sortPostsByDate(ordered);
    renderPostsChannelFeeds();
  } catch (e) {
    console.error('Failed to load posts data:', e);
    setPostsFeedsMessage('Failed to load posts.');
  }
}

function initializePostsChannelTabs() {
  if (initializePostsChannelTabs._listenersAdded) {
    selectPostsChannel(activePostsChannelId);
    return;
  }

  POSTS_CHANNELS.forEach((channel, index) => {
    const tab = document.getElementById(channel.tabId);
    if (!tab) return;

    tab.addEventListener('click', () => selectPostsChannel(channel.id));
    tab.addEventListener('keydown', event => {
      let nextIndex = null;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % POSTS_CHANNELS.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + POSTS_CHANNELS.length) % POSTS_CHANNELS.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = POSTS_CHANNELS.length - 1;
      if (nextIndex == null) return;

      event.preventDefault();
      const nextChannel = POSTS_CHANNELS[nextIndex];
      selectPostsChannel(nextChannel.id, true);
    });
  });

  initializePostsChannelTabs._listenersAdded = true;
  selectPostsChannel(activePostsChannelId);
}

function selectPostsChannel(channelId, focusTab = false) {
  const selectedChannel = POSTS_CHANNELS.find(channel => channel.id === channelId);
  if (!selectedChannel) return;

  activePostsChannelId = selectedChannel.id;
  POSTS_CHANNELS.forEach(channel => {
    const isActive = channel.id === activePostsChannelId;
    const tab = document.getElementById(channel.tabId);
    const panel = document.getElementById(channel.panelId);

    if (tab) {
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    }
    if (panel) panel.hidden = !isActive;
  });

  if (focusTab) {
    const tab = document.getElementById(selectedChannel.tabId);
    if (tab) tab.focus();
  }
}

function setPostsFeedsMessage(message, className = 'yt-posts-empty') {
  POSTS_CHANNELS.forEach(channel => {
    const feed = document.getElementById(channel.feedId);
    if (feed) feed.innerHTML = `<div class="${className}">${escapeHtml(message)}</div>`;
  });
}

function renderPostsChannelFeeds() {
  POSTS_CHANNELS.forEach(channel => {
    const channelItems = postsDataCache.filter(item => item && item.channelId === channel.id);
    renderPostsFeed(channelItems, channel);
  });
}

async function orderPostsByIndex(items) {
  const byChannel = {};
  (items || []).forEach(item => {
    const channelId = item.channelId || 'unknown';
    if (!byChannel[channelId]) byChannel[channelId] = [];
    byChannel[channelId].push(item);
  });

  const ordered = [];
  for (const channelId of Object.keys(byChannel)) {
    const channelItems = byChannel[channelId];
    let orderIds = null;
    try {
      const res = await fetch(`posts/${channelId}/_index.json`);
      if (res.ok) {
        const idx = await res.json();
        if (Array.isArray(idx.posts)) {
          orderIds = idx.posts.map(p => p.id).filter(Boolean);
        }
      }
    } catch (e) {
      orderIds = null;
    }

    if (orderIds && orderIds.length) {
      const used = new Set();
      const byId = new Map(channelItems.map(item => [item.postId, item]));
      orderIds.forEach(id => {
        const match = byId.get(id);
        if (match) {
          ordered.push(match);
          used.add(match);
        }
      });
      channelItems.forEach(item => {
        if (!used.has(item)) ordered.push(item);
      });
    } else {
      ordered.push(...channelItems);
    }
  }

  return ordered;
}

function sortPostsByDate(items) {
  const enriched = (items || []).map((item, idx) => {
    const json = item && item.json ? item.json : null;
    const post = json && json.post ? json.post : {};
    const override = getPostOverride(item);
    const date = resolvePostDateValue(item, post, override);
    return { item, idx, date };
  });

  enriched.sort((a, b) => {
    if (a.date && b.date) return b.date - a.date; // newest first
    if (a.date) return -1;
    if (b.date) return 1;
    return a.idx - b.idx;
  });

  return enriched.map(entry => entry.item);
}

async function loadPostOverrides() {
  if (postOverrides) return;
  try {
    const res = await fetch('data/post_overrides.json');
    if (res.ok) {
      postOverrides = await res.json();
      await hydrateOverrideComments(postOverrides);
    } else {
      postOverrides = {};
    }
  } catch (e) {
    postOverrides = {};
  }
}

async function hydrateOverrideComments(overrides) {
  if (!overrides) return;
  const groups = [];
  if (overrides.byId) groups.push(overrides.byId);
  if (overrides.byFolder) groups.push(overrides.byFolder);

  const fetches = [];
  groups.forEach(group => {
    Object.keys(group).forEach(key => {
      const entry = group[key];
      if (entry && entry.commentsPath && !entry.comments) {
        fetches.push(
          fetch(entry.commentsPath)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
              if (data) entry.comments = data;
            })
            .catch(() => {})
        );
      }
    });
  });

  if (fetches.length) {
    await Promise.all(fetches);
  }
}

function getPostOverride(item) {
  if (!postOverrides || !item) return null;
  const byId = postOverrides.byId || {};
  const byFolder = postOverrides.byFolder || {};

  if (item.postId && byId[item.postId]) return byId[item.postId];

  if (item.channelId && item.folderName) {
    const combinedKey = `${item.channelId}::${item.folderName}`;
    if (byFolder[combinedKey]) return byFolder[combinedKey];
  }

  if (item.folderName && byFolder[item.folderName]) return byFolder[item.folderName];

  return null;
}

function formatAbsoluteDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date)) return String(value);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function parseRelativeDate(relativeText, anchorDate) {
  if (!relativeText || !anchorDate) return null;
  const rel = String(relativeText).toLowerCase().trim();
  const anchor = anchorDate instanceof Date ? new Date(anchorDate) : new Date(anchorDate);
  if (isNaN(anchor)) return null;

  if (rel === 'today') return anchor;
  if (rel === 'yesterday') {
    const d = new Date(anchor);
    d.setDate(d.getDate() - 1);
    return d;
  }

  const match = rel.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const d = new Date(anchor);

  switch (unit) {
    case 'second':
      d.setSeconds(d.getSeconds() - amount);
      break;
    case 'minute':
      d.setMinutes(d.getMinutes() - amount);
      break;
    case 'hour':
      d.setHours(d.getHours() - amount);
      break;
    case 'day':
      d.setDate(d.getDate() - amount);
      break;
    case 'week':
      d.setDate(d.getDate() - amount * 7);
      break;
    case 'month':
      d.setMonth(d.getMonth() - amount);
      break;
    case 'year':
      d.setFullYear(d.getFullYear() - amount);
      break;
    default:
      return null;
  }

  return d;
}

function resolvePostDate(item, post, override) {
  const dateValue = resolvePostDateValue(item, post, override);
  if (dateValue) return formatAbsoluteDate(dateValue);
  if (post && post.published) return String(post.published);
  return '';
}

function resolvePostDateValue(item, post, override) {
  if (override) {
    if (override.published_at) return new Date(override.published_at);
    if (override.published) return new Date(override.published);
  }

  const archivedAt = item && item.json ? item.json.archived_at : null;
  if (post && post.published && archivedAt) {
    const relativeDate = parseRelativeDate(post.published, archivedAt);
    if (relativeDate) return relativeDate;
  }

  if (archivedAt) return new Date(archivedAt);
  return null;
}

function renderPostsFeed(items, channel) {
  const feed = channel ? document.getElementById(channel.feedId) : null;
  if (!feed) return;

  if (!items || !items.length) {
    const channelLabel = channel && channel.label ? ` for ${channel.label}` : '';
    feed.innerHTML = `<div class="yt-posts-empty">No posts found${escapeHtml(channelLabel)}.</div>`;
    return;
  }

  const channelAuthors = buildChannelAuthorMap(items);
  feed.innerHTML = items.map((item, idx) => {
    const postDomKey = `${channel.domKey}-${idx}`;
    return buildPostCardHtml(item, postDomKey, channelAuthors, getPostOverride(item));
  }).join('');
}

function buildChannelAuthorMap(items) {
  const map = {};
  (items || []).forEach(item => {
    const name = item && item.json && item.json.post && item.json.post.author
      ? item.json.post.author.name
      : '';
    if (name && item.channelId && !map[item.channelId]) {
      map[item.channelId] = name;
    }
  });
  return map;
}

function buildPostCardHtml(item, index, channelAuthors, override) {
  const json = item && item.json ? item.json : null;
  const post = json && json.post ? json.post : {};

  const fallbackAuthor = channelAuthors && item && item.channelId && channelAuthors[item.channelId]
    ? channelAuthors[item.channelId]
    : 'Unknown';
  const authorName = post.author && post.author.name ? post.author.name : fallbackAuthor;
  const published = resolvePostDate(item, post, override);
  const contentText = override && override.content_text
    ? String(override.content_text)
    : (post.content_text || item.folderName || '');

  const authorDisplay = escapeHtml(authorName);
  const metaText = published ? `<div class="yt-post-meta">${escapeHtml(published)}</div>` : '';
  const contentHtml = formatPostText(contentText);

  const mediaFiles = Array.isArray(item.mediaFiles) ? item.mediaFiles : [];
  const split = splitMediaFiles(mediaFiles);
  const mediaHtml = split.regularFiles.length
    ? `<div class="yt-post-media">${split.regularFiles.map(file => {
        const isPreview = isLinkPreviewFile(file.filename);
        const className = isPreview ? 'yt-post-image yt-post-link-preview' : 'yt-post-image';
        return `<img class="${className}" src="${file.url}" alt="${escapeHtml(file.filename)}">`;
      }).join('')}</div>`
    : '';

  const pollData = json && json.attachment ? json.attachment.poll : null;
  const pollVoteCountText = (override && override.poll && override.poll.voteCountText != null)
    ? String(override.poll.voteCountText)
    : (pollData && (pollData.total_votes_text || pollData.totalVotesText)) || post.vote_count_text;

  const pollHtml = split.pollFiles.length
    ? buildPollHtml(split.pollFiles, pollData, pollVoteCountText, override && override.poll ? override.poll : null)
    : '';

  const commentsSource = (override && override.comments)
    ? override.comments
    : (json && json.comments ? json.comments : null);
  const commentsHtml = buildPostCommentsHtml(commentsSource, index, authorName);

  const avatar = getUploaderAvatar(authorName);

  return `
    <div class="yt-post-card">
      <div class="yt-post-header">
        <img class="yt-post-avatar" src="${avatar}" alt="Channel avatar">
        <div>
          <div class="yt-post-author">${authorDisplay}</div>
          ${metaText}
        </div>
      </div>
      <div class="yt-post-text">${contentHtml}</div>
      ${mediaHtml}
      ${pollHtml}
      ${commentsHtml}
    </div>
  `;
}

function splitMediaFiles(mediaFiles) {
  const pollFiles = [];
  const regularFiles = [];
  const optionRegex = /option\s*(\d+)/i;

  mediaFiles.forEach(file => {
    const match = file && file.filename ? file.filename.match(optionRegex) : null;
    if (match) {
      pollFiles.push({ ...file, optionIndex: parseInt(match[1], 10) || 0 });
    } else {
      regularFiles.push(file);
    }
  });

  pollFiles.sort((a, b) => (a.optionIndex || 0) - (b.optionIndex || 0));
  return { pollFiles, regularFiles };
}

function isLinkPreviewFile(filename) {
  if (!filename) return false;
  return /link preview/i.test(filename) || /attachment thumbnail/i.test(filename);
}

function buildPollHtml(pollFiles, pollData, voteCountText, overridePoll) {
  const optionCount = pollFiles.length;
  const pollOptions = extractPollOptions(pollData);
  const overridePercentages = overridePoll && Array.isArray(overridePoll.percentages)
    ? overridePoll.percentages
    : null;
  const percentages = getPollPercentages(optionCount, pollOptions, overridePercentages);

  const optionsHtml = pollFiles.map((file, idx) => {
    const percent = percentages[idx] != null ? percentages[idx] : 0;
    const optionLabel = `Option ${idx + 1}`;
    const optionText = pollOptions && pollOptions[idx] ? getOptionText(pollOptions[idx]) : '';
    const optionSub = optionText ? `<div class="yt-poll-option-sub">${formatPostText(optionText)}</div>` : '';
    return `
      <div class="yt-poll-option">
        <img src="${file.url}" alt="${escapeHtml(file.filename)}">
        <div class="yt-poll-option-body">
          <div class="yt-poll-option-title">${escapeHtml(optionLabel)}</div>
          ${optionSub}
          <div class="yt-poll-bar">
            <div class="yt-poll-bar-fill" style="width:${percent}%;"></div>
          </div>
          <div class="yt-poll-percent">${percent}%</div>
        </div>
      </div>
    `;
  }).join('');

  const votesLine = formatVotesLine(voteCountText);

  return `
    <div class="yt-poll">
      ${optionsHtml}
      <div class="yt-poll-votes">${votesLine}</div>
    </div>
  `;
}

function extractPollOptions(pollData) {
  if (!pollData || typeof pollData !== 'object') return null;
  if (Array.isArray(pollData.choices)) return pollData.choices;
  if (Array.isArray(pollData.options)) return pollData.options;
  if (Array.isArray(pollData.answers)) return pollData.answers;
  return null;
}

function getOptionText(option) {
  if (!option) return '';
  return option.text || option.label || option.title || option.name || '';
}

function getPollPercentages(optionCount, pollOptions, overridePercentages) {
  if (overridePercentages && overridePercentages.length) {
    const parsed = overridePercentages.map(val => parsePercentValue(val));
    if (parsed.every(p => typeof p === 'number' && !isNaN(p))) {
      return normalizePercentages(parsed, optionCount);
    }
  }

  if (pollOptions && pollOptions.length) {
    const percents = pollOptions.map(opt => parsePercentValue(
      opt.vote_percentage_number ??
      opt.vote_percentage_text ??
      opt.vote_percentage ??
      opt.votePercentage ??
      opt.percentage ??
      opt.percent ??
      opt.vote_ratio ??
      opt.voteRatio ??
      (opt.raw && (opt.raw.vote_percentage_if_selected || opt.raw.vote_percentage_if_not_selected)) ??
      (opt.raw && (opt.raw.vote_ratio_if_selected || opt.raw.vote_ratio_if_not_selected))
    ));
    if (percents.every(p => typeof p === 'number' && !isNaN(p))) {
      return normalizePercentages(percents, optionCount);
    }

    const counts = pollOptions.map(opt => parseCountValue(
      opt.vote_count || opt.voteCount || opt.votes || opt.vote
    ));
    if (counts.every(c => typeof c === 'number' && !isNaN(c))) {
      const total = counts.reduce((sum, val) => sum + val, 0);
      if (total > 0) {
        return normalizePercentages(counts.map(c => (c / total) * 100), optionCount);
      }
    }
  }

  return buildEvenPercentages(optionCount);
}

function formatVotesLine(value) {
  if (!value) return 'Votes unavailable';
  const text = String(value).trim();
  if (!text) return 'Votes unavailable';
  return /vote/i.test(text) ? escapeHtml(text) : `${escapeHtml(text)} votes`;
}

function parsePercentValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return value <= 1 ? value * 100 : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const num = parseFloat(raw.replace('%', ''));
  if (isNaN(num)) return null;
  return raw.includes('%') ? num : (num <= 1 ? num * 100 : num);
}

function parseCountValue(value) {
  if (value == null) return null;
  const raw = String(value).trim().replace(/,/g, '');
  const num = parseFloat(raw);
  return isNaN(num) ? null : num;
}

function normalizePercentages(values, optionCount) {
  const normalized = values.slice(0, optionCount).map(v => Math.max(0, v));
  const total = normalized.reduce((sum, val) => sum + val, 0);
  if (total === 0) return buildEvenPercentages(optionCount);
  return normalized.map(v => Math.round((v / total) * 100));
}

function buildEvenPercentages(count) {
  if (!count) return [];
  const base = Math.floor(100 / count);
  let remainder = 100 - base * count;
  const percents = Array(count).fill(base);
  for (let i = 0; i < percents.length && remainder > 0; i += 1) {
    percents[i] += 1;
    remainder -= 1;
  }
  return percents;
}

function buildPostCommentsHtml(commentsData, postIndex, uploaderAuthorName) {
  const threads = commentsData && Array.isArray(commentsData.threads) ? commentsData.threads : [];
  const commentBoxId = `post-comments-${postIndex}`;
  const toggleId = `post-comments-toggle-${postIndex}`;

  const header = `<h4>Comments</h4>`;
  const body = threads.length
    ? threads.map((thread, idx) => buildPostThreadHtml(thread, postIndex, idx, uploaderAuthorName)).join('')
    : `<div class="yt-posts-empty">No comments available.</div>`;

  return `
    <div class="yt-post-comments">
      ${header}
      <button id="${toggleId}" class="yt-post-comments-toggle" onclick="
        const box = document.getElementById('${commentBoxId}');
        if (!box) return;
        const isHidden = box.style.display === 'none';
        box.style.display = isHidden ? 'block' : 'none';
        this.textContent = isHidden ? 'Hide comments' : 'Show comments';
      ">Show comments</button>
      <div id="${commentBoxId}" style="display:none;">
        ${body}
      </div>
    </div>
  `;
}

function buildPostThreadHtml(thread, postIndex, threadIndex, uploaderAuthorName) {
  const top = thread && thread.top_level ? thread.top_level : {};
  const replies = thread && Array.isArray(thread.replies) ? thread.replies : [];

  const commentId = `post-${postIndex}-comment-${threadIndex}`;
  const avatar = getRandomCommentAvatar(top.author && top.author.name);
  const authorName = top.author && top.author.name ? top.author.name : 'Anonymous';
  const authorLabel = isUploaderName(authorName)
    ? '<span class="yt-uploader-label" style="font-size:12px;margin-left:4px;">Uploader</span>'
    : '';

  const likeText = top.like_count != null && String(top.like_count).trim()
    ? `<span class="comment-likes"><span class="like-emoji">&#128077;</span> ${escapeHtml(top.like_count)}</span>`
    : '';

  const pinned = top.is_pinned ? `<span class="yt-post-comment-pinned">Pinned</span>` : '';
  const hearted = top.is_hearted ? buildHeartBadge(uploaderAuthorName) : '';
  const published = top.published ? `<span class="comment-date">${escapeHtml(top.published)}</span>` : '';

  const repliesHtml = replies.length
    ? `
      <div class="replies" id="${commentId}-replies" style="display:none; margin-left: 50px;">
        ${replies.map(reply => buildReplyHtml(reply)).join('')}
      </div>
      <div class="reply-toggle" style="margin-left: 50px; margin-bottom: 10px;">
        <button class="show-replies-btn" onclick="
          document.getElementById('${commentId}-replies').style.display = 'block';
          this.style.display = 'none';
          document.getElementById('${commentId}-hide-btn').style.display = 'inline';
        ">
          Show ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}
        </button>
        <button id="${commentId}-hide-btn" class="hide-replies-btn" style="display: none;" onclick="
          document.getElementById('${commentId}-replies').style.display = 'none';
          this.style.display = 'none';
          this.previousElementSibling.style.display = 'inline';
        ">
          Hide replies
        </button>
      </div>
    `
    : '';

  return `
    <div class="comment">
      <img src="${avatar}" class="comment-avatar" alt="pfp">
      <div class="comment-content">
        <a href="#" onclick="return false;">
          ${escapeHtml(authorName)}${authorLabel}
        </a>
        <div class="comment-meta-row">
          ${published}
          ${likeText}
          ${pinned}
          ${hearted}
        </div>
        <p>${formatPostText(top.content || '')}</p>
      </div>
    </div>
    ${repliesHtml}
  `;
}

function buildReplyHtml(reply) {
  const avatar = getRandomCommentAvatar(reply && reply.author ? reply.author.name : '');
  const authorName = reply && reply.author && reply.author.name ? reply.author.name : 'Anonymous';
  const likeText = reply && reply.like_count != null && String(reply.like_count).trim()
    ? `<span class="comment-likes"><span class="like-emoji">&#128077;</span> ${escapeHtml(reply.like_count)}</span>`
    : '';
  const published = reply && reply.published ? `<span class="comment-date">${escapeHtml(reply.published)}</span>` : '';

  return `
    <div class="comment">
      <img src="${avatar}" class="comment-avatar" alt="pfp">
      <div class="comment-content">
        <a href="#" onclick="return false;">${escapeHtml(authorName)}</a>
        <div class="comment-meta-row">
          ${published}
          ${likeText}
        </div>
        <p>${formatPostText(reply.content || '')}</p>
      </div>
    </div>
  `;
}

function buildHeartBadge(uploaderAuthorName) {
  return `
    <span class="comment-favorited">
      <img class="uploader-fav-pfp" src="${getTamersProfilePicture(uploaderAuthorName)}" alt="Uploader">
      <span class="fav-heart">&#10084;&#65039;</span>
    </span>
  `;
}

function formatPostText(text) {
  return escapeHtml(text || '').replace(/\n/g, '<br>');
}

function getUploaderAvatar(authorName) {
  return getTamersProfilePicture(authorName);
}

function getRandomCommentAvatar(authorName) {
  if (isUploaderName(authorName)) return getTamersProfilePicture(authorName);
  return POSTS_PROFILE_PICS[Math.floor(Math.random() * POSTS_PROFILE_PICS.length)];
}

function getTamersProfilePicture(authorName) {
  const normalized = String(authorName || '').trim().toLowerCase().replace(/^@/, '');
  return normalized === 'tamersdandysworld'
    ? TAMERS_DANDYS_WORLD_PFP
    : TAMERS_PRIMARY_PFP;
}

function isUploaderName(name) {
  const normalized = String(name || '').trim().toLowerCase().replace(/^@/, '');
  return POSTS_UPLOADER_NAMES.has(normalized);
}

let settingsControlsInitialized = false;
const DEFAULT_KEYBINDS = {
  screenshot: 's',
  speedUp: ']',
  speedDown: '['
};
const KEYBIND_CONFIG = {
  screenshot: {
    displayId: 'keybind-screenshot-display',
    rebindButtonId: 'rebind-screenshot-key-btn',
    resetButtonId: 'reset-screenshot-key-btn'
  },
  speedUp: {
    displayId: 'keybind-speed-up-display',
    rebindButtonId: 'rebind-speed-up-key-btn',
    resetButtonId: 'reset-speed-up-key-btn'
  },
  speedDown: {
    displayId: 'keybind-speed-down-display',
    rebindButtonId: 'rebind-speed-down-key-btn',
    resetButtonId: 'reset-speed-down-key-btn'
  }
};
let currentKeybinds = { ...DEFAULT_KEYBINDS };
let activeKeybindCaptureCleanup = null;

function padTimePart(value) {
  return String(Math.max(0, Math.floor(value))).padStart(2, '0');
}

function normalizeKeybindKey(key) {
  if (typeof key !== 'string') return '';
  if (key === ' ') return ' ';
  return key.length === 1 ? key.toLowerCase() : key;
}

function getEventKeybindKey(e) {
  return normalizeKeybindKey(e.key);
}

function normalizeKeybinds(keybinds = {}) {
  const speedUp = normalizeKeybindKey(keybinds.speedUp);
  const speedDown = normalizeKeybindKey(keybinds.speedDown);
  const hasPreviousSpeedDefaults = speedUp === '.' && speedDown === ',';

  return {
    screenshot: normalizeKeybindKey(keybinds.screenshot) || DEFAULT_KEYBINDS.screenshot,
    speedUp: hasPreviousSpeedDefaults ? DEFAULT_KEYBINDS.speedUp : (speedUp || DEFAULT_KEYBINDS.speedUp),
    speedDown: hasPreviousSpeedDefaults ? DEFAULT_KEYBINDS.speedDown : (speedDown || DEFAULT_KEYBINDS.speedDown)
  };
}

function formatKeybindLabel(key) {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function setKeybindButtonCaptureState(action, isCapturing) {
  const button = document.getElementById(KEYBIND_CONFIG[action]?.rebindButtonId);
  if (!button) return;
  button.textContent = isCapturing ? 'Press a key...' : 'Change Key';
}

function renderKeybindDisplays() {
  Object.entries(KEYBIND_CONFIG).forEach(([action, config]) => {
    const display = document.getElementById(config.displayId);
    if (display) display.textContent = formatKeybindLabel(currentKeybinds[action]);
  });
}

async function saveCurrentKeybinds() {
  currentKeybinds = normalizeKeybinds(currentKeybinds);
  await window.electronAPI.setSetting('keybinds', currentKeybinds);
  renderKeybindDisplays();
}

function stopActiveKeybindCapture() {
  if (activeKeybindCaptureCleanup) {
    activeKeybindCaptureCleanup();
    activeKeybindCaptureCleanup = null;
  }
}

function beginKeybindCapture(action) {
  stopActiveKeybindCapture();
  setKeybindButtonCaptureState(action, true);

  const handler = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const key = getEventKeybindKey(e);
    if (e.key === 'Escape') {
      stopActiveKeybindCapture();
      return;
    }

    if (!key || ['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return;

    currentKeybinds[action] = key;
    stopActiveKeybindCapture();
    await saveCurrentKeybinds();
  };

  document.addEventListener('keydown', handler, true);
  activeKeybindCaptureCleanup = () => {
    document.removeEventListener('keydown', handler, true);
    setKeybindButtonCaptureState(action, false);
  };
}

function formatVideoTimestamp(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${padTimePart(hours)}-${padTimePart(minutes)}-${padTimePart(secs)}`;
}

function formatSystemTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    padTimePart(date.getMonth() + 1),
    padTimePart(date.getDate())
  ].join('-') + '_' + [
    padTimePart(date.getHours()),
    padTimePart(date.getMinutes()),
    padTimePart(date.getSeconds())
  ].join('-');
}

function sanitizeFilenamePart(value) {
  return String(value || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || 'video';
}

function getCurrentVideoNameForScreenshot() {
  const title = document.getElementById('player-title')?.innerText;
  if (title && title.trim()) return title.trim();
  if (currentVideoFilename) {
    return currentVideoFilename.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
  }
  return 'video';
}

function getScreenshotFilename(player) {
  return `${sanitizeFilenamePart(getCurrentVideoNameForScreenshot())}-${formatVideoTimestamp(player?.currentTime)}-${formatSystemTimestamp()}.png`;
}

async function renderSettingsControls(settingsOverride = null) {
  const settings = settingsOverride || await window.electronAPI.getSettings();
  const downloadsPath = await window.electronAPI.getDownloadsPath();
  const currentVideoFolder = document.getElementById('current-video-folder');
  const screenshotFolderDisplay = document.getElementById('screenshot-folder-display');
  const screenshotPromptToggle = document.getElementById('screenshot-prompt-toggle');
  currentKeybinds = normalizeKeybinds(settings?.keybinds);

  if (currentVideoFolder) {
    currentVideoFolder.textContent = videoPath || settings?.videoPath || 'Not selected';
  }

  if (screenshotFolderDisplay) {
    screenshotFolderDisplay.textContent = settings?.screenshotFolder || `${downloadsPath} (default)`;
  }

  if (screenshotPromptToggle) {
    screenshotPromptToggle.checked = !!settings?.screenshotPromptEachTime;
  }

  renderKeybindDisplays();
}

async function initializeSettingsControls(initialSettings) {
  if (!settingsControlsInitialized) {
    const changeFolderBtn = document.getElementById('change-folder-btn');
    const changeScreenshotFolderBtn = document.getElementById('change-screenshot-folder-btn');
    const resetScreenshotFolderBtn = document.getElementById('reset-screenshot-folder-btn');
    const screenshotPromptToggle = document.getElementById('screenshot-prompt-toggle');

    if (changeFolderBtn) {
      changeFolderBtn.addEventListener('click', async () => {
        const p = await window.electronAPI.selectVideoFolder();
        if (p) {
          videoPath = p.replace(/\\\\/g, '/');
          localStorage.setItem('videoPath', videoPath);
          await renderSettingsControls();
          location.reload();
        }
      });
    }

    if (changeScreenshotFolderBtn) {
      changeScreenshotFolderBtn.addEventListener('click', async () => {
        const settings = await window.electronAPI.getSettings();
        const downloadsPath = await window.electronAPI.getDownloadsPath();
        const p = await window.electronAPI.selectScreenshotFolder(settings?.screenshotFolder || downloadsPath);
        if (p) await renderSettingsControls();
      });
    }

    if (resetScreenshotFolderBtn) {
      resetScreenshotFolderBtn.addEventListener('click', async () => {
        await window.electronAPI.setSetting('screenshotFolder', '');
        await renderSettingsControls();
      });
    }

    if (screenshotPromptToggle) {
      screenshotPromptToggle.addEventListener('change', async () => {
        await window.electronAPI.setSetting('screenshotPromptEachTime', screenshotPromptToggle.checked);
      });
    }

    Object.entries(KEYBIND_CONFIG).forEach(([action, config]) => {
      const rebindButton = document.getElementById(config.rebindButtonId);
      const resetButton = document.getElementById(config.resetButtonId);

      if (rebindButton) {
        rebindButton.addEventListener('click', () => beginKeybindCapture(action));
      }

      if (resetButton) {
        resetButton.addEventListener('click', async () => {
          currentKeybinds[action] = DEFAULT_KEYBINDS[action];
          await saveCurrentKeybinds();
        });
      }
    });

    settingsControlsInitialized = true;
  }

  await renderSettingsControls(initialSettings);
}

async function takeScreenshot() {
  const player = window.player || document.getElementById('player-video');
  if (!player || !player.videoWidth || !player.videoHeight) {
    alert('No video frame is available to screenshot yet.');
    return;
  }

  const screenshotBtn = document.getElementById('screenshot-btn');
  const defaultButtonText = screenshotBtn?.dataset.defaultText || screenshotBtn?.textContent || 'Screenshot';
  if (screenshotBtn) {
    screenshotBtn.dataset.defaultText = defaultButtonText;
    screenshotBtn.disabled = true;
    screenshotBtn.textContent = 'Saving...';
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = player.videoWidth;
    canvas.height = player.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(player, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create screenshot image.');

    const pngData = await blob.arrayBuffer();
    const result = await window.electronAPI.saveScreenshot({
      filename: getScreenshotFilename(player),
      pngData
    });

    if (screenshotBtn) {
      screenshotBtn.textContent = result?.canceled ? 'Cancelled' : 'Saved';
      setTimeout(() => {
        screenshotBtn.textContent = defaultButtonText;
      }, 1400);
    }
  } catch (e) {
    console.error('Screenshot failed:', e);
    alert('Failed to save screenshot: ' + (e?.message || e));
    if (screenshotBtn) screenshotBtn.textContent = defaultButtonText;
  } finally {
    if (screenshotBtn) screenshotBtn.disabled = false;
  }
}

// === Startup & tab-switching ===
document.addEventListener('DOMContentLoaded', async () => {
  getDebugOverlay();

  if (window.SubtitlesOctopus && !window._octopusDebugPatched) {
    try { patchSubtitlesOctopusDebug(); } catch (e) {}
  }

  const settings = await window.electronAPI.getSettings();
  await initializeSettingsControls(settings);
  if (settings && settings.videoPath) {
    videoPath = settings.videoPath.replace(/\\\\/g, '/');
    document.getElementById('startup-screen').style.display = 'none';
    document.getElementById('app-content').style.display = 'block';
    initializeYouTubeTab().catch(e => console.error('Failed to initialize YouTube tab:', e));
  } else {
    document.getElementById('startup-screen').style.display = 'block';
    document.getElementById('app-content').style.display = 'none';
    document.getElementById('select-folder').onclick = async () => {
      const p = await window.electronAPI.selectVideoFolder();
      if (p) {
        videoPath = p.replace(/\\\\/g, '/');
        document.getElementById('startup-screen').style.display = 'none';
        document.getElementById('app-content').style.display = 'block';
        await renderSettingsControls();
        initializeYouTubeTab().catch(e => console.error('Failed to initialize YouTube tab:', e));
      }
    };
  }

  document.getElementById('screenshot-btn')?.addEventListener('click', takeScreenshot);

// === Fullscreen button ===
const fsBtn = document.getElementById('fullscreen-btn');
const fsContainer = document.getElementById('video-fullscreen-container');

if (fsBtn) {
  fsBtn.onclick = () => {
    // Toggle fullscreen on the container div, not just the video!
    if (document.fullscreenElement === fsContainer) {
      document.exitFullscreen();
    } else {
      fsContainer.requestFullscreen();
    }
  };
}

// --- fullscreenchange handler for ASS subtitles ---
document.addEventListener('fullscreenchange', () => {
  // Resize subtitles on any fullscreen change, after layout!
  setTimeout(() => {
    if (assRenderer && typeof assRenderer.resize === 'function') {
      assRenderer.resize();
      console.log("SubtitlesOctopus: called resize() on fullscreenchange");
    }
  }, 100);
});



  // === Tab switching ===
  const ytBtn = document.getElementById('tab-youtube');
  const postsBtn = document.getElementById('tab-youtube-posts');
  const daBtn = document.getElementById('tab-deviantart');
  const tu1Btn = document.getElementById('tab-tumblr');
  const tu2Btn = document.getElementById('tab-tumblr2');
  const creditsBtn = document.getElementById('tab-credits');
  const settingsBtn = document.getElementById('tab-settings');
  const startup = document.getElementById('startup-screen');
  const ytSec = document.getElementById('app-content');
  const postsSec = document.getElementById('youtube-posts-section');
  const daSec = document.getElementById('deviantart-section');
  const tu1Sec = document.getElementById('tumblr-section');
  const tu2Sec = document.getElementById('tumblr2-section');
  const creditsSec = document.getElementById('credits-section');
  const settingsSec = document.getElementById('settings-section');

  function resetYouTubePlaylistState() {
    chatData = [];
    currentPlaylistVideos = [];
    currentPlaylistIndex = 0;
    originalPlaylistOrder = [];
    isPlaylistShuffled = false;
    isPlaylistReversed = false;
    originalQueueOrder = [];
    isQueueShuffled = false;
    isQueueReversed = false;
    currentVideoFilename = null;
    currentPlaybackFilename = null;
    currentAltVideo = null;
  }

  function showSection(name) {
    if (typeof stopMusic === 'function' && name !== 'deviantart') stopMusic();
    [startup, ytSec, postsSec, daSec, tu1Sec, tu2Sec, creditsSec, settingsSec].forEach(s => { if (s) s.style.display = 'none'; });
    [ytBtn, postsBtn, daBtn, tu1Btn, tu2Btn, creditsBtn, settingsBtn].forEach(b => b && b.classList.remove('active'));

    if (name === 'youtube') {
      ytSec.style.display = 'block';
      ytBtn.classList.add('active');
      initializeYouTubeTab().catch(e => console.error('Failed to initialize YouTube tab:', e));
    } else if (name === 'posts') {
      postsSec.style.display = 'block';
      postsBtn.classList.add('active');
      initializePostsTab().catch(e => console.error('Failed to initialize posts tab:', e));
    } else if (name === 'deviantart') {
      daSec.style.display = 'block';
      daBtn.classList.add('active');
      if (typeof initDeviantArt === 'function') initDeviantArt();
    } else if (name === 'tumblr') {
      tu1Sec.style.display = 'block';
      tu1Btn.classList.add('active');
      if (typeof initTumblr1 === 'function') initTumblr1();
    } else if (name === 'tumblr2') {
      tu2Sec.style.display = 'block';
      tu2Btn.classList.add('active');
      if (typeof initTumblr2 === 'function') initTumblr2();
    } else if (name === 'credits') {
      creditsSec.style.display = 'block';
      creditsBtn.classList.add('active');
      renderCreditsPage().catch(e => console.error('Failed to render credits page:', e));
    } else if (name === 'settings') {
      settingsSec.style.display = 'block';
      settingsBtn.classList.add('active');
      renderSettingsControls();
    }
  }

  ytBtn.addEventListener('click', () => showSection('youtube'));
  postsBtn.addEventListener('click', () => showSection('posts'));
  daBtn.addEventListener('click', () => showSection('deviantart'));
  tu1Btn.addEventListener('click', () => showSection('tumblr'));
  tu2Btn.addEventListener('click', () => showSection('tumblr2'));
  creditsBtn.addEventListener('click', () => showSection('credits'));
  settingsBtn.addEventListener('click', () => showSection('settings'));

  showSection('youtube');
  window.player = document.getElementById('player-video');
  window.showPlayer = showPlayer;
});
