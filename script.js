// === Global State ===
let chatFiles = new Set();
let showBadges = true;
let sortOrder = 'newest';
let tagFilter = 'all';
let selectedPlaylist = 'all';
let rawVideoData = [];
let videoPath = "";
let favorites = new Set(JSON.parse(localStorage.getItem('favorites') || '[]'));
let subtitlesData = {};
let assRenderer = null;
let currentBlobUrl = null;
let watchedVideos = new Set(JSON.parse(localStorage.getItem('watched') || '[]'));
let showWatched = true;
let progressInterval = null;

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
let currentAltVideo = null;

// === YouTube Tab Initialization Flag ===
let youtubeTabInitialized = false;

// === Mini Preview Functions ===


function setupThumbnailPreviews() {
  document.querySelectorAll('.video-thumbnail').forEach(thumb => {
    const container = thumb.querySelector('.thumbnail-container');
    const img = container.querySelector('img');
    const filename = (thumb.dataset.filename || "").trim() || getFilenameFromThumb(thumb);
    if (!container || !img || !filename) return;

    let previewVideo = null;

    thumb.addEventListener('mouseenter', () => {
      if (previewVideo) return;
      previewVideo = document.createElement('video');
      previewVideo.className = 'thumbnail-preview-video';
      previewVideo.muted = true;
      previewVideo.playsInline = true;
      previewVideo.loop = false;
      previewVideo.preload = 'auto';
      previewVideo.src = "file://" + videoPath + "/" + filename;
      previewVideo.style.display = 'none';

      previewVideo.addEventListener('loadedmetadata', () => {
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
      container.appendChild(previewVideo);
    });

    thumb.addEventListener('mouseleave', () => {
      if (previewVideo) {
        previewVideo.pause();
        previewVideo.remove();
        previewVideo = null;
      }
      img.style.opacity = 1;
    });
  });
}

// Helper for thumbnails: derive .mp4 from thumbnail image name
function getFilenameFromThumb(thumb) {
  const img = thumb.querySelector('img');
  if (!img) return "";
  const src = img.src.split('/').pop();
  return src.replace(/\.(png|jpg|jpeg|webp)$/i, ".mp4");
}

// === YouTube Tab Initialization Function ===
async function initializeYouTubeTab(force = false) {
  // Prevent duplicate event listeners and redundant state setup
  if (youtubeTabInitialized && !force) return;
  youtubeTabInitialized = true;

  await loadChatFiles();
  await loadAltVideoURLs();

  const res = await fetch('data/videos.json');
  rawVideoData = await res.json();

  try {
    const subs = await fetch('data/subtitles.json');
    subtitlesData = await subs.json();
  } catch (e) {
    console.warn("Could not load data/subtitles.json");
  }

  populatePlaylistOptions();
  renderVideoGrid();

  // === Set up all YouTube grid/queue/filter controls, but only once ===
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
        renderVideoGrid();
      });
    }

    const playlistSelect = document.getElementById('playlistSelect');
    if (playlistSelect) {
      playlistSelect.addEventListener('change', e => {
        selectedPlaylist = e.target.value;
        renderVideoGrid();
        if (selectedPlaylist === 'all') {
          renderQueue();
        }
      });
    }

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

    // Shuffle/reverse (grid, if you have them)
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
      if (confirm(`You’re missing ${missing.length} videos. Download them now?`)) {
        try {
          await window.electronAPI.downloadVideos(missing);
          alert('All missing videos have been downloaded!');
        } catch (e) {
          alert('Failed to download videos: ' + e.message);
        }
      }
    }
    initializeYouTubeTab._missingCheckDone = true;
  }

  renderQueue();
}

function getDebugOverlay() {
  return null;
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
    item.innerHTML = `
      <img class="queue-thumb" src="${video.thumbnail}">
      <span class="queue-title">${video.title}</span>
      <button class="remove-queue-btn">✕</button>
    `;

    item.onclick = (e) => {
      if (e.target.classList.contains('remove-queue-btn')) return;
      const queue = loadQueue();
      const idx = queue.indexOf(video.filename);
      const videos = queue.map(f => rawVideoData.find(v => v.filename === f)).filter(Boolean);
      showPlayer(video, videos, idx);
    };

    item.querySelector('.remove-queue-btn').onclick = (ev) => {
      ev.stopPropagation();
      removeFromQueue(video.filename);
    };

    queueDiv.appendChild(item);
  });
  document.getElementById('playlist-queue-container').style.display = queue.length ? 'block' : 'none';
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

function showMainDownloadProgress(status, percent, received, total) {
  const bar = document.getElementById('main-download-bar');
  const wrap = document.getElementById('main-download-progress');
  const label = document.getElementById('main-download-label');
  const statusDiv = document.getElementById('main-download-status');
  if (!wrap || !bar || !label || !statusDiv) return;
  wrap.style.display = 'block';
  bar.style.width = percent ? Math.round(percent) + '%' : '0%';
  statusDiv.textContent = status;
  label.textContent = `${formatBytes(received || 0)} / ${formatBytes(total || 0)}` +
    (percent ? ` (${Math.round(percent)}%)` : '');
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
  showMainDownloadProgress(
    `Downloading video: ${data.filename || ''}`,
    data.percent,
    data.received,
    data.total
  );
  if (data.percent >= 100) setTimeout(hideMainDownloadProgress, 2000);
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

async function loadComments(video) {
  const safeFilename = video.filename.replace(/\.mp4$/, '.json');
  const commentContainer = document.getElementById('comments-section');
  commentContainer.innerHTML = '';
  commentContainer.style.display = 'none';

  const profilePics = [
    'PFPs/pfp1.png',
    'PFPs/pfp2.png',
    'PFPs/pfp3.png',
    'PFPs/pfp4.png',
    'PFPs/pfp5.png',
    'PFPs/pfp6.png',
    'PFPs/pfp7.png',
    'PFPs/pfp8.png',
    'PFPs/pfp9.png',
    'PFPs/pfp10.png'
  ];

  try {
    const res = await fetch(`comments/${safeFilename}`);
    if (!res.ok) throw new Error('No comments file');
    const comments = await res.json();

    if (comments.length > 0) {
      commentContainer.style.display = 'block';
      commentContainer.innerHTML = `<h3>Comments</h3>` + comments.map((comment, index) => {
        const randomPic = profilePics[Math.floor(Math.random() * profilePics.length)];
        const commentId = `comment-${index}`;

        let repliesHTML = '';
        if (Array.isArray(comment.replies) && comment.replies.length > 0) {
          repliesHTML = `
            <div class="replies" id="${commentId}-replies" style="display:none; margin-left: 50px;">
              ${comment.replies.map(reply => {
                const replyPic = profilePics[Math.floor(Math.random() * profilePics.length)];
                return `
                  <div class="comment">
                    <img src="${replyPic}" class="comment-avatar" alt="pfp">
                    <div class="comment-content">
                      <a href="${reply.author_url}" target="_blank">${reply.author}</a>
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
            <img src="${randomPic}" class="comment-avatar" alt="pfp">
            <div class="comment-content">
              <a href="#" onclick="window.electronAPI.openExternal('${comment.author_url}'); return false;">
                ${comment.author}
              </a>
              <p>${comment.text}</p>
            </div>
          </div>
          ${repliesHTML}
        `;
      }).join('');
    }
  } catch (e) {
    // silently fail
  }
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

function isAss(path) {
  return path.toLowerCase().endsWith('.ass');
}
function clearAssSubtitle() {
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
    const response = await fetch(subtitlePath);
    if (!response.ok) throw new Error(`Failed to fetch subtitle file: ${subtitlePath}`);
    const assText = await response.text();
    assRenderer = new SubtitlesOctopus({
      video: videoElement,
      subContent: assText,
      workerUrl: window.SubtitlesOctopusWorkerUrl,
      legacyWorkerUrl: window.SubtitlesOctopusWorkerUrl
    });
  } catch (e) {
    console.error("❌ Failed to load .ass subtitle:", e);
  }
}

// === Playlist UI / Filtering / Rendering ===

function populatePlaylistOptions() {
  const playlistSelect = document.getElementById('playlistSelect');
  if (!playlistSelect || !Array.isArray(rawVideoData)) return;
  playlistSelect.innerHTML = '<option value="all">All</option>';
  const tagSet = new Set();
  rawVideoData.forEach(video => {
    if (Array.isArray(video.tags)) {
      video.tags.forEach(t => {
        if (t !== 'mlp') tagSet.add(t);
      });
    }
  });
  const tagArray = Array.from(tagSet);
  const customOrder = [
    'SU Episodes', 'MLP Episodes', 'SU Lore Arc 1 (The Prophecy/The Boys)',
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
  tagArray.forEach(tag => {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    playlistSelect.appendChild(opt);
  });
}

function renderVideoGrid() {
  const grid = document.getElementById('video-grid');
  grid.innerHTML = '';

  const query = (document.getElementById('searchInput')?.value || '').toLowerCase();
  let videos = rawVideoData.filter(video =>
    video.title.toLowerCase().includes(query)
  );

  if (document.getElementById('favoritesToggle').checked) {
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
    videos = videos.filter(v =>
      Array.isArray(v.tags) && v.tags.includes(selectedPlaylist)
    );
  } else {
    if (tagFilter === 'only-mlp') {
      videos = videos.filter(v => Array.isArray(v.tags) && v.tags.includes('mlp'));
    } else if (tagFilter === 'no-mlp') {
      videos = videos.filter(v => !(Array.isArray(v.tags) && v.tags.includes('mlp')));
    }
  }

  videos.forEach(video => {
    const baseName = video.filename.split('/').pop().replace(/\.[^/.]+$/, '');
    const hasChat = chatFiles.has(baseName);

    const div = document.createElement('div');
    div.className = 'video-thumbnail';
    div.innerHTML = `
      <div class="thumbnail-container">
        <img src="${video.thumbnail}" alt="${video.title}">
        ${hasChat && showBadges ? '<span class="chat-badge">LIVE CHAT AVAILABLE</span>' : ''}
      </div>
      <h3>${video.title}</h3>
      <p>${formatDate(video.date)}</p>
    `;

    // ---- Favorite Star ----
    const star = document.createElement('span');
    star.className = 'favorite-star';
    star.textContent = '★';
    if (favorites.has(baseName)) {
      star.classList.add('favorited');
    }
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
    };
    div.appendChild(star);

    // ---- Queue Button (bottom right, blue ⏭ when queued) ----
    const queueBtn = document.createElement('span');
    queueBtn.className = 'queue-btn';
    if (loadQueue().includes(video.filename)) {
      queueBtn.classList.add('queued');
      queueBtn.textContent = '⏭';
      queueBtn.title = 'Remove from queue';
    } else {
      queueBtn.textContent = '➕';
      queueBtn.title = 'Add to queue';
    }
    queueBtn.onclick = (e) => {
      e.stopPropagation();
      const queue = loadQueue();
      if (queue.includes(video.filename)) {
        removeFromQueue(video.filename);
        queueBtn.classList.remove('queued');
        queueBtn.textContent = '➕';
        queueBtn.title = 'Add to queue';
      } else {
        addToQueue(video.filename);
        queueBtn.classList.add('queued');
        queueBtn.textContent = '⏭';
        queueBtn.title = 'Remove from queue';
      }
      renderQueue();
    };
    div.appendChild(queueBtn);

    // ---- Watched Checkmark ----
    if (watchedVideos.has(baseName) && showWatched) {
      const check = document.createElement('span');
      check.className = 'watched-checkmark';
      check.textContent = '✔';
      div.querySelector('.thumbnail-container').appendChild(check);
    }

    // ---- Video click handler ----
    div.onclick = () => {
      const playlist = selectedPlaylist !== 'all'
        ? rawVideoData.filter(v => Array.isArray(v.tags) && v.tags.includes(selectedPlaylist))
        : rawVideoData;
      const index = playlist.findIndex(v => v.filename === video.filename);
      showPlayer(video, playlist, index);
    };

    // --- Watch Video Progress ---
    const watchedProgress = loadWatchedProgress();
    if (watchedProgress[baseName] && watchedProgress[baseName].duration > 10) {
      const percent = Math.min(100, Math.round(
        100 * watchedProgress[baseName].current / watchedProgress[baseName].duration
      ));
      if (percent < 98) { // Hide if almost done or done
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
        div.querySelector('.thumbnail-container').appendChild(progressBar);
      }
    }

    grid.appendChild(div);
  });

  setupThumbnailPreviews();
  renderQueue();
}

async function showPlayer(video, playlist = [], index = 0, autoplay = false) {
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
  loadComments(video);

  const player = document.getElementById('player-video');
  const subtitleSelector = document.getElementById('subtitleSelector');
  const subtitleLabel = document.getElementById('subtitle-label');
  const track = document.getElementById('video-subtitle');

  player.src = "file://" + videoPath + "/" + video.filename;
  player.load();

  // --- Resume Progress If Saved ---
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
  player.volume = document.getElementById('volumeSlider').value;
  player.playbackRate = parseFloat(document.getElementById('speedSelector').value);

  player.onloadedmetadata = () => {
    if (autoplay) {
      player.play().catch(err => {
        console.warn("Autoplay failed:", err);
      });
    }
  };

  currentVideoFilename = video.filename;
  currentAltVideo = null;

  // --- Save Watched Progress Regularly ---
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    if (player.duration > 0 && player.currentTime > 0 && player.currentTime < player.duration - 2) {
      const progress = loadWatchedProgress();
      progress[baseName] = { current: player.currentTime, duration: player.duration };
      saveWatchedProgress(progress);
    }
  }, 4000);

  // Save when paused or seeked
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

  // Reset subtitle UI
  track.removeAttribute('src');
  subtitleSelector.innerHTML = '<option value="">None</option>';
  subtitleSelector.style.display = 'none';
  subtitleLabel.style.display = 'none';

  const subInfo = subtitlesData[video.filename];
  if (subInfo) {
    for (const [lang, data] of Object.entries(subInfo)) {
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

  // === Live Chat loading
  const chatPane = document.getElementById('chat-pane');
  const chatBox = document.getElementById('chat-messages');
  const toggleBtn = document.querySelector('button[onclick="toggleChat()"]');
  const queueContainer = document.getElementById('playlist-queue-container');

  chatBox.innerHTML = "";
  chatPane.style.display = 'none';
  toggleBtn.style.display = 'none';
  chatData = [];

  const chatFile = `chat/${video.filename.split('/').pop().replace(/\.[^/.]+$/, '')}.csv`;

  try {
    const res = await fetch(chatFile);
    if (!res.ok) throw new Error();
    const txt = await res.text();
    chatData = txt.trim().split('\n').slice(1).map(row => {
      const [timestamp, author, message] = row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      return { time: parseTimestamp(timestamp), author, message };
    });

    const settings = await window.electronAPI.getSettings();
    const chatVisible = settings?.chatVisible !== false;

    chatPane.style.display = chatVisible ? 'block' : 'none';
    toggleBtn.style.display = 'inline-block';
    queueContainer.style.marginTop = chatVisible ? '16px' : '0';
  } catch (e) {
    chatPane.style.display = 'none';
    toggleBtn.style.display = 'none';
    queueContainer.style.marginTop = '0';
  }

  player.ontimeupdate = () => {
    if (!chatData.length) return;
    const current = player.currentTime;
    const msgs = chatData.filter(m => m.time <= current);
    chatBox.innerHTML = msgs.map(m =>
      `<div class='chat-message'><strong>${m.author}:</strong> ${m.message}</div>`
    ).join('');
    chatPane.scrollTop = chatPane.scrollHeight;
  };

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
  queueContainer.innerHTML = currentPlaylistVideos.map((vid, idx) => {
    const isCurrent = idx === currentPlaylistIndex;
    return `
      <div class="queue-item ${isCurrent ? 'current' : ''}" onclick="showPlayer(currentPlaylistVideos[${idx}], currentPlaylistVideos, ${idx})" style="cursor:pointer;margin-bottom:8px;padding:6px;border-radius:4px;background:${isCurrent ? '#444' : '#222'};">
        <img src="${vid.thumbnail}" class="queue-thumb" alt="Thumbnail" style="width:80px;height:auto;margin-right:8px;vertical-align:middle;">
        <span class="queue-title" style="vertical-align:middle;">${vid.title}</span>
      </div>
    `;
  }).join('');
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

function changeSubtitle(lang) {
  const track = document.getElementById('video-subtitle');
  const video = document.getElementById('player-video');
  const currentTime = video.currentTime;

  clearAssSubtitle();

  const currentVideoTitle = document.getElementById('player-title').innerText;
  const videoEntry = rawVideoData.find(v => v.title === currentVideoTitle);
  if (!videoEntry) return;

  const subInfo = subtitlesData[videoEntry.filename];

  if (!lang || !subInfo || !subInfo[lang]) {
    if (currentAltVideo && currentVideoFilename) {
      video.src = "file://" + videoPath + "/" + currentVideoFilename;
      video.load();
      video.onloadedmetadata = () => {
        video.currentTime = currentTime;
        currentAltVideo = null;
      };
    }
    track.removeAttribute('src');
    video.load();
    return;
  }

  const entry = subInfo[lang];
  const subtitlePath = typeof entry === 'string' ? entry : entry.path;
  const altVideo = typeof entry === 'object' ? entry.altVideo : null;

  if (!currentVideoFilename) currentVideoFilename = videoEntry.filename;

  if (altVideo && altVideo !== currentAltVideo) {
    const altPath = `${videoPath}/${altVideo}`;
    fetch(`file://${altPath}`)
      .then(r => {
        if (r.ok) {
          video.src = "file://" + altPath;
          currentAltVideo = altVideo;
        } else {
          video.src = "file://" + videoPath + "/" + currentVideoFilename;
          currentAltVideo = null;
        }
      })
      .catch(() => {
        video.src = "file://" + videoPath + "/" + currentVideoFilename;
        currentAltVideo = null;
      })
      .finally(() => {
        video.load();
        video.onloadedmetadata = () => {
          video.currentTime = currentTime;
        };
      });
  } else {
    video.src = "file://" + videoPath + "/" + currentVideoFilename;
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
      track.src = subtitlePath;
      track.label = lang;
      track.srclang = "pl";
      track.default = true;
      video.load();
      video.onloadedmetadata = () => {
        video.currentTime = currentTime;
        if (video.textTracks.length > 0) {
          video.textTracks[0].mode = 'showing';
        }
      };
    }
  }
}

function closePlayer() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  const player = document.getElementById('player-video');
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
  renderQueue();
  renderVideoGrid()
}

function resizePlayer(mode) {
  document.getElementById('player-video').className = mode;
  localStorage.setItem('videoSizeMode', mode);
}
function setVolume(v) {
  document.getElementById('player-video').volume = v;
}
function setPlaybackSpeed(v) {
  document.getElementById('player-video').playbackRate = parseFloat(v);
}
async function toggleChat() {
  const chatPane = document.getElementById('chat-pane');
  const queueContainer = document.getElementById('playlist-queue-container');
  const showing = chatPane.style.display === 'block';
  const newDisplay = showing ? 'none' : 'block';
  chatPane.style.display = newDisplay;
  queueContainer.style.marginTop = newDisplay === 'none' ? '0' : '16px';
  if (queueContainer) {
    if (!showing) {
      chatPane.after(queueContainer);
    } else {
      document.getElementById('chat-and-queue')?.appendChild(queueContainer);
    }
  }
  await window.electronAPI.setSetting('chatVisible', newDisplay === 'block');
}

function parseTimestamp(ts) {
  return ts.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
}
function formatDate(d) {
  return d.length === 8
    ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`
    : d;
}


// --- Frame-by-Frame Navigation for 29.97fps ---

function seekFrame(video, direction) {
  const fps = 29.97;
  const step = 1 / fps;
  let next = video.currentTime + direction * step;
  // Clamp to video duration
  next = Math.max(0, Math.min(video.duration, next));
  video.currentTime = next;
}

document.addEventListener('keydown', function(e) {
  // Only trigger when player is visible
  const player = document.getElementById('player-video');
  const playerContainer = document.getElementById('video-player');
  if (!player || !playerContainer || playerContainer.style.display === 'none') return;

  // Avoid interfering with form inputs
  const tag = document.activeElement.tagName.toLowerCase();
  if (['input','textarea','select'].includes(tag)) return;

  // , or <  (go back 1 frame)
  if (e.key === ',' || e.key === '<') {
    e.preventDefault();
    seekFrame(player, -1);
  }
  // . or > (go forward 1 frame)
  if (e.key === '.' || e.key === '>') {
    e.preventDefault();
    seekFrame(player, 1);
  }
});

async function renderCreditsPage() {
  const creditsSection = document.getElementById('credits-section');
  let detailsDiv = document.getElementById('credits-details');
  if (!detailsDiv) {
    detailsDiv = document.createElement('div');
    detailsDiv.id = 'credits-details';
    creditsSection.prepend(detailsDiv);
  }
  detailsDiv.innerHTML = "";

  try {
    const res = await fetch('data/credits.json');
    const data = await res.json();

    let html = '';
    // === Creator and Links ===
    if (data.creator) {
      html += `<h2 style="margin-bottom:0.25em;">${data.creator}</h2>`;
    }
    if (Array.isArray(data.creatorLinks) && data.creatorLinks.length) {
      html += `<div style="margin-bottom:1em;">`;
      html += data.creatorLinks.map(link =>
        `<a href="${link.url}" target="_blank" rel="noopener" style="margin-right: 10px; color:#4af;">${link.label}</a>`
      ).join('');
      html += `</div>`;
    }
    html += `<h2>Credits</h2>`;

    // === Collab Contributors ===
    if (data.collabHeader || data.pfpcollabheader) {
      html += `<p>${data.collabHeader || data.pfpcollabheader}</p>`;
    }
    if (Array.isArray(data.collabContributors) && data.collabContributors.length) {
      html += `<ul>`;
      for (const c of data.collabContributors) {
        html += `<li>`;
        if (c.link) {
          html += `<strong><a href="${c.link}" target="_blank" rel="noopener" style="color:#4af;text-decoration:underline;">${c.name}</a></strong>`;
        } else {
          html += `<strong>${c.name}</strong>`;
        }
        if (c.pfp) html += `: <span style="color:#7cf;">${c.pfp}</span>`;
        html += `</li>`;
      }
      html += `</ul>`;
    }

    // === Subtitle Contributors ===
    if (data.subtitleheader || data.header) {
      html += `<p>${data.subtitleheader || data.header}</p>`;
    }
    if (Array.isArray(data.contributors) && data.contributors.length) {
      html += `<ul>`;
      for (const c of data.contributors) {
        if (c.link) {
          html += `<li><strong><a href="${c.link}" target="_blank" rel="noopener" style="color:#4af;text-decoration:underline;">${c.name}</a></strong>:<ul>`;
        } else {
          html += `<li><strong>${c.name}</strong>:<ul>`;
        }
        for (const w of c.works) {
          html += `<li>${w.video} <span style="color:#666;">(${w.language})</span></li>`;
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
  } catch (e) {
    detailsDiv.innerHTML = "<h2>Credits</h2><p>❌ Failed to load credits.</p>";
  }

  await renderMissingAltVideos();
  document.getElementById('download-selected-alt-videos').onclick = downloadAltVideosHandler;

  // External link handler for Electron
  if (creditsSection && !creditsSection._externalLinkHandlerSet) {
    creditsSection.addEventListener('click', function (event) {
      const a = event.target.closest('a[target=\"_blank\"]');
      if (a && a.href.startsWith('http')) {
        event.preventDefault();
        window.electronAPI.openExternal(a.href);
      }
    });
    creditsSection._externalLinkHandlerSet = true;
  }
}

// === Download handler with debug ===
async function downloadAltVideosHandler() {
  const status = document.getElementById('alt-download-status');
  const progressBar = document.getElementById('alt-progress-bar');
  const progressFill = document.getElementById('alt-progress-fill');
  const progressLabel = document.getElementById('alt-progress-label');
  const forceRedownload = document.getElementById('force-redownload').checked;
  const form = document.getElementById('alt-video-form');
  if (!form) {
    status.textContent = '❌ No video checklist found.';
    return;
  }

  const checkedBoxes = Array.from(form.querySelectorAll('input[name="altfile"]:checked'));
  const selected = checkedBoxes.map(el => el.value);

  if (selected.length === 0) {
    status.textContent = '⚠️ No videos selected.';
    return;
  }

  let completed = 0;
  status.textContent = '';
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';
  progressLabel.style.display = 'block';
  progressLabel.textContent = '';

  for (const filename of selected) {
    const url = altVideoURLs[filename];
    if (!url) continue;
    try {
      const exists = await fileExistsInVideoFolder(filename);
      if (exists && !forceRedownload) {
        status.textContent += `⏩ Skipped: ${filename}\n`;
        completed++;
        continue;
      }

      // Begin download UI
      progressLabel.textContent = `Starting: ${filename}`;

      // --- Real-time progress download ---
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength) : null;

      let received = 0;
      let chunks = [];
      const reader = response.body.getReader();

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        let percent = total ? ((received / total) * 100).toFixed(1) : null;

        // Update progress bar and label in real-time
        progressFill.style.width = total ? `${percent}%` : '0%';
        progressLabel.textContent =
          `Downloading: ${filename}\n` +
          (total ? `${formatBytes(received)} / ${formatBytes(total)} (${percent}%)` : `${formatBytes(received)} downloaded`);
      }

      // Combine chunks into a single ArrayBuffer
      let buffer = new Uint8Array(received);
      let pos = 0;
      for (let chunk of chunks) {
        buffer.set(chunk, pos);
        pos += chunk.length;
      }
      await saveAltVideoToFolder(filename, buffer);

      status.textContent += `✅ Downloaded: ${filename}\n`;
    } catch (err) {
      console.error('Error downloading:', filename, err);
      status.textContent += `❌ Failed: ${filename}\n`;
    }
    completed++;
  }

  // Hide progress bar when done
  progressBar.style.display = 'none';
  progressLabel.style.display = 'none';
}

async function renderMissingAltVideos() {
  const listDiv = document.getElementById('missing-alt-video-list');
  listDiv.innerHTML = '<strong>Missing Alt Videos:</strong><br>';

  try {
    const res = await fetch('data/subtitles.json');
    const subtitles = await res.json();

    const missing = [];
    for (const langs of Object.values(subtitles)) {
      for (const langData of Object.values(langs)) {
        const filename = langData.altVideo;
        if (!filename || !altVideoURLs[filename]) continue;
        const exists = await fileExistsInVideoFolder(filename);
        if (!exists) missing.push(filename);
      }
    }

    if (missing.length === 0) {
      listDiv.innerHTML += '<p>✅ All alt videos are present.</p>';
      return;
    }
    let formHtml = '<form id="alt-video-form">';
    missing.forEach(name => {
      formHtml += `<label><input type="checkbox" name="altfile" value="${name}" checked> ${name}</label><br>`;
    });
    formHtml += '</form>';
    listDiv.innerHTML += formHtml;

  } catch (e) {
    console.error('Failed to render missing alt videos:', e);
    listDiv.innerHTML += '<p>❌ Failed to scan for missing alt videos.</p>';
  }
}

// === Startup & tab-switching ===
document.addEventListener('DOMContentLoaded', async () => {
  getDebugOverlay();

  if (window.SubtitlesOctopus && !window._octopusDebugPatched) {
    try { patchSubtitlesOctopusDebug(); } catch (e) {}
  }

  const settings = await window.electronAPI.getSettings();
  if (settings && settings.videoPath) {
    videoPath = settings.videoPath.replace(/\\\\/g, '/');
    document.getElementById('startup-screen').style.display = 'none';
    document.getElementById('app-content').style.display = 'block';
    await initializeYouTubeTab();
  } else {
    document.getElementById('startup-screen').style.display = 'block';
    document.getElementById('app-content').style.display = 'none';
    document.getElementById('select-folder').onclick = async () => {
      const p = await window.electronAPI.selectVideoFolder();
      if (p) {
        videoPath = p.replace(/\\\\/g, '/');
        document.getElementById('startup-screen').style.display = 'none';
        document.getElementById('app-content').style.display = 'block';
        await initializeYouTubeTab();
      }
    };
  }

  document.getElementById('change-folder-btn').addEventListener('click', async () => {
    const p = await window.electronAPI.selectVideoFolder();
    if (p) {
      videoPath = p.replace(/\\\\/g, '/');
      localStorage.setItem('videoPath', videoPath);
      location.reload();
    }
  });

    // Screenshot
  document.getElementById('screenshot-btn').onclick = function() {
    const video = document.getElementById('player-video');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Download as PNG
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'screenshot.png';
    a.click();
  };


  // --- Tab switching ---
  const ytBtn = document.getElementById('tab-youtube');
  const daBtn = document.getElementById('tab-deviantart');
  const tu1Btn = document.getElementById('tab-tumblr');
  const tu2Btn = document.getElementById('tab-tumblr2');
  const creditsBtn = document.getElementById('tab-credits');
  const settingsBtn = document.getElementById('tab-settings');
  const startup = document.getElementById('startup-screen');
  const ytSec = document.getElementById('app-content');
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
    currentAltVideo = null;
  }

  function showSection(name) {
    if (typeof stopMusic === 'function' && name !== 'deviantart') stopMusic();
    [startup, ytSec, daSec, tu1Sec, tu2Sec, creditsSec, settingsSec].forEach(s => { if (s) s.style.display = 'none'; });
    [ytBtn, daBtn, tu1Btn, tu2Btn, creditsBtn, settingsBtn].forEach(b => b && b.classList.remove('active'));

    if (name === 'youtube') {
      ytSec.style.display = 'block';
      ytBtn.classList.add('active');
      initializeYouTubeTab(true); // Ensure all controls and listeners are active
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
      renderCreditsPage();
    } else if (name === 'settings') {
      settingsSec.style.display = 'block';
      settingsBtn.classList.add('active');
    }
  }

  ytBtn.addEventListener('click', () => showSection('youtube'));
  daBtn.addEventListener('click', () => showSection('deviantart'));
  tu1Btn.addEventListener('click', () => showSection('tumblr'));
  tu2Btn.addEventListener('click', () => showSection('tumblr2'));
  creditsBtn.addEventListener('click', () => showSection('credits'));
  settingsBtn.addEventListener('click', () => showSection('settings'));

  showSection('youtube');
});
