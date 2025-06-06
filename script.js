// === Global State ===
let chatFiles = new Set();
let showBadges = true;
let sortOrder = 'newest';
let tagFilter = 'all';               // filter state: all, no-mlp, only-mlp
let selectedPlaylist = 'all';        // playlist/tag-based filter (ignores "mlp")
let rawVideoData = [];
let videoPath = "";
let favorites = new Set(JSON.parse(localStorage.getItem('favorites') || '[]'));

// === Load available chat files ===
async function loadChatFiles() {
  try {
    const res = await fetch('data/chat_index.json');
    const list = await res.json();
    list.forEach(f => chatFiles.add(f));
  } catch (e) {
    console.warn("Could not load chat_index.json");
  }
}

// === Initialization ===
async function init() {
  await loadChatFiles();

  const res = await fetch('data/videos.json');
  rawVideoData = await res.json();

  populatePlaylistOptions();
  renderVideoGrid();

  // Sort control
  document.getElementById('sortOrder').addEventListener('change', e => {
    sortOrder = e.target.value;
    renderVideoGrid();
  });

  // Live chat badge toggle
  document.getElementById('badge-toggle').addEventListener('change', e => {
    showBadges = e.target.checked;
    renderVideoGrid();
  });

  // Favorites toggle
  document.getElementById('favoritesToggle').addEventListener('change', () => {
    renderVideoGrid();
  });

  // Search input
  document.getElementById('searchInput').addEventListener('input', () => {
    renderVideoGrid();
  });

  // Tag-based filter ("Everything", "Everything but MLP", "Only MLP")
  const filterSelect = document.getElementById('tagFilter');
  if (filterSelect) {
    filterSelect.addEventListener('change', e => {
      tagFilter = e.target.value;
      renderVideoGrid();
    });
  }

  // Playlist (tag) filter, excluding "mlp"
  const playlistSelect = document.getElementById('playlistSelect');
  if (playlistSelect) {
    playlistSelect.addEventListener('change', e => {
      selectedPlaylist = e.target.value;
      renderVideoGrid();
    });
  }
}

// === Populate playlist select with unique tags (except "mlp"), in custom order ===
function populatePlaylistOptions() {
  const playlistSelect = document.getElementById('playlistSelect');
  if (!playlistSelect || !Array.isArray(rawVideoData)) return;

  // 1) Collect all tags (except "mlp") into a Set
  const tagSet = new Set();
  rawVideoData.forEach(video => {
    if (Array.isArray(video.tags)) {
      video.tags.forEach(t => {
        if (t !== 'mlp') {
          tagSet.add(t);
        }
      });
    }
  });

  // 2) Turn that Set into an array
  const tagArray = Array.from(tagSet);

  // 3) Define desired order
  const customOrder = [
    'SU Lore Arc 1 (The Prophecy/The Boys)',
    'Parodies',
    'Zatch Bell',
    'Holiday Special',
    'Christmas',
    'Halloween',
    'Thanksgiving',
    "Valentine's Day",
    '4th of July',
    "St. Patrick's Day",
    '9/11'
  ];

  // 4) Sort tagArray by the index in customOrder
  tagArray.sort((a, b) => {
    const ai = customOrder.indexOf(a);
    const bi = customOrder.indexOf(b);
    // If both tags appear in customOrder, compare their indices
    if (ai !== -1 && bi !== -1) {
      return ai - bi;
    }
    // If only one appears in customOrder, it comes first
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    // Otherwise (tag not in customOrder), sort alphabetically
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });

  // 5) Append each tag as an <option>, preserving the “All” that’s already in HTML
  tagArray.forEach(tag => {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    playlistSelect.appendChild(opt);
  });
}

// === Render the grid of video thumbnails ===
function renderVideoGrid() {
  const grid = document.getElementById('video-grid');
  grid.innerHTML = '';

  const searchEl = document.getElementById('searchInput');
  const query = (searchEl && searchEl.value || '').toLowerCase();

  let videos = rawVideoData.filter(video =>
    video.title.toLowerCase().includes(query)
  );

  // Favorites filtering
  const favEl = document.getElementById('favoritesToggle');
  const showFavOnly = favEl && favEl.checked;
  if (showFavOnly) {
    videos = videos.filter(video => {
      const id = video.filename.split('/').pop().replace(/\.[^/.]+$/, '');
      return favorites.has(id);
    });
  }

  // Sort newest/oldest
  videos.sort((a, b) =>
    sortOrder === 'oldest'
      ? a.date.localeCompare(b.date)
      : b.date.localeCompare(a.date)
  );

  // Playlist filter first (overrides tagFilter if not 'all')
  if (selectedPlaylist !== 'all') {
    videos = videos.filter(v => Array.isArray(v.tags) && v.tags.includes(selectedPlaylist));
  } else {
    // Only apply the earlier tagFilter if no specific playlist selected
    if (tagFilter === 'only-mlp') {
      videos = videos.filter(v => Array.isArray(v.tags) && v.tags.includes('mlp'));
    } else if (tagFilter === 'no-mlp') {
      videos = videos.filter(v => !(Array.isArray(v.tags) && v.tags.includes('mlp')));
    }
  }

  // Create thumbnails
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
    div.onclick = () => showPlayer(video);
    grid.appendChild(div);

    // Favorite star
    const star = document.createElement('span');
    star.className = 'favorite-star' + (favorites.has(baseName) ? ' favorited' : '');
    star.textContent = favorites.has(baseName) ? '★' : '☆';
    star.dataset.videoId = baseName;
    star.addEventListener('click', e => {
      e.stopPropagation();
      const id = e.currentTarget.dataset.videoId;
      if (favorites.has(id)) favorites.delete(id);
      else favorites.add(id);
      localStorage.setItem('favorites', JSON.stringify([...favorites]));
      renderVideoGrid();
    });
    div.appendChild(star);
  });
}

// === Video player & chat logic ===
let chatData = [];
function showPlayer(video) {
  document.getElementById('video-grid').style.display = 'none';
  document.getElementById('video-player').style.display = 'block';
  document.getElementById('player-title').innerText = video.title;
  document.getElementById('player-description').innerText = video.description;
  document.getElementById('player-date').innerText = formatDate(video.date);

  const player = document.getElementById('player-video');
  const chatPane = document.getElementById('chat-pane');
  const chatBox = document.getElementById('chat-messages');
  const toggleBtn = document.querySelector('button[onclick="toggleChat()"]');

  player.src = "file://" + videoPath + "/" + video.filename;
  player.load();
  player.className = 'normal';
  player.volume = document.getElementById('volumeSlider').value;
  player.playbackRate = parseFloat(document.getElementById('speedSelector').value);

  chatBox.innerHTML = "";
  chatPane.style.display = 'none';
  toggleBtn.style.display = 'none';
  chatData = [];

  const chatFile = `chat/${video.filename.split('/').pop().replace(/\.[^/.]+$/, '')}.csv`;
  fetch(chatFile)
    .then(r => { if (!r.ok) throw new Error; return r.text(); })
    .then(txt => {
      chatData = txt.trim().split('\n').slice(1).map(row => {
        const [timestamp, author, message] = row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
        return { time: parseTimestamp(timestamp), author, message };
      });
      chatPane.style.display = 'block';
      toggleBtn.style.display = 'inline-block';
    })
    .catch(() => {
      chatPane.style.display = 'none';
      toggleBtn.style.display = 'none';
    });

  player.ontimeupdate = () => {
    if (!chatData.length) return;
    const current = player.currentTime;
    const msgs = chatData.filter(m => m.time <= current);
    chatBox.innerHTML = msgs.map(m =>
      `<div class='chat-message'><strong>${m.author}:</strong> ${m.message}</div>`
    ).join('');
    // Auto-scroll the chat container
    chatPane.scrollTop = chatPane.scrollHeight;
  };
}

function closePlayer() {
  const player = document.getElementById('player-video');
  player.pause();
  player.currentTime = 0;
  player.src = "";
  document.getElementById('chat-messages').innerHTML = "";
  document.getElementById('video-player').style.display = 'none';
  document.getElementById('video-grid').style.display = 'grid';
}

function resizePlayer(mode) {
  document.getElementById('player-video').className = mode;
}
function setVolume(v) {
  document.getElementById('player-video').volume = v;
}
function setPlaybackSpeed(v) {
  document.getElementById('player-video').playbackRate = parseFloat(v);
}
function toggleChat() {
  const pane = document.getElementById('chat-pane');
  pane.style.display = pane.style.display === 'none' ? 'block' : 'none';
}

function parseTimestamp(ts) {
  return ts.split(':').map(Number).reduce((a,b) => a*60 + b, 0);
}
function formatDate(d) {
  return d.length === 8
    ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}`
    : d;
}

// === Startup & tab-switching ===
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await window.electronAPI.getSettings();
  if (settings && settings.videoPath) {
    videoPath = settings.videoPath.replace(/\\\\/g, '/');
    document.getElementById('startup-screen').style.display = 'none';
    document.getElementById('app-content').style.display = 'block';
    init();
  } else {
    document.getElementById('startup-screen').style.display = 'block';
    document.getElementById('app-content').style.display = 'none';
    document.getElementById('select-folder').onclick = async () => {
      const p = await window.electronAPI.selectVideoFolder();
      if (p) {
        videoPath = p.replace(/\\\\/g, '/');
        document.getElementById('startup-screen').style.display = 'none';
        document.getElementById('app-content').style.display = 'block';
        init();
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

  const ytBtn = document.getElementById('tab-youtube');
  const daBtn = document.getElementById('tab-deviantart');
  const tu1Btn = document.getElementById('tab-tumblr');
  const tu2Btn = document.getElementById('tab-tumblr2');
  const startup = document.getElementById('startup-screen');
  const ytSec = document.getElementById('app-content');
  const daSec = document.getElementById('deviantart-section');
  const tu1Sec = document.getElementById('tumblr-section');
  const tu2Sec = document.getElementById('tumblr2-section');

  function showSection(name) {
    if (typeof stopMusic === 'function' && name !== 'deviantart') stopMusic();
    [startup, ytSec, daSec, tu1Sec, tu2Sec].forEach(s => { if (s) s.style.display = 'none'; });
    [ytBtn, daBtn, tu1Btn, tu2Btn].forEach(b => b.classList.remove('active'));
    if (name === 'youtube') {
      ytSec.style.display = 'block';
      ytBtn.classList.add('active');
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
    }
  }

  ytBtn.addEventListener('click',   () => showSection('youtube'));
  daBtn.addEventListener('click',   () => showSection('deviantart'));
  tu1Btn.addEventListener('click',  () => showSection('tumblr'));
  tu2Btn.addEventListener('click',  () => showSection('tumblr2'));

  showSection('youtube');
});
