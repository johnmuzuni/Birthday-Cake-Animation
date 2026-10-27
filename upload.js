/* ============================================================
   Birthday reel — upload dock
   - up to 10 photos
   - a song limited to its first 30 seconds on the reel page
   - selections are kept in IndexedDB and handed to reel.html
============================================================ */
(() => {
  'use strict';

  const MAX_PHOTOS = 10;
  const MAX_AUDIO_SECONDS = 30;
  const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

  const $ = (id) => document.getElementById(id);

  const els = {
    dock: $('reelDock'),
    hint: $('reelHint'),
    tray: $('reelTray'),
    thumbs: $('thumbList'),
    audioChip: $('audioChip'),
    audioName: $('audioName'),
    audioDuration: $('audioDuration'),
    removeAudioBtn: $('removeAudioBtn'),
    clearBtn: $('clearBtn'),
    addPhotosBtn: $('addPhotosBtn'),
    addAudioBtn: $('addAudioBtn'),
    photoCount: $('photoCount'),
    photoInput: $('photoInput'),
    audioInput: $('audioInput'),
    playBtn: $('playBtn'),
    playLabel: $('playLabel'),
    toast: $('reelToast'),
  };

  const state = {
    photos: [],
    audio: null,
    audioToken: 0,
    toastTimer: 0,
    saving: false,
  };

  /* ---------------------------------------------- helpers */

  function formatTime(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const mins = Math.floor(total / 60);
    const secs = String(total % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }

  function audioMeta(audio) {
    if (!audio) return '';
    if (audio.loading) return 'reading…';
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
      return `first ${MAX_AUDIO_SECONDS}s`;
    }
    if (audio.duration > MAX_AUDIO_SECONDS + 0.15) {
      return `first 0:30 of ${formatTime(audio.duration)}`;
    }
    const loops = audio.duration < MAX_AUDIO_SECONDS - 0.05 ? ' · loops' : '';
    return `${formatTime(audio.duration)} clip${loops}`;
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, 3200);
  }

  /* ---------------------------------------------- photos */

  function addPhotos(fileList) {
    const files = Array.from(fileList || []).filter((file) =>
      file.type.startsWith('image/')
    );

    if (!files.length) {
      showToast('Please choose image files.');
      return;
    }

    const room = MAX_PHOTOS - state.photos.length;
    if (room <= 0) {
      showToast(`The reel holds up to ${MAX_PHOTOS} photos.`);
      return;
    }

    const accepted = files.slice(0, room);
    accepted.forEach((file, i) => {
      state.photos.push({
        id: `photo-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name,
        blob: file,
        url: URL.createObjectURL(file),
        caption: '',
      });
    });

    if (files.length > accepted.length) {
      showToast(`Added ${accepted.length} photos — the reel holds ${MAX_PHOTOS}.`);
    }

    renderMedia();
  }

  function removePhoto(id) {
    const index = state.photos.findIndex((photo) => photo.id === id);
    if (index < 0) return;
    URL.revokeObjectURL(state.photos[index].url);
    state.photos.splice(index, 1);
    renderMedia();
  }

  function clearAll() {
    if (!state.photos.length && !state.audio) return;

    state.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
    state.photos = [];
    releaseAudio();
    renderMedia();

    if (window.MediaStore) {
      window.MediaStore.clear().catch(() => {});
    }
  }

  /* ---------------------------------------------- audio */

  function releaseAudio() {
    state.audioToken += 1;

    const audio = state.audio;
    if (audio) {
      if (audio.el) {
        try {
          audio.el.pause();
          audio.el.removeAttribute('src');
          audio.el.load();
        } catch (error) {
          /* ignore */
        }
      }
      if (audio.url) URL.revokeObjectURL(audio.url);
    }

    state.audio = null;
  }

  function loadAudioBlob(blob, name, notify = true) {
    releaseAudio();

    if (!blob) return;

    if (!blob.type.startsWith('audio/')) {
      showToast('Please choose an audio file.');
      return;
    }
    if (blob.size > MAX_AUDIO_BYTES) {
      showToast('That audio file is too large (10 MB max).');
      return;
    }

    const token = ++state.audioToken;
    const url = URL.createObjectURL(blob);
    const el = new Audio();
    el.preload = 'metadata';
    el.muted = true;

    state.audio = {
      name,
      blob,
      url,
      el,
      duration: 0,
      loading: true,
    };

    const finishLoading = () => {
      if (token !== state.audioToken || !state.audio) return;
      if (Number.isFinite(el.duration) && el.duration > 0) {
        state.audio.duration = el.duration;
      }
      state.audio.loading = false;
      renderMedia();
    };

    el.addEventListener('loadedmetadata', () => {
      finishLoading();
      if (
        notify &&
        state.audio &&
        state.audio.duration > MAX_AUDIO_SECONDS + 0.15
      ) {
        showToast('Song is longer than 30s — using the first 30 seconds.');
      }
    }, { once: true });

    el.addEventListener('error', () => {
      if (token !== state.audioToken) return;
      releaseAudio();
      renderMedia();
      showToast("That song couldn't be read. Try an MP3 or WAV file.");
    }, { once: true });

    // Some codecs never report metadata; don't block the reel forever.
    window.setTimeout(finishLoading, 4000);

    el.src = url;
    renderMedia();
  }

  /* ---------------------------------------------- restore saved selection */

  async function restoreSaved() {
    if (!window.MediaStore) return;

    let record = null;
    try {
      record = await window.MediaStore.load();
    } catch (error) {
      return;
    }

    if (!record) return;

    if (Array.isArray(record.photos)) {
      record.photos.slice(0, MAX_PHOTOS).forEach((item, index) => {
        if (!item || !(item.blob instanceof Blob)) return;
        state.photos.push({
          id: `saved-${Date.now()}-${index}`,
          name: item.name || `Photo ${index + 1}`,
          blob: item.blob,
          url: URL.createObjectURL(item.blob),
          caption: typeof item.caption === 'string' ? item.caption : '',
        });
      });
    }

    if (record.audio && record.audio.blob instanceof Blob) {
      loadAudioBlob(record.audio.blob, record.audio.name || 'Your song', false);
    }

    renderMedia();
  }

  /* ---------------------------------------------- rendering the dock */

  function renderMedia() {
    els.thumbs.innerHTML = '';

    state.photos.forEach((photo) => {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';

      const image = document.createElement('img');
      image.src = photo.url;
      image.alt = '';
      image.draggable = false;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'thumb-x';
      remove.setAttribute('aria-label', 'Remove photo');
      remove.textContent = '×';
      remove.addEventListener('click', () => removePhoto(photo.id));

      thumb.append(image, remove);

      // A short line of text per photo. It is written straight onto the
      // photo object (no re-render) so the field never loses focus.
      const caption = document.createElement('input');
      caption.type = 'text';
      caption.className = 'thumb-caption';
      caption.maxLength = 60;
      caption.value = photo.caption || '';
      caption.placeholder = 'Caption…';
      caption.setAttribute('aria-label', 'Caption for this photo');
      caption.addEventListener('input', () => {
        photo.caption = caption.value;
      });

      const cell = document.createElement('div');
      cell.className = 'thumb-cell';
      cell.append(thumb, caption);
      els.thumbs.appendChild(cell);
    });

    const hasMedia = state.photos.length > 0 || Boolean(state.audio);
    els.tray.hidden = !hasMedia;
    els.hint.hidden = hasMedia;
    els.thumbs.hidden = state.photos.length === 0;

    els.playBtn.disabled = state.photos.length === 0 || state.saving;
    els.playBtn.title = state.photos.length
      ? 'Open the birthday reel in a new page'
      : 'Add photos first';

    els.audioChip.hidden = !state.audio;
    if (state.audio) {
      els.audioName.textContent = state.audio.name;
      els.audioName.title = state.audio.name;
      els.audioDuration.textContent = audioMeta(state.audio);
      els.audioChip.classList.toggle('is-loading', Boolean(state.audio.loading));
      els.addAudioBtn.classList.add('has-file');
    } else {
      els.addAudioBtn.classList.remove('has-file');
    }

    els.addPhotosBtn.classList.toggle('has-file', state.photos.length > 0);
    els.photoCount.hidden = state.photos.length === 0;
    els.photoCount.textContent = String(state.photos.length);
  }

  /* ---------------------------------------------- opening the reel */

  async function openReel() {
    if (!state.photos.length) {
      showToast('Add a photo or two first.');
      return;
    }
    if (state.saving) return;
    if (!window.MediaStore) {
      showToast('This browser cannot open the reel. Try another browser.');
      return;
    }

    state.saving = true;
    els.playLabel.textContent = 'Opening…';
    renderMedia();
    showToast('Opening your birthday reel…');

    try {
      await window.MediaStore.save({
        photos: state.photos.map((photo) => ({
          name: photo.name,
          type: photo.blob.type || 'image/jpeg',
          blob: photo.blob,
          caption: (photo.caption || '').trim().slice(0, 60),
        })),
        audio: state.audio
          ? {
              name: state.audio.name,
              type: state.audio.blob.type || 'audio/mpeg',
              blob: state.audio.blob,
            }
          : null,
        updatedAt: Date.now(),
      });

      window.location.assign('reel.html');
    } catch (error) {
      state.saving = false;
      els.playLabel.textContent = 'Play reel';
      renderMedia();
      showToast('Could not open the reel. Please try again.');
    }
  }

  /* ---------------------------------------------- events */

  els.addPhotosBtn.addEventListener('click', () => els.photoInput.click());
  els.addAudioBtn.addEventListener('click', () => els.audioInput.click());
  els.playBtn.addEventListener('click', openReel);
  els.removeAudioBtn.addEventListener('click', () => {
    releaseAudio();
    renderMedia();
  });
  els.clearBtn.addEventListener('click', clearAll);

  els.photoInput.addEventListener('change', (event) => {
    addPhotos(event.target.files);
    event.target.value = '';
  });

  els.audioInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) loadAudioBlob(file, file.name);
  });

  // When coming back from the reel via the browser's back button, the
  // page may be restored from the back/forward cache with the button
  // still in its "Opening…" state.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    state.saving = false;
    els.playLabel.textContent = 'Play reel';
    renderMedia();
  });

  renderMedia();
  restoreSaved();
})();
