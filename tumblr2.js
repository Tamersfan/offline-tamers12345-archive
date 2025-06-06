(function() {
  const tu2Btn  = document.getElementById('tab-tumblr2');
  const ytBtn   = document.getElementById('tab-youtube');
  const daBtn   = document.getElementById('tab-deviantart');
  const tu1Sec  = document.getElementById('tumblr-section');
  const tu2Sec  = document.getElementById('tumblr2-section');

  let tumblr2Files = [];
  let currentIndex2 = 0;

  if (!tu2Btn || !tu2Sec) return;

  tu2Btn.addEventListener('click', () => {
    pauseAllAudio();

    document.getElementById('app-content').style.display        = 'none';
    document.getElementById('deviantart-section').style.display = 'none';
    tu1Sec.style.display                                         = 'none';
    tu2Sec.style.display                                         = 'block';

    [ytBtn, daBtn, tu2Btn].forEach(b => b.classList.remove('active'));
    tu2Btn.classList.add('active');

    initTumblr2();
  });

  async function initTumblr2() {
    pauseAllAudio();
    if (tumblr2Files.length === 0) {
      tumblr2Files = await window.electronAPI.readTumblr2HTML();
    }
    currentIndex2 = 0;
    setupNav2();
    loadPage2();
  }

  function setupNav2() {
    document.getElementById('tumblr2-prev').onclick = () => {
      pauseAllAudio();
      if (currentIndex2 > 0) {
        currentIndex2--;
        loadPage2();
      }
    };
    document.getElementById('tumblr2-next').onclick = () => {
      pauseAllAudio();
      if (currentIndex2 < tumblr2Files.length - 1) {
        currentIndex2++;
        loadPage2();
      }
    };
  }

  function loadPage2() {
    pauseAllAudio();
    const file = tumblr2Files[currentIndex2];
    const frame = document.getElementById('tumblr2-frame');
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
        console.warn('Could not disable links in Tumblr2 iframe', e);
      }
    };
  }

  function pauseAllAudio() {
    if (typeof stopMusic === 'function') stopMusic();
    document.querySelectorAll('audio').forEach(a => {
      try { a.pause(); a.currentTime = 0; a.src = ''; a.remove(); }
      catch {}
    });
  }
})();
