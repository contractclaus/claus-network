// The entrance's ink transition. Pointer appearance stays native to the browser.
window.ClausInk = {
  mount() {
    if (this.instance) return this.instance;
    const veil = document.createElement('canvas');
    veil.id = 'claus-ink-transition';
    veil.setAttribute('aria-hidden', 'true');
    veil.hidden = true;
    document.body.append(veil);
    const cover = veil.getContext('2d');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const ease = t => t * t * t * (t * (t * 6 - 15) + 10);
    let width = innerWidth, height = innerHeight;
    let frame = 0, transition = null;

    function measure() {
      width = innerWidth;
      height = innerHeight;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      veil.width = Math.round(width * dpr);
      veil.height = Math.round(height * dpr);
      cover?.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (cover && !veil.hidden && !transition) {
        cover.fillStyle = '#000000';
        cover.fillRect(0, 0, width, height);
      }
    }
    function requestFrame() {
      if (!frame && !document.hidden) frame = requestAnimationFrame(render);
    }
    // A closed chain of quadratic curves keeps every ink edge soft and rounded.
    function roundedShape(context, vertices) {
      const last = vertices[vertices.length - 1];
      const first = vertices[0];
      context.beginPath();
      context.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
      vertices.forEach((p, i) => {
        const next = vertices[(i + 1) % vertices.length];
        context.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
      });
      context.closePath();
      context.fill();
    }
  
    function blob(context, x, y, radius, rotation = 0) {
      const vertices = Array.from({ length: 16 }, (_, i) => {
        const a = i / 16 * Math.PI * 2;
        const r = radius * (1 + .075 * Math.sin(3 * a + .4) + .045 * Math.cos(5 * a - .6));
        return { x: x + Math.cos(a + rotation) * r, y: y + Math.sin(a + rotation) * r };
      });
      roundedShape(context, vertices);
    }
  
    function cancel() {
      cancelAnimationFrame(frame);
      frame = 0;
      const pending = transition;
      transition = null;
      cover?.clearRect(0, 0, width, height);
      veil.hidden = true;
      veil.classList.remove('is-active');
      delete document.body.dataset.transition;
      pending?.resolve(false);
    }
    function play(origin, swap, phase = 'both', destination = null) {
      cancel();
      if (!cover || reduced.matches || document.hidden) {
        swap();
        return Promise.resolve(true);
      }
      const point = origin || {x: width / 2, y: height / 2};
      return new Promise((resolve, reject) => {
        transition = {
          x: clamp(point.x / width, 0, 1), y: clamp(point.y / height, 0, 1),
          start: performance.now(), revealStart: null, phase, swap, destination, resolve, reject
        };
        veil.hidden = false;
        veil.classList.add('is-active');
        document.body.dataset.transition = 'cover';
        if (phase === 'reveal') drawTransition(performance.now());
        requestFrame();
      });
    }
    function drawTransition(now) {
      if (!transition || !cover) return;
      const pending = transition;
      const x = pending.x * width, y = pending.y * height;
      const farthest = Math.max(Math.hypot(x, y), Math.hypot(width - x, y), Math.hypot(x, height - y), Math.hypot(width - x, height - y));
      const radius = farthest * 1.34 + 24;
      cover.clearRect(0, 0, width, height);
      cover.fillStyle = '#000000';
      if (pending.phase !== 'reveal' && now - pending.start < 280) {
        blob(cover, x, y, radius * ease((now - pending.start) / 280));
        return;
      }
      if (pending.revealStart === null) {
        // Swap only beneath a completely opaque frame, including after a slow frame.
        cover.fillRect(0, 0, width, height);
        pending.revealStart = now;
        document.body.dataset.transition = 'covered';
        try {
          pending.swap();
          const destination = pending.destination?.();
          if (destination) {
            pending.x = clamp(destination.x / width, 0, 1);
            pending.y = clamp(destination.y / height, 0, 1);
          }
          if (pending.phase === 'leave') {
            // Keep the old document covered until the destination is ready.
            transition = null;
            pending.resolve(true);
          }
        }
        catch (error) {
          const reject = pending.reject;
          transition = null;
          cancel();
          reject(error);
        }
        return;
      }
      const progress = clamp((now - pending.revealStart) / 360, 0, 1);
      document.body.dataset.transition = 'reveal';
      blob(cover, x, y, radius * (1 - ease(progress)));
      if (progress >= 1) {
        transition = null;
        cancel();
        pending.resolve(true);
      }
    }
    function render(now) {
      frame = 0;
      drawTransition(now);
      if (transition) requestFrame();
    }
    addEventListener('resize', measure, {passive: true});
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else requestFrame();
    });
    measure();
    return this.instance = {
      play, cancel,
      leave: (origin, navigate) => play(origin, navigate, 'leave'),
      reveal: origin => play(origin, () => {}, 'reveal')
    };
  }
};
