let daItems = [];

// ==== Music Player Setup ====
const musicDir = 'deviantart/gallery music/';
const musicFiles = [
  'Beethoven - Moonlight Sonata 1st Movement.mp3',
  'Edvard Grieg ~ Morning Mood.mp3',
  'Für Elise.mp3',
  'Gymnopédie No. 1.mp3',
  'Main Theme - Nintendo 3DS Guide - Louvre.mp3',
  'Rachmaninoff - Piano Concerto No. 2 in C Minor, Op. 18 - II. Adagio sostenuto.mp3',
  'Sibelius - Symphony No. 5 in E-Flat Major, Op. 82 - III. Allegro molto - Misterioso.mp3',
  'Thaxted - Gustav Holst.mp3',
  'The Nutcracker, Op. 71, Act 2 - No. 14a, Pas de deux. Andante maestoso.mp3',
  'Chopin - Nocturne op.9 No.2.mp3',
  'Amore Mio Aiutami ● Piero Piccioni.mp3'
];
let trackOrder = musicFiles.map(f => ({ filename: f, path: musicDir + encodeURIComponent(f) }));
let currentTrackIndex = 0;
let musicOn = localStorage.getItem('musicOn') === 'true';
const audio = new Audio();
audio.volume = parseFloat(localStorage.getItem('musicVolume') || '1');

// === Music Controls ===
function updateMusicUI() {
  const playBtn = document.querySelector('#music-player button:nth-child(2)');
  const status = document.getElementById('music-status');
  if (playBtn) playBtn.textContent = audio.paused ? 'Play' : 'Pause';
  if (status) status.textContent = 'Currently Playing: ' + (trackOrder[currentTrackIndex]?.filename || '');
}

function loadMusicTracks() {
  if (musicOn && trackOrder.length) playMusic(0);
}

function playMusic(index) {
  if (!trackOrder.length) return;
  currentTrackIndex = (index + trackOrder.length) % trackOrder.length;
  audio.src = trackOrder[currentTrackIndex].path;
  audio.play().catch(() => {});
  updateMusicUI();
}

function nextMusic() { playMusic(currentTrackIndex + 1); }
function prevMusic() { playMusic(currentTrackIndex - 1); }

function toggleMusicOn() {
  musicOn = !musicOn;
  localStorage.setItem('musicOn', musicOn);
  if (musicOn) playMusic(currentTrackIndex);
  else audio.pause();
  updateMusicUI();
}

audio.addEventListener('ended', nextMusic);
audio.addEventListener('volumechange', () => localStorage.setItem('musicVolume', audio.volume));

function createMusicPlayerUI() {
  if (document.getElementById('music-player')) return;
  const container = document.getElementById('sort-select-da')?.parentElement || document.body;
  const controls = document.createElement('div');
  controls.id = 'music-player';
  controls.style = 'display:flex;align-items:center;gap:8px;padding:8px;background:#222;color:#fff;margin-bottom:8px;';
  const prevBtn = document.createElement('button'); prevBtn.textContent = 'Prev';
  const playBtn = document.createElement('button'); playBtn.textContent = audio.paused ? 'Play' : 'Pause';
  const nextBtn = document.createElement('button'); nextBtn.textContent = 'Next';
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range'; volumeSlider.min = 0; volumeSlider.max = 1; volumeSlider.step = 0.01; volumeSlider.value = audio.volume;
  const status = document.createElement('span');
  status.id = 'music-status';
  status.style = 'margin-left:16px;font-size:14px;';
  status.textContent = 'Currently Playing: ' + (trackOrder[currentTrackIndex]?.filename || '');

  controls.append(prevBtn, playBtn, nextBtn, volumeSlider, status);
  container.prepend(controls);

  prevBtn.addEventListener('click', prevMusic);
  playBtn.addEventListener('click', () => {
    // Initialize source if first play
    if (!audio.src) {
      playMusic(currentTrackIndex);
    } else if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
    updateMusicUI();});
  nextBtn.addEventListener('click', nextMusic);
  volumeSlider.addEventListener('input', e => { audio.volume = parseFloat(e.target.value); });
  updateMusicUI();
}

// ==== Gallery Code ====
function updateGallery(mode) {
  if (mode === 'size') {
    sortBySize();
  } else {
    const items = daItems.slice();
    if (mode === 'date-asc') items.sort((a, b) => (a.date || 0) - (b.date || 0));
    else if (mode === 'date-desc') items.sort((a, b) => (b.date || 0) - (a.date || 0));
    renderGallery(items);
  }
}

function sortBySize() {
  const items = daItems.slice();
  let loaded = 0;
  items.forEach(item => {
    const img = new Image(); img.src = item.path;
    img.onload = () => {
      item.width = img.naturalWidth; item.height = img.naturalHeight;
      if (++loaded === items.length) {
        items.sort((a, b) => {
          const ap = a.height > a.width, bp = b.height > b.width;
          if (ap !== bp) return ap - bp;
          if (!ap) return b.width - a.width;
          return (a.height / a.width) - (b.height / b.width);
        });
        renderGallery(items);
      }
    };
  });
}

function renderGallery(items) {
  const container = document.getElementById('deviantart-gallery');
  container.innerHTML = '';
  items.forEach(item => {
    const wrap = document.createElement('div'); wrap.classList.add('grid-item');
    const img = document.createElement('img'); img.src = item.path; img.alt = item.filename;
    wrap.appendChild(img);
    wrap.addEventListener('click', () => {
      const original = item.path
        .replace(/deviantart art framed/, 'deviantart art')
        .replace(/_framed(?=\.[^\.]+$)/, '');
      let descFile = item.filename.replace(/_framed(?=\.[^\.]+$)/, '').replace(/\.[^\.]+$/, '.txt');
      showModalWithDescription(original, descFile);
    });
    container.appendChild(wrap);
  });
}

function bindGalleryClicks() {
  document.querySelectorAll('#deviantart-section .da-gallery-item').forEach(item => {
    const wrap = item.querySelector('.da-gallery-item-wrap');
    if (wrap && !wrap._bound) {
      wrap._bound = true;
      wrap.addEventListener('click', () => {
        const original = item.dataset.path.replace('deviantart art framed','deviantart art').replace('_framed','');
        let descFile = item.dataset.filename.replace(/_framed(?=\.[^\.]+$)/, '').replace(/\.[^\.]+$/, '.txt');
        showModalWithDescription(original, descFile);
      });
    }
  });
}

// ==== Modal with description beneath image and full scroll ====
function showModalWithDescription(src, descFile) {
  const old = document.getElementById('da-custom-modal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'da-custom-modal';
  Object.assign(overlay.style, {
    position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
    backgroundColor: 'rgba(0,0,0,0.8)', overflow: 'auto',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '20px', boxSizing: 'border-box', zIndex: 9999
  });

  // Image wrapper for zoom and panning
  const wrapper = document.createElement('div');
  Object.assign(wrapper.style, {
    position: 'relative', overflow: 'auto', flex: 'none'
  });
  const imgElem = document.createElement('img');
  imgElem.src = src;
  let naturalWidth = 0, naturalHeight = 0, scale = 1;
  imgElem.onload = () => {
    naturalWidth = imgElem.naturalWidth;
    naturalHeight = imgElem.naturalHeight;
    imgElem.style.width = naturalWidth + 'px';
    imgElem.style.height = naturalHeight + 'px';
  };
  wrapper.appendChild(imgElem);
  wrapper.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    scale = e.deltaY < 0 ? scale + 0.1 : Math.max(0.1, scale - 0.1);
    imgElem.style.width = (naturalWidth * scale) + 'px';
    imgElem.style.height = (naturalHeight * scale) + 'px';
  }, { passive: false });
  overlay.appendChild(wrapper);

  // Description container below image
  const descContainer = document.createElement('div');
  Object.assign(descContainer.style, {
    width: '100%', maxWidth: '800px', marginTop: '20px',
    color: '#fff', backgroundColor: 'rgba(0,0,0,0.6)',
    padding: '10px', boxSizing: 'border-box'
  });
  descContainer.textContent = '';
  overlay.appendChild(descContainer);

  // Fetch description
  const url = encodeURI('deviantart/deviantart descriptions/' + descFile);
  fetch(url)
    .then(res => res.ok ? res.text() : Promise.reject())
    .then(text => {
      if (text.trim()) {
        descContainer.textContent = text;
      } else {
        descContainer.remove();
      }
    })
    .catch(() => {
      descContainer.remove();
    });

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    position: 'absolute', top: '10px', right: '10px',
    backgroundColor: '#fff', border: 'none', borderRadius: '4px',
    padding: '4px 8px', cursor: 'pointer', zIndex: 10000
  });
  closeBtn.addEventListener('click', () => {
    document.body.style.overflow = '';
    overlay.remove();
  });
  overlay.appendChild(closeBtn);

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}

// Rebind after render
const orig = window.renderGallery;
window.renderGallery = items => { orig(items); bindGalleryClicks(); };

// Init
window.initDeviantArt = () => {
  const sort = document.getElementById('sort-select-da');
  if (sort) sort.addEventListener('change', e => updateGallery(e.target.value));
  if (!daItems.length) {
    window.electronAPI.readImageFiles().then(files => {
      daItems = files.map(i => ({
        filename: i.filename,
        path: i.path,
        date: (i.filename.match(/^(\d{4}-\d{2}-\d{2})/) || [])[0]
          ? new Date(i.filename.match(/^(\d{4}-\d{2}-\d{2})/)[0])
          : null
      }));
      updateGallery(sort.value);
    });
  } else updateGallery(sort.value);
  loadMusicTracks();
  createMusicPlayerUI();
};

// Tab handlers
document.addEventListener('DOMContentLoaded', () => {
  const ytTab  = document.getElementById('tab-youtube');
  const daTab  = document.getElementById('tab-deviantart');
  const tu1Tab = document.getElementById('tab-tumblr');
  const tu2Tab = document.getElementById('tab-tumblr2');
  const creditsTab = document.getElementById('tab-credits'); // <--- ADD THIS

  // Pause DeviantArt audio when switching away
  ytTab?.addEventListener('click',  () => { audio.pause(); updateMusicUI(); });
  tu1Tab?.addEventListener('click', () => { audio.pause(); updateMusicUI(); });
  tu2Tab?.addEventListener('click', () => { audio.pause(); updateMusicUI(); });
  creditsTab?.addEventListener('click', () => { audio.pause(); updateMusicUI(); }); // <--- ADD THIS LINE

  // Resume if coming back
  daTab?.addEventListener('click', () => { if (musicOn) audio.play(); updateMusicUI(); });
});
