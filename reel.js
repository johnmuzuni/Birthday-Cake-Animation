/* ============================================================
   Birthday reel page
   - the reel keeps playing as a soft backdrop
   - the reel opens with the same cake-building animation as the
     index page, then every photo rides a ring around the cake
   - the photo at the front of the ring lingers, then the ring
     turns to the next one
   - the uploaded song loops gaplessly (first 30 seconds only)
============================================================ */
(() => {
  'use strict';

  const SLIDE_MS = 10000;
  const FADE_MS = 1200;
  const MAX_PHOTOS = 10;
  const MAX_AUDIO_SECONDS = 30;
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
    view: $('reelView'),
    controls: document.querySelector('.reel-controls'),
    caption: document.querySelector('.reel-caption'),
    quote: $('reelQuote'),
    name: $('reelName'),
    cakeWrap: document.querySelector('.cake-wrap'),
    dots: $('reelDots'),
    progress: $('reelProgress'),
    muteBtn: $('muteBtn'),
    muteIconOn: $('muteIconOn'),
    muteIconOff: $('muteIconOff'),
    downloadBtn: $('downloadBtn'),
    downloadIconIdle: $('downloadIconIdle'),
    downloadIconBusy: $('downloadIconBusy'),
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
    hasCaptions: false,
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
    exporting: false,
    lastExport: null,
    elementSrc: null,
    exportCanvas: null,
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

  // The featured photo at the front of the ring pops far larger than
  // the rest — it magnifies over its polaroid and may even cross the
  // paper's edges (the collage look; the tape above keeps that edge
  // honest). How far it may pop is not a guess: budgetPop measures the
  // actual flame and sentence headroom at the front pose and caps the
  // extra zoom per photo from that (cushions absorb the card's float).
  const FRONT_ZOOM = 1.45;

  function budgetPop(layout, ring) {
    const { cake, safe, flameBottomLay } = layout;
    const front = ring.front;

    layout.frameSizes.forEach((size) => {
      const frameHalf = (size.h / 2) * front;
      // The frame lot rides (pad - bottomPad)/2 off the card's centre
      // (pad above, bottomPad below), and the card's centre rests
      // exactly on the front pose (renderFrame: cos(theta) = -1).
      const centreOff = ((size.pad - size.bottomPad) / 2) * front;
      const frameBaseTop = cake.y + ring.ry + centreOff - frameHalf;
      const frameBaseBottom = cake.y + ring.ry + centreOff + frameHalf;

      // The front card breathes on cardFloat (up to ~3.5px of bounding
      // lift from its -2.5px translate and 0.4deg tilt) and both caps
      // must survive the fit tests' 2.5px line plus rounding, so the
      // caps keep a comfortable cushion rather than touching the limit.
      const cushion = 8;

      let topCap = Infinity;
      if (flameBottomLay !== null) {
        topCap = (frameBaseTop - cushion - flameBottomLay) / frameHalf;
      }
      const botCap = (safe.bottom - cushion - frameBaseBottom) / frameHalf;

      size.popExtra = Math.min(
        FRONT_ZOOM - 1,
        Math.max(0.05, Math.min(topCap, botCap))
      );
    });
  }

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
    // The front photo just changed: its sentence dissolves in below.
    setQuote(index);
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

      // The photo's own words no longer ride the card — they live in
      // the sentence band below the ring (see setQuote).
      frame.appendChild(image);
      card.append(frame, tape);

      slot.appendChild(card);
      els.orbit.appendChild(slot);
      state.orbitCards.push(slot);
    });
  }

  // Each photo's sentence dissolves into the next one below the ring:
  // the two spans cross-fade whenever the front photo changes. A photo
  // without words dissolves into silence (an empty band).
  function setQuote(index) {
    if (!els.quote || els.quote.hidden) return;

    const spans = els.quote.querySelectorAll('.reel-quote-line');
    if (spans.length < 2) return;
    const current = els.quote.querySelector('.reel-quote-line.is-on');
    const incoming = current === spans[0] ? spans[1] : spans[0];
    const text = (state.photos[index] && state.photos[index].caption) || '';

    incoming.textContent = text;
    if (current) current.classList.remove('is-on');
    incoming.classList.add('is-on');
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

    const pad = Math.round(Math.min(12, Math.max(7, width * 0.0095)));
    // The cards' bottom margin is pure polaroid again — the photo's
    // words moved to their own line below the ring. Screens with
    // vertical room get a deeper lip than cramped ones (a phone turned
    // sideways has no spare height at all).
    const bottomPad = Math.round(pad * (height > 420 ? 2.6 : 2.2));
    const maxCardW = Math.min(300, Math.max(140, width * 0.27)) * scale;
    const maxCardH = Math.min(360, Math.max(180, height * 0.37)) * scale;

    const cakeRect = els.cakeWrap.getBoundingClientRect();
    const controlsRect = els.controls.getBoundingClientRect();
    const viewRect = els.view.getBoundingClientRect();

    // The safe box is anchored to the reel's frame (what the tests and
    // the eye check), not to the wider orbit layer. Band boundaries use
    // layout positions (offset chain) rather than animated boxes, so
    // their entrance transitions can't loosen the bounds.
    const viaOffsetChain = (el) => {
      const host = el.offsetParent;
      return host
        ? host.getBoundingClientRect().top + el.offsetTop
        : el.getBoundingClientRect().top;
    };
    const quoteActive = els.quote && els.quote.hidden === false;
    const quoteTop = quoteActive ? viaOffsetChain(els.quote) : null;
    const captionTop = viaOffsetChain(els.caption);
    const safeTopViewport = Math.max(viewRect.top + 8, controlsRect.bottom + 8);
    const safeBottomViewport = Math.min(
      viewRect.bottom - 8,
      captionTop - 10,
      quoteTop === null ? Infinity : quoteTop - 12
    );

    // Where the burning candle tips sit — the pop budget's top limit
    // (converted into layout coordinates like the cake above). This
    // never reads the .fuego rects directly: at measure time the candle
    // still hangs 300px high in its pre-drop pose, which would report
    // the flames ~300px above their true spot. Instead the settled spot
    // comes from the wrap, whose box does not animate: the candle row
    // starts 24px into the wrap (reel.css), the flames hang 20px above
    // their candles with an 18px body (style.css), so the lowest flame
    // edge rests 22px below the wrap's top (24 - 20 + 18). The `fuego`
    // flicker only lifts or shrinks the flames — it never drops them —
    // so that anchor is the worst case at every flicker phase, with or
    // without reduced motion.
    const flameRestUnits = 22; // velas top 24 - fuego top 20 + height 18
    const cakeScale = cakeRect.height / 124; // .cake-wrap is a fixed 200x124 box
    let flameBottomLay = null;
    if (cakeScale > 0) {
      flameBottomLay = cakeRect.top - rect.top - centerY + flameRestUnits * cakeScale;
    }

    const layout = {
      width,
      height,
      scale,
      pad,
      bottomPad,
      maxCardW,
      maxCardH,
      flameBottomLay,
      cake: {
        x: cakeRect.left - rect.left + cakeRect.width / 2 - centerX,
        y: cakeRect.top - rect.top + cakeRect.height / 2 - centerY,
        hw: cakeRect.width / 2 + 4,
        hh: cakeRect.height / 2 + 4,
      },
      safe: {
        left: viewRect.left - rect.left + 6 - centerX,
        right: viewRect.right - rect.left - 6 - centerX,
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
  const ringFrontScale = (count) => Math.max(1.15, Math.min(1.5, 1.5 - Math.max(0, count - 4) * 0.045));

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
    const reject = (why) => {
      planLog.push({ scale: layout.scale, step: layout.step, frontDrop: layout.frontDrop, why });
      return null;
    };

    // Vertical bounds. Upper: stay inside the header/caption band.
    // Lower: how close the ring may hug the cake — back cards must
    // never reach the candles, and the front card rests below the
    // cake's middle, so the cake itself stays on show. On a very short
    // stage (a phone turned sideways) no fully clear back half fits, so
    // the back cards are allowed to tuck behind the cake there — they
    // already render behind it, so the cake still covers its own share.
    const shortStage = layout.height < 480;
    const backCakeMul = shortStage ? 0.15 : 1;
    const backSlotMul = shortStage ? 0.3 : 0.8;
    const ryMax = Math.min(
      cake.y - safe.top - halfH * back,
      safe.bottom - cake.y - halfH * front
    );
    const ryMin = Math.max(
      14,
      cake.hh * backCakeMul + halfH * back * backSlotMul,
      // On a short stage the candle rule below is the binding front-card
      // constraint already, so the frontDrop ladder is skipped there.
      shortStage
        ? halfH * front
        : cake.hh * layout.frontDrop + halfH * front,
      // The front card's top edge must stay below the cake's candle zone
      // (the geometry check allows at most 10% under the cake's top) with
      // a pixel of slack for float noise.
      halfH * front - (cake.hh - 4) * 0.8 + 1
    );
    // If even the tightest ring pokes out of the safe box, reject and
    // let the caller shrink the cards before trying again.
    if (ryMax < Math.max(14, ryMin)) {
      return reject(`ry ${Math.round(ryMax)} < need ${Math.round(ryMin)}`);
    }
    const ry = Math.max(14, ryMin);

    // Horizontal bounds: at the sides the card must clear the cake.
    const sideScale = ringDepth(0.5, back, front);
    const rxNeed = cake.hw + halfW * sideScale + 2;
    const rxMax = Math.min(
      cake.x - safe.left - halfW * sideScale,
      safe.right - cake.x - halfW * sideScale
    );
    if (rxMax < rxNeed) return reject(`rx ${Math.round(rxMax)} < need ${Math.round(rxNeed)}`);

    // Keep the ring reading as a circle rather than a flat oval.
    const rx = Math.min(rxMax, Math.max(rxNeed, ry * 1.45));
    const step = TAU / count;

    // Final check on every resting angle. The ring only ever rotates
    // through these, so the whole motion is covered. Each card is also
    // skewed by its tilt (up to 13 degrees), which visibly widens and
    // deepens its bounding box — the on-screen card must stay inside the
    // safe box including that rotation.
    for (let i = 0; i < count; i += 1) {
      const theta = Math.PI + i * step;
      const depth = (1 - Math.cos(theta)) / 2;
      const scale = ringDepth(depth, back, front);
      const x = cake.x + Math.sin(theta) * rx;
      const y = cake.y - Math.cos(theta) * ry;
      const w = halfW * scale;
      const h = halfH * scale;
      const tilt = Math.abs(Math.sin(theta)) * (13 * Math.PI / 180);
      // w and h here are half-dimensions, so the rotated bounding box
      // is twice the projection sum.
      const bw = 2 * (w * Math.cos(tilt) + h * Math.sin(tilt));
      const bh = 2 * (h * Math.cos(tilt) + w * Math.sin(tilt));

      if (x - bw / 2 < safe.left - 1 || x + bw / 2 > safe.right + 1) {
        return reject(`angle ${Math.round((theta * 180) / Math.PI)}deg: x ${Math.round(x)} bbox ${Math.round(bw / 2)} vs safe ${Math.round(safe.right)}`);
      }
      if (y - bh / 2 < safe.top - 1 || y + bh / 2 > safe.bottom + 1) {
        return reject(`angle ${Math.round((theta * 180) / Math.PI)}deg: y ${Math.round(y)} bbox ${Math.round(bh / 2)} vs top ${Math.round(safe.top)} bottom ${Math.round(safe.bottom)}`);
      }
    }

    return { cx: cake.x, cy: cake.y, rx, ry, step, back, front };
  }

  // Last resort for a pathological screen: clamp the ring into the safe
  // box and let the cards overlap the cake rather than leave the page.
  // The clamped ellipse still respects each card's tilted silhouette.
  function clampRing(layout) {
    const count = Math.max(1, state.photos.length);
    const { cake, safe } = layout;
    const halfW = (layout.maxOuterW + 2) / 2;
    const halfH = (layout.maxOuterH + 2) / 2;
    const back = 0.5;
    const front = 1 + (ringFrontScale(count) - 1) * layout.scale;
    const sideScale = ringDepth(0.5, back, front);
    const sideTilt = 13 * Math.PI / 180;

    const backHalfW = halfW * back;
    const backHalfH = halfH * back;
    const sideW = halfW * sideScale;
    const sideH = halfH * sideScale;
    const frontHalfW = halfW * front;
    const frontHalfH = halfH * front;
    // Worst-case tilted bounding half-extents for each ring position.
    const backSlack = Math.max(
      backHalfW * Math.cos(sideTilt) + backHalfH * Math.sin(sideTilt),
      backHalfH * Math.cos(sideTilt) + backHalfW * Math.sin(sideTilt),
    );
    const sideSlack = Math.max(
      sideW * Math.cos(sideTilt) + sideH * Math.sin(sideTilt),
      sideH * Math.cos(sideTilt) + sideW * Math.sin(sideTilt),
    );
    const frontSlack = Math.max(frontHalfW, frontHalfH);

    const ryCandle = frontHalfH - (cake.hh - 4) * 0.8 + 1;
    const ry = Math.max(6, ryCandle, Math.min(
      cake.y - safe.top - backSlack,
      safe.bottom - cake.y - frontSlack
    ));
    const rx = Math.max(6, Math.min(
      cake.x - safe.left - sideSlack,
      safe.right - cake.x - sideSlack
    ));

    return { cx: cake.x, cy: cake.y, rx, ry, step: TAU / count, back, front };
  }

  // Diagnostic trail: why each ladder step rejected, for the harness.
  const planLog = [];
  state.planLog = planLog;

  // Try the roomy layout first. To keep the photos a meaningful size,
  // it is the cake that yields on cramped screens — first a plain cake
  // nudge smaller so the ring has room to pass, and only when even that
  // fails do the cards themselves shrink a step.
  function planOrbit() {
    const scales = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.36];
    const steps = [
      { cakeMul: 1, frontDrop: 0.5 },
      { cakeMul: 0.8, frontDrop: 0.1 },
      { cakeMul: 0.64, frontDrop: -0.15 },
      { cakeMul: 0.5, frontDrop: -0.5 },
    ];

    planLog.length = 0;
    for (let i = 0; i < scales.length; i += 1) {
      for (let s = 0; s < steps.length; s += 1) {
        fitCake(steps[s].cakeMul);
        const layout = measureLayout(scales[i]);
        layout.frontDrop = steps[s].frontDrop;
        layout.step = s;
        const ring = solveRing(layout);
        if (ring) {
          budgetPop(layout, ring);
          return { layout, ring };
        }
      }
    }

    const layout = measureLayout(scales[scales.length - 1]);
    layout.frontDrop = steps[steps.length - 1].frontDrop;
    const ring = clampRing(layout);
    budgetPop(layout, ring);
    return { layout, ring };
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

    // The featured photo's pop is budgeted from measured headroom (see
    // budgetPop), so it grows as far as the flame and the sentence
    // allow — never into them.
    const zoom = 1 + (size.popExtra === undefined ? 0.16 : size.popExtra);
    slot.style.setProperty('--zoom', zoom.toFixed(3));
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

  // Copy the first 30 seconds into a fresh buffer, with 2ms fades at
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
    applyExportButton(); // stays hidden: no photos to record
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

    state.hasCaptions = state.photos.some((photo) => photo.caption);
    if (els.quote) {
      els.quote.hidden = !state.hasCaptions;
    }
    if (els.name) {
      // The words move into the name's slot; without words it returns.
      els.name.hidden = state.hasCaptions;
    }

    state.audioBlob = record.audio && record.audio.blob instanceof Blob
      ? record.audio.blob
      : null;

    buildOrbit();
    buildDots();
    // The download affordance leans on the same MediaRecorder/canvas
    // probes; show it now that photos exist (it hides for empty states).
    applyExportButton();
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

  /* ---------------------------------------------- video export */

  // The reel can be baked into a real video file entirely in the
  // browser: a canvas mirrors the stage (the finished cake as static
  // art plus the candle, the blurred photo backdrop and every card on
  // the ring), canvas.captureStream feeds MediaRecorder, and the music
  // rides along from the same WebAudio graph. No server, no database.
  const EXPORT_OK = Boolean(
    window.MediaRecorder &&
    HTMLCanvasElement.prototype.captureStream &&
    els.downloadBtn
  );

  const exportPrefs = {
    mimes: [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ],
    videoBitsPerSecond: 4200000,
    audioBitsPerSecond: 128000,
    // A beat that opens the video on the finished cake before the
    // cards sweep in (the live page plays the full build instead).
    openMs: 1700,
    tailMs: 900,
    maxMs: 300000,
  };

  // The cake's SMIL build animates in the DOM, but an SVG placed in an
  // <img> only ever rasterizes once — so for the export the cake is
  // baked at its finished state: strip <animate>, keep the final key
  // of each path.
  function bakeFinishedCakeText() {
    if (!els.cake) return null;
    const clone = els.cake.cloneNode(true);
    const frames = clone.querySelectorAll('animate');

    for (const anim of frames) {
      if (anim.getAttribute('attributeName') === 'd') {
        const target = anim.parentElement;
        const values = (anim.getAttribute('values') || '').split(';').map((s) => s.trim());
        const last = values[values.length - 1];
        if (target && last) target.setAttribute('d', last);
      }
      anim.remove();
    }

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(clone);
  }

  function waitForImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed'));
      img.src = url;
    });
  }

  function containDraw(ctx, img, box, contentScale, drift) {
    if (!img || !img.naturalWidth) return;
    const scale = Math.max(box.w / img.naturalWidth, box.h / img.naturalHeight) * contentScale;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const pan = drift || { x: 0, y: 0 };
    ctx.drawImage(img, box.x + (box.w - w) / 2 + pan.x, box.y + (box.h - h) / 2 + pan.y, w, h);
  }

  function roundedFramePath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Flicker pattern for the candle flame: five staggered oscillators
  // mirroring the CSS flicker phases (.fuego delays 0/.2/.5/1/1.5s).
  function flameWobble(tMs) {
    const t = tMs / 1000;
    let value = 0;
    value += Math.sin(t * Math.PI * 2 / 2) * 0.18;
    value += Math.sin(t * Math.PI * 2 / 1.5 + 1.1) * 0.14;
    value += Math.sin(t * Math.PI * 2 / 1 + 2.4) * 0.1;
    value += Math.sin(t * Math.PI * 2 / 0.5 + 0.6) * 0.06;
    value += Math.sin(t * Math.PI * 2 / 0.2 + 2) * 0.02;
    return value;
  }

  function drawExportCandle(ctx, box, tMs) {
    const k = box.w / 200;
    const candleW = 5 * k;
    const candleH = 35 * k;
    // The candle is re-based 24 units below the wrap's top and drops
    // from 300 units above (same choreography as the live page).
    const drop = Math.min(1, Math.max(0, (tMs - 6000) / 500));
    const eased = 1 - (1 - drop) * (1 - drop);
    const candleTop = box.top + 24 * k - (1 - eased) * 300 * k;
    const cx = box.left + box.w / 2;

    if (tMs < 5500) return;
    ctx.save();
    ctx.globalAlpha *= tMs < 6000 ? 0 : Math.max(0.15, eased);
    ctx.fillStyle = '#ffffff';
    roundedFramePath(ctx, cx - candleW / 2, candleTop, candleW, candleH, candleW / 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 0, 0, 0.4)';
    ctx.fillRect(cx - candleW / 2, candleTop + candleH * 0.25, candleW, Math.max(1, 2.2 * k));
    ctx.fillRect(cx - candleW / 2, candleTop + candleH * 0.45, candleW, Math.max(1, 2.2 * k));

    if (tMs >= 6500) {
      const flameX = cx - 2.6 * k;
      const flameY = candleTop - 20 * k;
      const wobble = flameWobble(tMs);

      ctx.save();
      ctx.translate(flameX + 3.3 * k, flameY + 9 * k);
      ctx.scale(1 + 0.1 * wobble, 1 + 0.16 * Math.abs(wobble));
      const flameGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 11 * k);
      flameGrad.addColorStop(0, 'rgba(255, 238, 140, 0.95)');
      flameGrad.addColorStop(0.45, 'rgba(254, 248, 97, 0.62)');
      flameGrad.addColorStop(1, 'rgba(255, 170, 60, 0)');
      ctx.fillStyle = flameGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, 4.2 * k, 10 * k, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  const EXPORT_PLAN = {
    job: false,
  };

  async function startExport() {
    if (state.exporting) {
      // Second tap = cancel: stop the render loop and let the stop
      // handler below discard the recording.
      if (EXPORT_PLAN.job) EXPORT_PLAN.job.cancelled = true;
      EXPORT_PLAN.cancel = true;
      showToast('Cancelling the video export…');
      return;
    }

    const count = state.photos.length;
    if (!count) return;

    const viewRect = els.view.getBoundingClientRect();
    const svgRect = els.cake ? els.cake.getBoundingClientRect() : null;
    const wrapRect = els.cakeWrap.getBoundingClientRect();
    const quoteLine = els.quote && !els.quote.hidden
      ? els.quote.querySelector('.reel-quote-line:not(.is-on)') || els.quote.querySelector('.reel-quote-line')
      : null;
    const quoteRect = quoteLine ? quoteLine.getBoundingClientRect() : null;
    const h1El = document.querySelector('.reel-caption h1');
    const h1Style = h1El ? getComputedStyle(h1El) : null;

    const ctxSetup = await (async () => {
      const blob = bakeFinishedCakeText();
      const cakeUrl = blob
        ? URL.createObjectURL(new Blob([blob], { type: 'image/svg+xml' }))
        : null;
      const cakeImg = cakeUrl ? await waitForImage(cakeUrl) : null;

      const photos = [];
      for (const photo of state.photos) {
        try {
          photos.push(await waitForImage(photo.url));
        } catch (error) {
          photos.push(null);
        }
      }
      if (!photos.some(Boolean)) {
        showToast('The video export could not load the photos.');
        if (cakeUrl) URL.revokeObjectURL(cakeUrl);
        return null;
      }

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewRect.width * dpr);
      canvas.height = Math.round(viewRect.height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      // Debug affordance (same contract as REEL_DEBUG): the harness can
      // sample a recording frame; released when the job ends.
      state.exportCanvas = canvas;

      return { photos, cakeImg, cakeUrl, canvas, ctx, dpr };
    })();

    if (!ctxSetup) return;

    // Music for the file: the looping WebAudio source also feeds a
    // recorder destination. The live mute state doesn't matter — the
    // video always carries the song (the graph is tapped upstream of
    // the recording; only the rare element-fallback path needs a
    // temporary unmute).
    let exportStream = null;
    let elementUnmuted = false;
    let audioCtxForCleanup = null;
    let exportAudioCleanup = null;
    try {
      if (!state.audioStarted && state.hasAudio) await startAudio();
      const audioCtx = getAudioContext();
      const exportGain = audioCtx.createGain();
      exportGain.gain.value = 0.8;
      const dest = audioCtx.createMediaStreamDestination();

      // After the recording: undo the unmute swap and drop only the
      // export tap (each disconnect targets one specific connection so
      // the live listening path through state.gain is untouched).
      exportAudioCleanup = () => {
        if (elementUnmuted && state.audioEl) {
          state.audioEl.muted = true;
          if (state.elementSrc) {
            try {
              state.elementSrc.connect(audioCtx.destination);
            } catch (error) {
              /* ignore */
            }
          }
          elementUnmuted = false;
        }
        if (tapSource) {
          try {
            tapSource.disconnect(tapSplit);
          } catch (error) {
            /* ignore */
          }
        }
        try {
          tapSplit.disconnect(dest);
        } catch (error) {
          /* ignore */
        }
      };

      let tapSplit = exportGain;
      let tapSource = null;
      if (state.source) {
        // Buffer source: tap upstream of the live gain node. Muting the
        // live reel (state.gain → 0) doesn't affect this signal.
        tapSource = state.source;
        state.source.connect(exportGain).connect(dest);
      } else if (state.audioEl) {
        if (!state.elementSrc) {
          state.elementSrc = audioCtx.createMediaElementSource(state.audioEl);
          state.elementSrc.connect(audioCtx.destination);
        }
        if (state.muted) {
          try {
            state.elementSrc.disconnect(audioCtx.destination);
          } catch (error) {
            /* fine if already detached */
          }
          state.audioEl.muted = false;
          elementUnmuted = true;
        }
        tapSource = state.elementSrc;
        state.elementSrc.connect(exportGain).connect(dest);
      }

      exportStream = dest.stream;
      audioCtxForCleanup = audioCtx;
    } catch (error) {
      exportStream = null;
    }

    const stream = ctxSetup.canvas.captureStream(30);
    if (exportStream) {
      for (const track of exportStream.getAudioTracks()) {
        stream.addTrack(track);
      }
    }

    const mime = getExportMime();
    let recorder = null;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mime || undefined,
        videoBitsPerSecond: exportPrefs.videoBitsPerSecond,
        audioBitsPerSecond: exportPrefs.audioBitsPerSecond,
      });
    } catch (error) {
      showToast('This browser cannot record video yet.');
      state.exportCanvas = null;
      if (exportAudioCleanup) {
        try {
          exportAudioCleanup();
        } catch (ignore) {
          /* ignore */
        }
      }
      if (ctxSetup.cakeUrl) URL.revokeObjectURL(ctxSetup.cakeUrl);
      return;
    }

    const job = {
      cancelled: false,
    };

    EXPORT_PLAN.job = job;
    state.exporting = true;
    applyExportButton();

    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.start(500);

    const introHold = REDUCED ? 0 : exportPrefs.openMs;
    const cycle = HOLD_MS + ROTATE_MS;
    const totalMs = introHold + (count > 1 ? count : 1) * cycle + exportPrefs.tailMs;
    const pct = Math.max(1, Math.ceil((totalMs) / 1000));

    showToast(`Recording the reel as video… about ${pct}s. It saves itself at the end.`);

    // The export timeline mirrors the live reel: a settled open, then
    // hold + turn for every photo, with the sentence dissolving under
    // the ring on each front change.
    const ex = {
      t: 0,
      phase: 'open',
      phaseT: 0,
      spin: 0,
      spinFrom: 0,
      frontIdx: 0,
      last: performance.now(),
    };

    // Shipping the measured text styles once — the canvas can re-use
    // them every frame without re-reading computed styles.
    const geo = {
      viewRect, svgRect, wrapRect, quoteRect, h1Style,
      quoteStyle: quoteLine ? getComputedStyle(quoteLine) : null,
      h1Rect: h1El ? h1El.getBoundingClientRect() : null,
    };

    await new Promise((resolve) => {
      job.done = resolve;

      const tickFrame = (now) => {
        if (!state.exporting || job.cancelled) {
          resolve();
          return;
        }

        const dt = Math.min(80, Math.max(0, now - ex.last));
        ex.last = now;
        ex.t += dt;

        if (ex.phase === 'open' && ex.phaseT >= introHold) {
          ex.phase = 'hold';
          ex.phaseT = 0;
        } else if (ex.phase === 'hold' && count > 1 && ex.phaseT >= HOLD_MS) {
          ex.phase = 'rotate';
          ex.phaseT = 0;
          ex.spinFrom = ex.spin;
        } else if (ex.phase === 'rotate') {
          ex.phaseT += dt;
          const p = Math.min(1, ex.phaseT / Math.max(1, ROTATE_MS));
          ex.spin = ex.spinFrom + state.ring.step * easeInOutCubic(p);
          if (p >= 1) {
            ex.spinFrom += state.ring.step;
            ex.spin = ex.spinFrom;
            ex.frontIdx = (ex.frontIdx + 1) % count;
            ex.phase = 'hold';
            ex.phaseT = 0;
          }
        } else {
          ex.phaseT += dt;
        }

        drawExportScene(ex, ctxSetup, geo);

        if (ex.t >= Math.min(exportPrefs.maxMs, totalMs)) {
          resolve();
          return;
        }
        job.raf = requestAnimationFrame(tickFrame);
      };

      job.raf = requestAnimationFrame(tickFrame);
    }).catch(() => {});

    window.cancelAnimationFrame(job.raf);
    state.exporting = false;
    applyExportButton();

    const finished = await new Promise((resolve) => {
      recorder.onstop = () => resolve(!job.cancelled);
      try {
        recorder.stop();
      } catch (error) {
        resolve(false);
      }
      window.setTimeout(() => resolve(false), 4000);
    }).catch(() => false);

    if (job.cancelled || !finished || !chunks.length) {
      showToast(job.cancelled ? 'Video export cancelled.' : 'Video export failed.');
    } else {
      const blob = new Blob(chunks, { type: mime || 'video/webm' });
      const ext = mime && mime.includes('mp4') ? 'mp4' : 'webm';
      const rawName = (els.name && !els.name.hidden && els.name.textContent)
        ? els.name.textContent
        : 'birthday';
      const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'birthday';
      const file = { blob, type: mime || 'video/webm', name: `${slug}-reel.${ext}` };

      state.lastExport = file;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 8000);
      showToast(`Video saved as ${file.name} — check your downloads.`);
    }

    // Let go of the recorder tap and undo the element unmute swap.
    if (exportAudioCleanup && audioCtxForCleanup) {
      try {
        exportAudioCleanup();
      } catch (error) {
        /* ignore */
      }
    }

    if (ctxSetup.cakeUrl) URL.revokeObjectURL(ctxSetup.cakeUrl);
    state.exportCanvas = null;
    EXPORT_PLAN.job = false;
  }

  function applyExportButton() {
    if (!els.downloadBtn) return;
    els.downloadBtn.hidden = !EXPORT_OK || !state.photos.length;
    if (els.downloadIconIdle) els.downloadIconIdle.hidden = state.exporting;
    if (els.downloadIconBusy) els.downloadIconBusy.hidden = !state.exporting;
    els.downloadBtn.setAttribute(
      'aria-label',
      state.exporting ? 'Cancel the video export' : 'Download the reel as a video'
    );
    els.downloadBtn.setAttribute('aria-busy', String(Boolean(state.exporting)));
  }

  // One frame of the composited video: backdrop, scrims, cards, cake,
  // candle, sentence and greeting — all at export scale.
  function drawExportScene(ex, setup, geo) {
    const { ctx, photos, cakeImg } = setup;
    const { viewRect, svgRect, wrapRect, h1Style } = geo;
    const W = viewRect.width;
    const H = viewRect.height;
    const ring = state.ring;
    const count = state.photos.length;
    const layout = state.layout;

    ctx.clearRect(0, 0, W, H);

    // base of the stage
    const base = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.72);
    base.addColorStop(0, '#3b1d26');
    base.addColorStop(1, '#170a0e');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    // the blurred backdrop photo (switches with the front photo)
    const bgIdx = Math.min(count - 1, ex.frontIdx);
    const bgImg = photos[bgIdx];
    if (bgImg) {
      ctx.save();
      ctx.filter = 'blur(15px) saturate(1.08) brightness(0.5)';
      const driftT = 0.03 * Math.sin(ex.t / 5000);
      containDraw(ctx, bgImg, { x: W * (driftT - 0.085), y: -H * 0.07, w: W * 1.17, h: H * 1.14 }, 1, null);
      ctx.filter = 'none';
      ctx.restore();

      // scrims, as in .reel-shade
      const dark = ctx.createRadialGradient(W / 2, H * 0.46, 0, W / 2, H * 0.46, Math.max(W, H) * 0.6);
      dark.addColorStop(0, 'rgba(18, 7, 11, 0.6)');
      dark.addColorStop(0.44, 'rgba(18, 7, 11, 0.28)');
      dark.addColorStop(1, 'rgba(18, 7, 11, 0)');
      ctx.fillStyle = dark;
      ctx.fillRect(0, 0, W, H);
      const band = ctx.createLinearGradient(0, 0, 0, H);
      band.addColorStop(0, 'rgba(16, 6, 10, 0.45)');
      band.addColorStop(0.25, 'rgba(16, 6, 10, 0.05)');
      band.addColorStop(0.55, 'rgba(16, 6, 10, 0)');
      band.addColorStop(1, 'rgba(16, 6, 10, 0.7)');
      ctx.fillStyle = band;
      ctx.fillRect(0, 0, W, H);
    }

    // cards on the ring, back half first
    const opener = ex.phase === 'open' ? 0 : 1;

    const drawCards = (frontHalf) => {
      for (let i = 0; i < count; i += 1) {
        const theta = Math.PI + i * ring.step - ex.spin;
        const cos = Math.cos(theta);
        const depth = (1 - cos) / 2;
        const isFront = frontHalf ? depth > 0.5 : depth <= 0.5;

        const scale = ringDepth(depth, ring.back, ring.front);
        const x = ring.cx + Math.sin(theta) * ring.rx;
        const y = ring.cy - cos * ring.ry;
        const size = layout.frameSizes[i] || { w: 80, h: 80, pad: 8, bottomPad: 16 };
        const outerW = size.w + size.pad * 2;
        const cardH = size.h + size.pad + size.bottomPad;
        const tilt = Math.sin(theta) * (13 * Math.PI / 180);

        // view coords (layout origin = stage centre)
        const cx = W / 2 + x;
        const cy = H / 2 + y;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(tilt);
        // Depth size: the live slot scales the same way — the ring's
        // back cards read smaller by ringDepth.
        ctx.scale(scale, scale);
        const introAlpha = ex.phase === 'open'
          ? Math.min(1, Math.max(0, (ex.t - (exportPrefs.openMs - 900)) / 900))
          : 1;
        ctx.globalAlpha = opener * (0.5 + 0.5 * depth) * introAlpha;

        ctx.shadowColor = depth > 0.5
          ? 'rgba(4, 1, 3, 0.92)'
          : 'rgba(4, 1, 3, 0.8)';
        ctx.shadowBlur = depth > 0.5 ? 30 : 24;
        ctx.shadowOffsetY = depth > 0.5 ? 14 : 10;

        const cardGrad = ctx.createLinearGradient(-outerW / 2, -cardH / 2, outerW / 2, cardH / 2);
        cardGrad.addColorStop(0, '#fffdf6');
        cardGrad.addColorStop(0.45, '#f6ead3');
        cardGrad.addColorStop(0.85, '#ecdac0');
        cardGrad.addColorStop(1, '#e6d0b2');
        ctx.fillStyle = cardGrad;
        roundedFramePath(ctx, -outerW / 2, -cardH / 2, outerW, cardH, 3);
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        // photo inside the frame (aspect-fitted), slow Ken Burns drift
        const img = photos[i];
        if (img) {
          // The featured photo pops like on the live page: the frame
          // rectangle itself scales by the budgeted zoom, so its
          // content may cross the polaroid's paper edges.
          const frameZoom = i === ex.frontIdx && ex.phase !== 'open'
            ? 1 + (size.popExtra === undefined ? 0.16 : size.popExtra)
            : 1;
          const kb = 1.04 + 0.04 * Math.min(1, (ex.t % SLIDE_MS) / SLIDE_MS);
          ctx.save();
          const frameCx = -outerW / 2 + size.pad + size.w / 2;
          const frameCy = -cardH / 2 + size.pad + size.h / 2;
          const zw = size.w * frameZoom;
          const zh = size.h * frameZoom;
          const frameX = frameCx - zw / 2;
          const frameY = frameCy - zh / 2;
          ctx.beginPath();
          ctx.rect(frameX, frameY, zw, zh);
          ctx.clip();
          ctx.fillStyle = '#1a0c11';
          ctx.fillRect(frameX, frameY, zw, zh);
          const sway = Math.sin(ex.t / 6000 + i) * size.w * 0.02;
          containDraw(
            ctx,
            img,
            { x: frameX, y: frameY, w: zw, h: zh },
            kb,
            { x: sway, y: 0 }
          );
          ctx.restore();
        }

        // tape
        ctx.save();
        ctx.rotate(-0.06);
        ctx.fillStyle = 'rgba(214, 186, 128, 0.6)';
        ctx.fillRect(-10 - size.pad / 2, -cardH / 2 - 3, 22, 10);
        ctx.restore();

        ctx.restore();
      }
    };

    drawCards(false);

    // cake + glow
    const cakeCx = W / 2 + layout.cake.x;
    const cakeCy = H / 2 + layout.cake.y;
    const glow = ctx.createRadialGradient(cakeCx, cakeCy, 0, cakeCx, cakeCy, Math.min(W, H) * 0.42);
    glow.addColorStop(0, 'rgba(255, 219, 164, 0.26)');
    glow.addColorStop(0.4, 'rgba(255, 176, 128, 0.12)');
    glow.addColorStop(1, 'rgba(255, 176, 128, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    if (cakeImg && svgRect) {
      ctx.drawImage(
        cakeImg,
        svgRect.left - viewRect.left,
        svgRect.top - viewRect.top,
        svgRect.width,
        svgRect.height
      );
    }
    // Candle at the wrap's coordinates relative to the view. The video
    // opens on the finished cake, so its candle is baked settled and
    // lit: 6500 puts the drop past its end and the flame burning from
    // the first frame (the live page does this over 0-6.5s).
    drawExportCandle(ctx, {
      left: wrapRect.left - viewRect.left,
      top: wrapRect.top - viewRect.top,
      w: wrapRect.width,
    }, 6500 + ex.t);

    drawCards(true);

    // the sentence line (photo's own words) + greeting
    const sentenceOf = (idx) => (state.photos[idx] && state.photos[idx].caption) || '';
    if (geo.quoteRect && geo.quoteStyle && sentenceOf(ex.frontIdx)) {
      const qSize = parseFloat(geo.quoteStyle.fontSize) || 18;
      ctx.fillStyle = '#ffe8c6';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `italic 300 ${qSize}px ${geo.h1Style.fontFamily}`;
      ctx.shadowColor = 'rgba(10, 3, 6, 0.9)';
      ctx.shadowBlur = 14;
      ctx.fillText(
        sentenceOf(ex.frontIdx),
        (geo.quoteRect.left + geo.quoteRect.width / 2) - viewRect.left,
        (geo.quoteRect.top + geo.quoteRect.height / 2) - viewRect.top
      );
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    const h1El = document.querySelector('.reel-caption h1');
    if (h1El && h1Style && geo.h1Rect) {
      const rect = geo.h1Rect;
      ctx.fillStyle = '#fff8ef';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `${h1Style.fontStyle} ${h1Style.fontWeight} ${parseFloat(h1Style.fontSize)}px ${h1Style.fontFamily}`;
      ctx.fillText(h1El.textContent, (rect.left + rect.width / 2) - viewRect.left, rect.bottom - viewRect.top);
    }

    // dots
    const dotY = H - 26;
    const spacing = 12;
    let dx = W / 2 - (spacing * (count - 1)) / 2;
    for (let i = 0; i < count; i += 1) {
      const active = i === ex.frontIdx;

      ctx.fillStyle = active ? '#ffe0b8' : 'rgba(255, 255, 255, 0.34)';
      ctx.beginPath();
      if (active) {
        roundedFramePath(ctx, dx - 11, dotY - 2.5, 22, 5, 2.5);
      } else {
        ctx.arc(dx, dotY, 2.5, 0, TAU);
      }
      ctx.fill();
      dx += spacing;
    }

    // progress
    const cycleFull = HOLD_MS + ROTATE_MS;
    const done = ex.phase === 'open'
      ? 0
      : count <= 1
        ? cycleFull
        : ex.phase === 'rotate'
          ? HOLD_MS + ex.phaseT
          : ex.phaseT;
    const fill = Math.min(1, done / cycleFull);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(0, H - 10, W, 3);
    if (fill > 0) {
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#ffe6c7');
      grad.addColorStop(1, '#ffb5a7');
      ctx.fillStyle = grad;
      ctx.fillRect(0, H - 10, W * fill, 3);
    }
  }

  function getExportMime() {
    return exportPrefs.mimes.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  if (els.downloadBtn) {
    els.downloadBtn.addEventListener('click', () => {
      if (!EXPORT_OK) return;
      startExport().catch(() => {
        state.exporting = false;
        applyExportButton();
        showToast('Video export failed.');
        EXPORT_PLAN.job = false;
      });
    });

    // Swapping pages mid-recording: stop the job cleanly so nothing
    // keeps drawing or holding the audio graph.
    window.addEventListener('pagehide', () => {
      if (EXPORT_PLAN.job && EXPORT_PLAN.job.cancelled === false) {
        EXPORT_PLAN.job.cancelled = true;
      }
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

  // Debug affordance: lets the test harness inspect the live layout
  // plan (ring geometry, card sizes, safe box) from the outside.
  window.REEL_DEBUG = state;

  boot();
})();
