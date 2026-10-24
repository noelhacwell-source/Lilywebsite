'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const gateScreen = $('#gate-screen');
const giftSite = $('#gift-site');
const gateForm = $('#gate-form');
const gateInput = $('#access-code');
const gateError = $('#gate-error');
const bookButton = $('#book-button');
const modal = $('#code-modal');
const modalClose = $('#modal-close');
const bookForm = $('#book-form');
const bookInput = $('#book-code');
const bookError = $('#book-error');
const bookSubmit = $('#book-submit');
const album = $('#album');
const albumPhoto = $('#album-photo');
const photoFullscreenOpen = $('#photo-fullscreen-open');
const photoViewer = $('#photo-viewer');
const photoViewerClose = $('#photo-viewer-close');
const photoViewerPrev = $('#photo-viewer-prev');
const photoViewerNext = $('#photo-viewer-next');
const photoViewerImage = $('#photo-viewer-image');
const photoViewerCaption = $('#viewer-caption');
const photoViewerCount = $('#viewer-count');
const viewerPlayButton = $('#viewer-play-button');
const viewerMusicButton = $('#viewer-music-button');
const photoCaption = $('#photo-caption');
const photoCount = $('#photo-count');
const thumbStrip = $('#thumb-strip');
const thumbTotal = $('#thumb-total');
const previousPhoto = $('#previous-photo');
const nextPhoto = $('#next-photo');
const slideshowButton = $('#slideshow-button');
const musicButton = $('#music-button');
const toast = $('#toast');

let photos = [];
let activePhoto = 0;
let slideshowTimer = null;
let toastTimer = null;
let audioContext = null;
let masterGain = null;
let musicTimer = null;
let musicOn = false;
let previousFocus = null;
let viewerPreviousFocus = null;
let sessionTokenInMemory = '';

function savedSessionToken() {
  if (sessionTokenInMemory) return sessionTokenInMemory;
  try { return sessionStorage.getItem('lily_session_token') || ''; } catch { return ''; }
}

function saveSessionToken(token) {
  if (!token) return;
  sessionTokenInMemory = token;
  try { sessionStorage.setItem('lily_session_token', token); } catch { /* The in-memory ticket and HttpOnly cookie remain as fallbacks. */ }
}

async function api(path, options = {}) {
  const token = savedSessionToken();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };
  let requestPath = path;
  if (token) {
    const target = new URL(path, window.location.origin);
    if (target.origin === window.location.origin && target.pathname.startsWith('/api/')) {
      target.searchParams.set('ticket', token);
      requestPath = `${target.pathname}${target.search}`;
    }
  }
  const response = await fetch(requestPath, {
    credentials: 'same-origin',
    ...options,
    headers
  });
  let data = {};
  try { data = await response.json(); } catch { /* Keep a useful fallback for non-JSON errors. */ }
  saveSessionToken(data.token);
  return { response, data };
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3600);
}

function showGiftSite() {
  gateScreen.hidden = true;
  giftSite.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openModal() {
  previousFocus = document.activeElement;
  bookError.textContent = '';
  bookInput.value = '';
  modal.hidden = false;
  document.body.classList.add('modal-open');
  window.setTimeout(() => bookInput.focus(), 60);
}

function closeModal() {
  if (modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
}

function syncPhotoViewer() {
  if (photoViewer.hidden || !photos.length) return;
  const photo = photos[activePhoto];
  photoViewerImage.src = photo.src;
  photoViewerImage.alt = `${photo.title} bildschirmfüllend`;
  photoViewerCaption.textContent = photo.title;
  photoViewerCount.textContent = `${String(activePhoto + 1).padStart(2, '0')} / ${String(photos.length).padStart(2, '0')}`;
}

function openPhotoViewer() {
  if (!photos.length) return;
  viewerPreviousFocus = document.activeElement;
  photoViewer.hidden = false;
  document.body.classList.add('viewer-open');
  syncPhotoViewer();
  photoViewerClose.focus({ preventScroll: true });
}

function closePhotoViewer() {
  if (photoViewer.hidden) return;
  photoViewer.hidden = true;
  document.body.classList.remove('viewer-open');
  stopSlideshow();
  stopLoveMusic();
  if (viewerPreviousFocus && typeof viewerPreviousFocus.focus === 'function' && viewerPreviousFocus !== document.body) {
    viewerPreviousFocus.focus({ preventScroll: true });
  }
  window.setTimeout(() => album.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
}

function updatePhoto(index, animate = true) {
  if (!photos.length) return;
  activePhoto = (index + photos.length) % photos.length;
  const photo = photos[activePhoto];
  albumPhoto.classList.remove('photo-in');
  albumPhoto.src = photo.src;
  albumPhoto.alt = `${photo.title} aus eurem Fotoalbum`;
  photoCaption.textContent = photo.title;
  photoCount.textContent = `${String(activePhoto + 1).padStart(2, '0')} / ${String(photos.length).padStart(2, '0')}`;
  syncPhotoViewer();
  if (animate) {
    // Force a reflow so the arrival animation runs for each new picture.
    void albumPhoto.offsetWidth;
    albumPhoto.classList.add('photo-in');
  }
  for (const thumb of thumbStrip.children) {
    const isActive = Number(thumb.dataset.index) === activePhoto;
    thumb.classList.toggle('is-active', isActive);
    if (isActive) thumb.setAttribute('aria-current', 'true');
    else thumb.removeAttribute('aria-current');
  }
  const next = photos[(activePhoto + 1) % photos.length];
  if (next) {
    const preload = new Image();
    preload.src = next.src;
  }
}

function createThumbnails() {
  thumbStrip.replaceChildren();
  photos.forEach((photo, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumb-button';
    button.dataset.index = String(index);
    button.setAttribute('aria-label', `${photo.title} anzeigen`);
    const image = document.createElement('img');
    image.src = photo.src;
    image.alt = '';
    image.loading = 'lazy';
    button.append(image);
    button.addEventListener('click', () => updatePhoto(index));
    thumbStrip.append(button);
  });
  thumbTotal.textContent = `${photos.length} ${photos.length === 1 ? 'kleiner Moment' : 'kleine Momente'}`;
}

async function unlockAlbum() {
  setBusy(bookSubmit, true);
  bookError.textContent = '';
  try {
    const unlock = await api('/api/book-unlock', {
      method: 'POST',
      body: JSON.stringify({ code: bookInput.value })
    });
    if (!unlock.response.ok) {
      bookError.textContent = unlock.data.message || 'Das Codewort stimmt noch nicht, bby 💗';
      return;
    }
    let photoList = unlock.data.photos;
    if (!Array.isArray(photoList)) {
      const ticket = unlock.data.token || savedSessionToken();
      const listUrl = ticket ? `/api/photos?ticket=${encodeURIComponent(ticket)}` : '/api/photos';
      const list = await api(listUrl);
      if (!list.response.ok || !Array.isArray(list.data.photos)) {
        bookError.textContent = list.data.message || 'Dein Fotoalbum konnte gerade nicht geladen werden. Versuch es gleich noch einmal.';
        return;
      }
      photoList = list.data.photos;
    }
    photos = photoList;
    activePhoto = 0;
    createThumbnails();
    updatePhoto(0, false);
    album.hidden = false;
    closeModal();
    openPhotoViewer();
  } catch {
    bookError.textContent = 'Du bist gerade offline, bby. Versuch es gleich noch einmal.';
  } finally {
    setBusy(bookSubmit, false);
  }
}

function setSlideshowButton(playing) {
  [slideshowButton, viewerPlayButton].forEach(button => {
    button.setAttribute('aria-pressed', String(playing));
    const icon = button.querySelector('.control-icon');
    const label = button.querySelector('span:last-child');
    if (icon) icon.textContent = playing ? 'Ⅱ' : '▶';
    if (label) label.textContent = playing ? 'Diashow pausieren' : 'Diashow starten';
  });
}

function startSlideshow() {
  if (!photos.length || slideshowTimer) return;
  slideshowTimer = window.setInterval(() => updatePhoto(activePhoto + 1), 4300);
  setSlideshowButton(true);
  startLoveMusic();
}

function stopSlideshow() {
  if (slideshowTimer) window.clearInterval(slideshowTimer);
  slideshowTimer = null;
  setSlideshowButton(false);
}

function setMusicButton(playing) {
  [musicButton, viewerMusicButton].forEach(button => {
    button.setAttribute('aria-pressed', String(playing));
    const icon = button.querySelector('.control-icon');
    const label = button.querySelector('span:last-child');
    if (icon) icon.textContent = playing ? '♫' : '♪';
    if (label) label.textContent = playing ? 'Musik pausieren' : 'Musik einschalten';
  });
}

function playTone(frequency, startAt, duration, volume, type = 'sine') {
  if (!audioContext || !masterGain) return;
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();
  const endAt = startAt + duration;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  envelope.gain.setValueAtTime(0.0001, startAt);
  envelope.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0002), startAt + Math.min(0.12, duration * 0.2));
  envelope.gain.setValueAtTime(Math.max(volume * 0.62, 0.0002), Math.max(startAt + 0.13, endAt - 0.14));
  envelope.gain.exponentialRampToValueAtTime(0.0001, endAt);
  oscillator.connect(envelope);
  envelope.connect(masterGain);
  oscillator.start(startAt);
  oscillator.stop(endAt + 0.025);
}

const loveProgression = [
  { chord: [261.63, 329.63, 392.00, 493.88], melody: [523.25, 392.00, 329.63, 392.00] }, // Cmaj7
  { chord: [220.00, 261.63, 329.63, 392.00], melody: [440.00, 392.00, 329.63, 261.63] }, // Am7
  { chord: [174.61, 220.00, 261.63, 329.63], melody: [392.00, 349.23, 329.63, 261.63] }, // Fmaj7
  { chord: [196.00, 246.94, 293.66, 392.00], melody: [392.00, 440.00, 493.88, 392.00] }  // Gadd9
];
const chordDuration = 1.9;

function scheduleLovePhrase() {
  if (!musicOn || !audioContext) return;
  const firstBeat = audioContext.currentTime + 0.12;
  loveProgression.forEach((bar, barIndex) => {
    const startAt = firstBeat + barIndex * chordDuration;
    bar.chord.forEach((frequency, noteIndex) => {
      playTone(frequency / (noteIndex === 0 ? 1 : 1), startAt, chordDuration * 1.02, noteIndex === 0 ? 0.018 : 0.011, 'sine');
    });
    bar.melody.forEach((frequency, noteIndex) => {
      playTone(frequency, startAt + 0.08 + noteIndex * 0.42, 0.48, 0.014, 'triangle');
    });
  });
  musicTimer = window.setTimeout(scheduleLovePhrase, chordDuration * loveProgression.length * 1000 - 100);
}

async function startLoveMusic() {
  if (musicOn) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    showToast('Dein Browser kann die Melodie leider nicht abspielen.');
    return;
  }
  try {
    if (!audioContext) {
      audioContext = new AudioContextClass();
      masterGain = audioContext.createGain();
      masterGain.gain.value = 0.0001;
      masterGain.connect(audioContext.destination);
    }
    await audioContext.resume();
    masterGain.gain.cancelScheduledValues(audioContext.currentTime);
    masterGain.gain.setTargetAtTime(0.42, audioContext.currentTime, 0.12);
    musicOn = true;
    setMusicButton(true);
    scheduleLovePhrase();
  } catch {
    musicOn = false;
    setMusicButton(false);
    showToast('Die Musik konnte nicht gestartet werden — tippe es bitte noch einmal an.');
  }
}

function stopLoveMusic() {
  musicOn = false;
  if (musicTimer) window.clearTimeout(musicTimer);
  musicTimer = null;
  if (audioContext && masterGain) {
    masterGain.gain.cancelScheduledValues(audioContext.currentTime);
    masterGain.gain.setTargetAtTime(0.0001, audioContext.currentTime, 0.06);
  }
  setMusicButton(false);
}

async function restoreFromSession() {
  try {
    const status = await api('/api/status');
    if (!status.response.ok || !status.data.siteUnlocked) return;
    // Only restore the love letter. The photo book must be unlocked again
    // on this page view, so pictures never reappear merely from a saved session.
    showGiftSite();
  } catch {
    // The entry page remains visible when the server cannot be reached.
  }
}

window.addEventListener('pagehide', () => {
  if (!album.hidden) {
    album.hidden = true;
    photoViewer.hidden = true;
    document.body.classList.remove('viewer-open', 'modal-open');
    albumPhoto.removeAttribute('src');
    photoViewerImage.removeAttribute('src');
    thumbStrip.replaceChildren();
    photos = [];
    activePhoto = 0;
    stopSlideshow();
    stopLoveMusic();
  }
});

gateForm.addEventListener('submit', async event => {
  event.preventDefault();
  gateError.textContent = '';
  const button = gateForm.querySelector('button[type="submit"]');
  setBusy(button, true);
  try {
    const result = await api('/api/unlock', {
      method: 'POST',
      body: JSON.stringify({ code: gateInput.value })
    });
    if (result.response.ok) {
      showGiftSite();
      gateInput.value = '';
    } else {
      gateError.textContent = result.data.message || 'Fast, bby — probier den Code noch einmal 💌';
      gateInput.select();
    }
  } catch {
    gateError.textContent = 'Du bist gerade offline. Versuch es bitte noch einmal.';
  } finally {
    setBusy(button, false);
  }
});

bookButton.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', event => {
  if (event.target.matches('[data-close-modal]')) closeModal();
});
bookForm.addEventListener('submit', event => {
  event.preventDefault();
  unlockAlbum();
});

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !modal.hidden) closeModal();
  else if (event.key === 'Escape' && !photoViewer.hidden) closePhotoViewer();
  if (modal.hidden && !album.hidden && photos.length && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    if (event.key === 'ArrowLeft') updatePhoto(activePhoto - 1);
    if (event.key === 'ArrowRight') updatePhoto(activePhoto + 1);
  }
});

photoFullscreenOpen.addEventListener('click', openPhotoViewer);
albumPhoto.addEventListener('click', openPhotoViewer);
photoViewerClose.addEventListener('click', closePhotoViewer);
photoViewerPrev.addEventListener('click', () => updatePhoto(activePhoto - 1));
photoViewerNext.addEventListener('click', () => updatePhoto(activePhoto + 1));
photoViewer.addEventListener('click', event => {
  if (event.target.matches('[data-close-viewer]')) closePhotoViewer();
});
previousPhoto.addEventListener('click', () => updatePhoto(activePhoto - 1));
nextPhoto.addEventListener('click', () => updatePhoto(activePhoto + 1));
const toggleSlideshow = () => slideshowTimer ? stopSlideshow() : startSlideshow();
const toggleMusic = () => musicOn ? stopLoveMusic() : startLoveMusic();
slideshowButton.addEventListener('click', toggleSlideshow);
viewerPlayButton.addEventListener('click', toggleSlideshow);
musicButton.addEventListener('click', toggleMusic);
viewerMusicButton.addEventListener('click', toggleMusic);

restoreFromSession();
