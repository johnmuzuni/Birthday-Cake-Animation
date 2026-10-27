/* ============================================================
   Birthday reel page
   - the reel keeps playing as a soft backdrop
   - the reel opens with the same cake-building animation as the
     index page, then every photo rides a ring around the cake
   - the photo at the front of the ring lingers, then the ring
     turns to the next one
   - the uploaded song loops gaplessly (first 10 seconds only)
============================================================ */
(() => {
  'use strict';

  const SLIDE_MS = 10000;
  const FADE_MS = 1200;
  const MAX_PHOTOS = 10;
  const MAX_AUDIO_SECONDS = 10;
  const TAU = Math.PI * 2;
  const REDUCED = Boolean(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  // The cake builds for as long as it does on the index page (the last
  // SMIL layer ends at 6.6s, candles drop at 6s, flames light at 6.5s).
  const INTRO_MS = 7200;
  // How long the front photo shows in the foreground (5s), and how
  // long the ring takes to turn one photo further.
  const HOLD_MS = REDUCED ? 7000 : 5000;
  const ROTATE_MS = REDUCED ? 0 : 1000;
  // How much the foreground photo's frame magnifies. Kept in sync with
  // `.orbit-slot.is-front .orbit-frame` in reel.css — the ring solver
  // reserves headroom for it so the zoomed card never crowds the cake.
  const FRONT_ZOOM = 1.12;
  const EFFECTS = [
    'is-pan-left',
    'is-pan-up',
    'is-pan-right',
    'is-pan-down',
    'is-zoom-in',
    'is-zoom-out',
  ];

  const $ = (id) => document.getElementById(id);

  const els = {
    slides: $('reelSlides'),
    orbit: $('reelOrbit'),
    controls: document.querySelector('.reel-controls'),
    caption: document.querySelector('.reel-caption'),
    cakeWrap: document.querySelector('.cake-wrap'),
    dots: $('reelDots'),
    progress: $('reelProgress'),
    muteBtn: $('muteBtn'),
    muteIconOn: $('muteIconOn'),
    muteIconOff: $('muteIconOff'),
    soundPrompt: $('soundPrompt'),
    soundBtn: $('soundBtn'),
    empty: $('reelEmpty'),
    toast: $('reelToast'),
    cake: $('cake'),
  };

  const state = {
    photos: [],
    layers: [],
    orbitCards: [],
    layout: null,
    ring: null,
    frameSizes: [],
    running: false,
    audioBlob: null,
    audioEl: null,
    ctx: null,
    decoded: null,
    source: null,
    gain: null,
    hasAudio: false,
    audioStarted: false,
    muted: false,
    layer: 0,
    index: -1,
    phase: 'intro',
    phaseT: 0,
    spin: 0,
    spinFrom: 0,
    frontIdx: 0,
    last: 0,
    raf: 0,
    clipTimer: 0,
    toastTimer: 0,
    fadeMs: FADE_MS,
  };

  /* ---------------------------------------------- helpers */

  const wait = (ms) => new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, 3200);
  }

  /* ---------------------------------------------- the cake */

  function initCake() {
    if (!els.cake) return;
    try {
      // Play the whole cake-building animation, exactly like index.html.
      els.cake.setCurrentTime(0);
      if (typeof els.cake.unpauseAnimations === 'function') {
        els.cake.unpauseAnimations();
      }
    } catch (error) {
      /* SMIL is not supported; the CSS parts still work */
    }
  }

  function fitCake(multiplier) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const widthFactor = width < 640 ? 0.5 : 0.3;
    const widthRoom = width * widthFactor;
    const heightRoom = height * 0.3;

    // The visible cake (including its flame) is about 180 x 124 units.
    // The multiplier is only turned down on cramped screens where the
    // cake would otherwise leave the photo ring no room to pass.
    const scale = Math.max(
      0.85,
      Math.min(2.15, widthRoom / 180, heightRoom / 124)
    ) * (multiplier || 1);

    document.documentElement.style.setProperty(
      '--cake-scale',
      scale.toFixed(3)
    );
  }

  /* ---------------------------------------------- slides */

  function buildSlides() {
    els.slides.innerHTML = '';
    state.layers = [];

    for (let i = 0; i < 2; i += 1) {
      const layer = document.createElement('div');
      layer.className = 'frame-slide';

      const image = document.createElement('img');
      image.className = 'frame-img';
      image.alt = '';
      image.draggable = false;
      image.decoding = 'async';

      layer.appendChild(image);
      els.slides.appendChild(layer);
      state.layers.push(layer);
    }
  }

  function buildDots() {
    els.dots.innerHTML = '';
    state.photos.forEach((photo, index) => {
      const dot = document.createElement('span');
      dot.className = 'reel-dot';
      if (index === 0) dot.classList.add('is-active');
      els.dots.appendChild(dot);
    });
  }

  function updateDots(index) {
    const dots = els.dots.children;
    for (let i = 0; i < dots.length; i += 1) {
      dots[i].classList.toggle('is-active', i === index);
    }
  }

  function showSlide(index, instant) {
    const photo = state.photos[index];
    if (!photo || state.layers.length < 2) return;

    state.layer = state.layer === 0 ? 1 : 0;
    const layer = state.layers[state.layer];
    const other = state.layers[state.layer === 0 ? 1 : 0];
    const image = layer.querySelector('.frame-img');

    // Reset the incoming layer to fully transparent without animating
    // the reset itself, so it can fade in over the layer underneath.
    layer.style.transition = 'none';
    layer.classList.remove('is-live');
    void layer.offsetWidth;

    image.className = 'frame-img';
    void image.offsetWidth;

    image.src = photo.url;
    image.classList.add(EFFECTS[index % EFFECTS.length]);

    layer.style.zIndex = '2';
    if (other) other.style.zIndex = '1';
    layer.style.setProperty('--fade', instant ? '0ms' : `${state.fadeMs}ms`);
    layer.style.setProperty('--dur', `${SLIDE_MS + state.fadeMs}ms`);

    if (instant) {
      layer.classList.add('is-live');
      void layer.offsetWidth;
      layer.style.transition = '';
    } else {
      requestAnimationFrame(() => {
        layer.style.transition = '';
        layer.classList.add('is-live');
      });
    }

    state.index = index;
    updateDots(index);
    els.progress.style.transform = 'scaleX(0)';
  }

  function startReel() {
    if (!state.photos.length || state.layers.length < 2) return;

    state.running = false;
    window.cancelAnimationFrame(state.raf);

    state.layers.forEach((layer) => {
      layer.style.transition = 'none';
      layer.classList.remove('is-live');
      layer.style.zIndex = '1';
    });
    void els.slides.offsetWidth;
    state.layers.forEach((layer) => {
      layer.style.transition = '';
    });

    state.layer = 0;
    state.index = -1;
    state.phase = 'intro';
    state.phaseT = 0;
    state.spin = 0;
    state.spinFrom = 0;
    state.frontIdx = 0;
    state.orbitCards.forEach((slot) => {
      slot.classList.remove('is-live', 'is-front');
    });

    state.last = performance.now();
    state.running = true;
    state.raf = requestAnimationFrame(tick);
  }

  const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - ((-2 * p + 2) ** 3) / 2);

  // The photo cards fade up only as the cake finishes building, so the
  // reel opens on the cake first, exactly like the index page.
  function introFade() {
    if (state.phase !== 'intro') return 1;
    const from = INTRO_MS - 900;
    return Math.min(1, Math.max(0, (state.phaseT - from) / 900));
  }

  function tick(now) {
    if (!state.running) return;

    const dt = Math.min(80, Math.max(0, now - state.last));
    state.last = now;
    const count = state.photos.length;
    const ring = state.ring;

    if (state.phase === 'intro') {
      state.phaseT += dt;
      if (state.phaseT >= INTRO_MS - 900) {
        state.orbitCards.forEach((slot) => slot.classList.add('is-live'));
      }
      if (state.phaseT >= INTRO_MS) {
        state.phase = 'hold';
        state.phaseT = 0;
        showSlide(0, false);
      }
    } else if (state.phase === 'hold') {
      state.phaseT += dt;
      // One photo lingers at the front, then the ring turns onward.
      if (count > 1 && ring && state.phaseT >= HOLD_MS) {
        state.phase = 'rotate';
        state.phaseT = 0;
        state.spinFrom = state.spin;
      }
    } else if (state.phase === 'rotate' && ring) {
      state.phaseT += dt;
      const p = Math.min(1, state.phaseT / Math.max(1, ROTATE_MS));
      state.spin = state.spinFrom + ring.step * easeInOutCubic(p);
      if (p >= 1) {
        state.spinFrom += ring.step;
        state.spin = state.spinFrom;
        state.frontIdx = (state.frontIdx + 1) % count;
        state.phase = 'hold';
        state.phaseT = 0;
        showSlide(state.frontIdx, false);
      }
    }

    // The progress bar fills once per photo: linger plus one turn.
    const cycle = HOLD_MS + ROTATE_MS;
    const done = state.phase === 'intro'
      ? 0
      : count <= 1
        ? cycle
        : state.phase === 'rotate'
          ? HOLD_MS + state.phaseT
          : state.phaseT;
    els.progress.style.transform = `scaleX(${Math.min(1, done / cycle)})`;

    renderFrame(introFade());

    state.raf = requestAnimationFrame(tick);
  }

  /* ---------------------------------------------- orbit cards */

  function buildOrbit() {
    if (!els.orbit) return;

    els.orbit.innerHTML = '';
    state.orbitCards = [];

    // Every photo gets its own card for the lifetime of the reel; the
    // ring simply carries them all around the cake.
    state.photos.forEach((photo, index) => {
      const slot = document.createElement('div');
      slot.className = 'orbit-slot';

      const card = document.createElement('article');
      card.className = 'orbit-card';

      const frame = document.createElement('div');
      frame.className = 'orbit-frame';

      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.decoding = 'async';
      image.className = `orbit-img ${EFFECTS[index % EFFECTS.length]}`;
      image.src = photo.url;
      image.style.setProperty('--dur', `${SLIDE_MS}ms`);

      const tape = document.createElement('span');
      tape.className = 'card-tape';
      tape.setAttribute('aria-hidden', 'true');

      frame.appendChild(image);
      card.append(frame, tape);

      // The text the user wrote for this photo lives in the card's
      // bottom margin and only shows while the card is in front.
      if (photo.caption) {
        const note = document.createElement('p');
        note.className = 'orbit-note';
        note.textContent = photo.caption;
        note.setAttribute('aria-hidden', 'true');
        card.appendChild(note);
      }

      slot.appendChild(card);
      els.orbit.appendChild(slot);
      state.orbitCards.push(slot);
    });
  }

  function frameSizeFor(photo, layout) {
    // Keep a card in proportion with its own photo, with a sanity limit
    // so extreme panoramas or strips still make a usable frame.
    const aspect = Math.min(2.4, Math.max(0.42, photo.aspect || 0.8));
    const availableW = Math.max(56, layout.maxCardW - layout.pad * 2);
    const availableH = Math.max(56, layout.maxCardH - layout.pad - layout.bottomPad);

    let width = availableW;
    let height = width / aspect;
    if (height > availableH) {
      height = availableH;
      width = height * aspect;
    }

    return {
      w: Math.max(1, Math.round(width)),
      h: Math.max(1, Math.round(height)),
      pad: layout.pad,
      bottomPad: layout.bottomPad,
    };
  }

  function measureLayout(scale) {
    const rect = els.orbit.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const centerX = width / 2;
    const centerY = height / 2;

    const pad = Math.round(Math.min(10, Math.max(6, width * 0.0085)));
    // A card that shows a note needs a deeper bottom margin to hold one
    // clean line of caption plus breathing room; the ring is solved
    // against the deeper cards either way. The bump is kept modest so a
    // captioned photo barely changes the card's height (the front card's
    // top edge has to stay clear of the cake). On short screens (a
    // phone turned sideways) there is no vertical room for that, so the
    // cards keep their plain height and the note just sets smaller.
    const hasNotes = state.photos.some((photo) => photo.caption);
    const bottomPad = Math.round(pad * (hasNotes && height > 420 ? 3.6 : 2.6));
    const maxCardW = Math.min(250, Math.max(120, width * 0.25)) * scale;
    const maxCardH = Math.min(300, Math.max(148, height * 0.31)) * scale;

    const cakeRect = els.cakeWrap.getBoundingClientRect();
    const controlsRect = els.controls.getBoundingClientRect();

    // Use the caption's layout position, not its animated box, so the
    // cards stay above it even while its entrance animation is running.
    const captionTop = rect.top + els.caption.offsetTop;
    const safeTopViewport = Math.max(rect.top + 8, controlsRect.bottom + 8);
    const safeBottomViewport = Math.min(rect.bottom - 8, captionTop - 10);

    const layout = {
      width,
      height,
      scale,
      pad,
      bottomPad,
      maxCardW,
      maxCardH,
      cake: {
        x: cakeRect.left - rect.left + cakeRect.width / 2 - centerX,
        y: cakeRect.top - rect.top + cakeRect.height / 2 - centerY,
        hw: cakeRect.width / 2 + 4,
        hh: cakeRect.height / 2 + 4,
      },
      safe: {
        left: 10 - centerX,
        right: width - 10 - centerX,
        top: safeTopViewport - rect.top - centerY,
        bottom: safeBottomViewport - rect.top - centerY,
      },
    };

    layout.frameSizes = state.photos.map((photo) => frameSizeFor(photo, layout));
    layout.maxOuterW = layout.frameSizes.reduce(
      (max, frame) => Math.max(max, frame.w + frame.pad * 2),
      0
    );
    layout.maxOuterH = layout.frameSizes.reduce(
      (max, frame) => Math.max(max, frame.h + frame.pad + frame.bottomPad),
      0
    );

    return layout;
  }

  // The front photo sits low and proud; with many photos it eases back
  // a little so its neighbours stay readable around the ring.
  const ringFrontScale = (count) => Math.max(1.05, Math.min(1.35, 1.35 - Math.max(0, count - 4) * 0.05));

  // Depth 0 is the back of the ring (far, small), 1 the front (near,
  // large). The mild curve keeps side cards from collapsing too fast.
  const ringDepth = (depth, back, front) => back + (front - back) * Math.pow(depth, 0.7);

  // Solve the ellipse the ring travels on, centred on the cake. It must
  // clear the cake at its sides (so the front/back z-switch never pops
  // over the cake), keep back cards clear of the candles, and rest the
  // front card below the cake's middle so the cake stays shown.
  function solveRing(layout) {
    const count = Math.max(1, state.photos.length);
    const { cake, safe } = layout;
    const halfW = (layout.maxOuterW + 2) / 2;
    const halfH = (layout.maxOuterH + 2) / 2;
    const back = 0.5;
    const front = 1 + (ringFrontScale(count) - 1) * layout.scale;

    // Vertical bounds. Upper: stay inside the header/caption band. The
    // front card's allowance is inflated by the 1.08 foreground zoom so
    // that when the frame magnifies, its top edge still clears the safe
    // band instead of poking above it.
    const zoom = FRONT_ZOOM + 0.04;
    const ryMax = Math.min(
      cake.y - safe.top - halfH * back,
      safe.bottom - cake.y - halfH * front * zoom
    );
    const ryMin = Math.max(
      14,
      cake.hh + halfH * back * 0.8,
      cake.hh * layout.frontDrop + halfH * front * zoom
    );
    // If even the tightest ring pokes out of the safe box, reject and
    // let the caller shrink the cards before trying again.
    if (ryMax < Math.max(14, ryMin)) return null;
    const ry = Math.max(14, ryMin);

    // Horizontal bounds: at the sides the card must clear the cake.
    const sideScale = ringDepth(0.5, back, front);
    const rxNeed = cake.hw + halfW * sideScale + 2;
    const rxMax = Math.min(
      cake.x - safe.left - halfW * sideScale,
      safe.right - cake.x - halfW * sideScale
    );
    if (rxMax < rxNeed) return null;

    // Keep the ring reading as a circle rather than a flat oval.
    const rx = Math.min(rxMax, Math.max(rxNeed, ry * 1.45));
    const step = TAU / count;

    // Final check on every resting angle. The ring only ever rotates
    // through these, so the whole motion is covered.
    for (let i = 0; i < count; i += 1) {
      const theta = Math.PI + i * step;
      const depth = (1 - Math.cos(theta)) / 2;
      const scale = ringDepth(depth, back, front);
      const x = cake.x + Math.sin(theta) * rx;
      const y = cake.y - Math.cos(theta) * ry;
      const w = halfW * scale;
      const h = halfH * scale;

      if (x - w < safe.left - 1 || x + w > safe.right + 1) return null;
      if (y - h < safe.top - 1 || y + h > safe.bottom + 1) return null;
    }

    return { cx: cake.x, cy: cake.y, rx, ry, step, back, front };
  }

  // Last resort for a pathological screen: clamp the ring into the safe
  // box and let the cards overlap the cake rather than leave the page.
  function clampRing(layout) {
    const count = Math.max(1, state.photos.length);
    const { cake, safe } = layout;
    const halfW = (layout.maxOuterW + 2) / 2;
    const halfH = (layout.maxOuterH + 2) / 2;
    const back = 0.5;
    const front = 1 + (ringFrontScale(count) - 1) * layout.scale;
    const sideScale = ringDepth(0.5, back, front);

    const ry = Math.max(6, Math.min(
      cake.y - safe.top - halfH * back,
      safe.bottom - cake.y - halfH * front
    ));
    const rx = Math.max(6, Math.min(
      cake.x - safe.left - halfW * sideScale,
      safe.right - cake.x - halfW * sideScale
    ));

    return { cx: cake.x, cy: cake.y, rx, ry, step: TAU / count, back, front };
  }

  // Try the roomy layout first. On cramped screens, first shrink the
  // cards, then give the cake a nudge smaller so the ring has room to
  // pass it, and only as a last resort let the front card ride higher
  // over the cake's lower half.
  function planOrbit() {
    const scales = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.36];
    const steps = [
      { cakeMul: 1, frontDrop: 0.5 },
      { cakeMul: 0.8, frontDrop: 0.1 },
      { cakeMul: 0.64, frontDrop: -0.15 },
      { cakeMul: 0.5, frontDrop: -0.5 },
    ];

    for (let s = 0; s < steps.length; s += 1) {
      fitCake(steps[s].cakeMul);
      for (let i = 0; i < scales.length; i += 1) {
        const layout = measureLayout(scales[i]);
        layout.frontDrop = steps[s].frontDrop;
        const ring = solveRing(layout);
        if (ring) return { layout, ring };
      }
    }

    const layout = measureLayout(scales[scales.length - 1]);
    layout.frontDrop = steps[steps.length - 1].frontDrop;
    return { layout, ring: clampRing(layout) };
  }

  function layoutOrbit() {
    if (!state.photos.length || !els.orbit || !state.orbitCards.length) return;

    // planOrbit picks the cake scale together with the ring, so the
    // two always fit each other.
    const plan = planOrbit();
    state.layout = plan.layout;
    state.ring = plan.ring;
    state.frameSizes = plan.layout.frameSizes;

    state.orbitCards.forEach((slot, index) => {
      const size = state.frameSizes[index];
      if (size) applyCardSize(slot, size);
    });

    renderFrame(introFade());
  }

  function applyCardSize(slot, size) {
    const card = slot.querySelector('.orbit-card');
    const frame = slot.querySelector('.orbit-frame');
    if (!card || !frame) return;

    card.style.padding = `${size.pad}px ${size.pad}px ${size.bottomPad}px`;
    frame.style.width = `${size.w}px`;
    frame.style.height = `${size.h}px`;

    // Seat the note below the frame, leaving room for how far the 1.12
    // foreground zoom pushes the frame's bottom edge downward. It fades
    // in only while this card is in front.
    const note = slot.querySelector('.orbit-note');
    if (note) {
      const overhang = Math.ceil(size.h * (FRONT_ZOOM - 1) / 2);
      const noteBottom = Math.max(3, Math.round(size.pad * 0.4)) + overhang;
      const noteHeight = Math.max(12, size.bottomPad - noteBottom);
      note.style.bottom = `${noteBottom}px`;
      note.style.height = `${noteHeight}px`;
      note.style.lineHeight = `${noteHeight}px`;
    }
  }

  // Position every card on the ring for one frame: the ring's near
  // half sweeps in front of the cake, its far half slips behind.
  function renderFrame(fade) {
    const ring = state.ring;
    if (!ring) return;

    for (let i = 0; i < state.orbitCards.length; i += 1) {
      const slot = state.orbitCards[i];
      const theta = Math.PI + i * ring.step - state.spin;
      const cos = Math.cos(theta);
      const depth = (1 - cos) / 2;
      const scale = ringDepth(depth, ring.back, ring.front);
      const x = ring.cx + Math.sin(theta) * ring.rx;
      const y = ring.cy - cos * ring.ry;

      slot.style.setProperty('--x', `${x.toFixed(1)}px`);
      slot.style.setProperty('--y', `${y.toFixed(1)}px`);
      slot.style.setProperty('--scale', scale.toFixed(3));
      slot.style.setProperty('--tilt', `${(Math.sin(theta) * 13).toFixed(2)}deg`);
      // Far cards dim a little so the front photo leads the eye.
      slot.style.setProperty('--o', (fade * (0.5 + 0.5 * depth)).toFixed(3));

      // The z-switch happens exactly at the ring's sides, where the
      // layout guarantees the cards clear the cake, so it never pops.
      slot.style.zIndex = depth > 0.5 ? '7' : '5';
      slot.classList.toggle(
        'is-front',
        i === state.frontIdx && state.phase !== 'intro'
      );
    }
  }

  /* ---------------------------------------------- audio */

  function getAudioContext() {
    if (!state.ctx) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) throw new Error('Web Audio is not available');
      state.ctx = new AudioCtor();
    }
    return state.ctx;
  }

  // Copy the first 10 seconds into a fresh buffer, with 2ms fades at
  // both ends so the loop point cannot click. The fades are kept tiny
  // on purpose: any longer and every loop hears a volume dip.
  function makeClipBuffer(ctx, decoded, maxSeconds) {
    const rate = decoded.sampleRate;
    const length = Math.max(1, Math.min(decoded.length, Math.ceil(rate * maxSeconds)));
    const clip = ctx.createBuffer(decoded.numberOfChannels, length, rate);
    const fadeIn = Math.min(Math.floor(rate * 0.002), Math.max(0, length - 1));
    const fadeOut = Math.min(Math.floor(rate * 0.002), Math.max(0, length - 1));

    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const source = decoded.getChannelData(channel);
      const target = clip.getChannelData(channel);
      target.set(source.subarray(0, length));

      for (let i = 0; i < fadeIn; i += 1) {
        target[i] *= i / fadeIn;
      }
      for (let i = 0; i < fadeOut; i += 1) {
        target[length - 1 - i] *= i / fadeOut;
      }
    }

    return clip;
  }

  function useAudioElement() {
    const element = new Audio();
    element.preload = 'auto';
    element.loop = true;
    element.muted = state.muted;
    element.volume = 0.8;

    element.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(element.duration) && element.duration > MAX_AUDIO_SECONDS + 0.15) {
        element.loop = false;
      }
    }, { once: true });

    element.addEventListener('timeupdate', () => {
      if (element.loop) return;
      armClipEnd(element);
    });

    element.addEventListener('pause', () => {
      window.clearTimeout(state.clipTimer);
    });

    element.src = URL.createObjectURL(state.audioBlob);
    state.audioEl = element;
    state.hasAudio = true;
  }

  // The <audio> fallback loops by seeking back to zero. Schedule that
  // seek a whisker before the clip ends instead of polling with
  // "timeupdate" (which lands up to a quarter second late), so the
  // loop point stays tight.
  function armClipEnd(element) {
    window.clearTimeout(state.clipTimer);
    if (element.loop || element.paused) return;

    const limit = Math.min(
      MAX_AUDIO_SECONDS,
      Number.isFinite(element.duration) && element.duration > 0
        ? element.duration
        : MAX_AUDIO_SECONDS
    );
    const left = limit - element.currentTime;
    if (left <= 0) return;

    state.clipTimer = window.setTimeout(() => {
      try {
        element.currentTime = 0;
        if (element.paused) element.play().catch(() => {});
      } catch (error) {
        /* ignore */
      }
    }, Math.max(0, left * 1000 - 12));
  }

  async function prepareAudio() {
    if (!state.audioBlob) return;

    try {
      const ctx = getAudioContext();
      const raw = await state.audioBlob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(raw);
      state.decoded = makeClipBuffer(ctx, decoded, MAX_AUDIO_SECONDS);
      state.hasAudio = true;
      return;
    } catch (error) {
      /* Fall back to a plain audio element below. */
    }

    try {
      useAudioElement();
    } catch (error) {
      state.hasAudio = false;
    }
  }

  function stopSource() {
    if (state.source) {
      try {
        state.source.stop();
      } catch (error) {
        /* already stopped */
      }
      try {
        state.source.disconnect();
      } catch (error) {
        /* ignore */
      }
      state.source = null;
    }

    if (state.gain) {
      try {
        state.gain.disconnect();
      } catch (error) {
        /* ignore */
      }
      state.gain = null;
    }
  }

  async function startAudio() {
    if (!state.hasAudio || state.audioStarted) return false;

    if (state.decoded) {
      try {
        const ctx = getAudioContext();

        if (ctx.state !== 'running') {
          const resumed = Promise.resolve(ctx.resume()).catch(() => {});
          await Promise.race([resumed, wait(280)]);
        }

        if (ctx.state !== 'running') return false;

        stopSource();

        const source = ctx.createBufferSource();
        source.buffer = state.decoded;
        source.loop = true;

        const gain = ctx.createGain();
        const now = ctx.currentTime;
        const level = state.muted ? 0.0001 : 0.8;

        gain.gain.setValueAtTime(0.0001, now);
        if (level > 0.0001) {
          gain.gain.exponentialRampToValueAtTime(level, now + 0.5);
        }

        source.connect(gain).connect(ctx.destination);
        source.start(now);

        state.source = source;
        state.gain = gain;
        state.audioStarted = true;
        return true;
      } catch (error) {
        return false;
      }
    }

    if (state.audioEl) {
      try {
        state.audioEl.currentTime = 0;
        state.audioEl.muted = state.muted;
        state.audioEl.volume = 0.8;
        await state.audioEl.play();
        armClipEnd(state.audioEl);
        state.audioStarted = true;
        return true;
      } catch (error) {
        return false;
      }
    }

    return false;
  }

  function showSoundPrompt() {
    if (!state.hasAudio || state.audioStarted || !state.photos.length) return;
    els.soundPrompt.hidden = false;
  }

  function hideSoundPrompt() {
    els.soundPrompt.hidden = true;
  }

  function applyMuteIcon() {
    els.muteIconOn.hidden = state.muted;
    els.muteIconOff.hidden = !state.muted;
    els.muteBtn.setAttribute(
      'aria-label',
      state.muted ? 'Unmute music' : 'Mute music'
    );
  }

  function toggleMute() {
    if (!state.audioStarted) return;

    state.muted = !state.muted;
    applyMuteIcon();

    if (state.gain && state.ctx) {
      const now = state.ctx.currentTime;
      try {
        state.gain.gain.cancelScheduledValues(now);
        state.gain.gain.setTargetAtTime(
          state.muted ? 0.0001 : 0.8,
          now,
          0.05
        );
      } catch (error) {
        /* ignore */
      }
    }

    if (state.audioEl) {
      state.audioEl.muted = state.muted;
    }
  }

  async function attemptAutoplay() {
    if (!state.hasAudio || state.audioStarted) return;

    const started = await startAudio();
    if (!started) {
      showSoundPrompt();
      return;
    }

    hideSoundPrompt();
    els.muteBtn.hidden = false;
    applyMuteIcon();
    // The reel (cake intro included) is already running; only the
    // music joins in here.
  }

  async function onSoundTap() {
    if (state.audioStarted) {
      hideSoundPrompt();
      return;
    }

    const started = await startAudio();
    if (!started) {
      showSoundPrompt();
      showToast('Sound could not start. Tap once more.');
      return;
    }

    hideSoundPrompt();
    els.muteBtn.hidden = false;
    applyMuteIcon();
  }

  /* ---------------------------------------------- empty state */

  function showEmpty() {
    hideSoundPrompt();
    els.empty.hidden = false;
    els.muteBtn.hidden = true;
    document.body.classList.add('is-empty', 'is-ready');
  }

  /* ---------------------------------------------- boot */

  // Resolve each photo's natural shape before laying out the cards, so
  // portrait, square and landscape shots all get a frame that fits them.
  function loadPhotos(items) {
    const probes = items.slice(0, MAX_PHOTOS).map((item, index) => new Promise((resolve) => {
      const url = URL.createObjectURL(item.blob);
      const probe = new Image();
      let settled = false;

      const finish = (ok) => {
        if (settled) return;
        settled = true;

        if (!ok) {
          URL.revokeObjectURL(url);
          resolve(null);
          return;
        }

        const width = probe.naturalWidth;
        const height = probe.naturalHeight;
        resolve({
          url,
          name: item.name || `Photo ${index + 1}`,
          aspect: width > 0 && height > 0 ? width / height : 0.8,
          caption: typeof item.caption === 'string'
            ? item.caption.trim().slice(0, 60)
            : '',
        });
      };

      probe.onload = () => finish(true);
      probe.onerror = () => finish(false);
      window.setTimeout(() => finish(probe.naturalWidth > 0), 7000);
      probe.decoding = 'async';
      probe.src = url;
    }));

    return Promise.all(probes).then((photos) => photos.filter(Boolean));
  }

  async function boot() {
    fitCake();
    initCake();

    if (!window.MediaStore) {
      showEmpty();
      return;
    }

    let record = null;
    try {
      record = await window.MediaStore.load();
    } catch (error) {
      record = null;
    }

    const storedPhotos = record && Array.isArray(record.photos)
      ? record.photos.filter((item) => item && item.blob instanceof Blob)
      : [];

    if (!storedPhotos.length) {
      showEmpty();
      return;
    }

    buildSlides();

    state.photos = await loadPhotos(storedPhotos);

    if (!state.photos.length) {
      showEmpty();
      return;
    }

    state.audioBlob = record.audio && record.audio.blob instanceof Blob
      ? record.audio.blob
      : null;

    buildOrbit();
    buildDots();
    document.body.classList.add('is-ready');

    // Wait one frame so the cake has its final scale before placing cards.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    layoutOrbit();
    startReel();

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (state.layout) layoutOrbit();
      }).catch(() => {});
    }

    prepareAudio().then(() => {
      if (!state.hasAudio) return;
      window.setTimeout(attemptAutoplay, 300);
    });
  }

  /* ---------------------------------------------- events */

  els.soundBtn.addEventListener('click', onSoundTap);
  els.muteBtn.addEventListener('click', toggleMute);

  function handleRelayout() {
    if (!state.photos.length) return;
    window.requestAnimationFrame(layoutOrbit);
  }

  window.addEventListener('resize', handleRelayout);
  window.addEventListener('orientationchange', handleRelayout);

  window.addEventListener('pagehide', () => {
    state.running = false;
    window.cancelAnimationFrame(state.raf);
    window.clearTimeout(state.clipTimer);
    stopSource();
    if (state.audioEl) {
      try {
        state.audioEl.pause();
      } catch (error) {
        /* ignore */
      }
    }
  });

  // Coming back from the back/forward cache: restart the reel and, if it
  // was already playing, try to resume the music too.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !state.photos.length) return;

    startReel();

    if (!state.hasAudio || !state.audioStarted) return;

    state.audioStarted = false;
    startAudio().then((started) => {
      if (started) {
        hideSoundPrompt();
        els.muteBtn.hidden = false;
        applyMuteIcon();
      } else {
        showSoundPrompt();
      }
    });
  });

  boot();
})();
