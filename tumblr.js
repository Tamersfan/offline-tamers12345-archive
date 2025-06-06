(function() {
  const tuBtn  = document.getElementById('tab-tumblr');
  const ytBtn  = document.getElementById('tab-youtube');
  const daBtn  = document.getElementById('tab-deviantart');
  const tu1Sec = document.getElementById('tumblr-section');
  const tu2Sec = document.getElementById('tumblr2-section');

  let tumblrFiles = [];
  let currentIndex = 0;

  if (!tuBtn || !tu1Sec) return;

  tuBtn.addEventListener('click', () => {
    pauseAllAudio();

    document.getElementById('app-content').style.display        = 'none';
    document.getElementById('deviantart-section').style.display = 'none';
    tu2Sec.style.display                                         = 'none';
    tu1Sec.style.display                                         = 'block';

    [ytBtn, daBtn, tuBtn].forEach(b => b.classList.remove('active'));
    tuBtn.classList.add('active');

    initTumblr1();
  });

  async function initTumblr1() {
    pauseAllAudio();
    if (tumblrFiles.length === 0) {
      tumblrFiles = await window.electronAPI.readTumblrHTML();
    }
    currentIndex = 0;
    setupNav();
    loadPage();
  }

  function setupNav() {
    document.getElementById('tumblr-prev').onclick = () => {
      pauseAllAudio();
      if (currentIndex > 0) {
        currentIndex--;
        loadPage();
      }
    };
    document.getElementById('tumblr-next').onclick = () => {
      pauseAllAudio();
      if (currentIndex < tumblrFiles.length - 1) {
        currentIndex++;
        loadPage();
      }
    };
  }

  function loadPage() {
    pauseAllAudio();
    const file = tumblrFiles[currentIndex];
    const frame = document.getElementById('tumblr-frame');
    frame.src = file;
    frame.onload = () => {
      try {
        const doc = frame.contentDocument;
        doc.querySelectorAll('a').forEach(a => {
          a.removeAttribute('href');
          a.style.cursor = 'default';
          a.onclick = e => e.preventDefault();
        });
      } catch (e) {
        console.warn('Could not disable links in Tumblr iframe', e);
      }
    };
  }

  function pauseAllAudio() {
    // existing API
    if (typeof stopMusic === 'function') stopMusic();
    // pause + reset + remove any <audio> tags
    document.querySelectorAll('audio').forEach(a => {
      try { a.pause(); a.currentTime = 0; a.src = ''; a.remove(); }
      catch {}
    });
  }
})();
