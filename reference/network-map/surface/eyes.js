// One eye tracker for the landing character, marks, diagrams and 404.
window.ClausEyes = {
  create(root = document) {
    // Header marks have their own shared controller, independent of each module.
    const eyes = [...root.querySelectorAll('.pupil')].filter(el =>
      root !== document || !el.closest('[data-claus-brand]')).map(el => ({
      el, cx: +el.dataset.cx, cy: +el.dataset.cy,
      mx: (+el.dataset.rx - +el.getAttribute('r')) * .94,
      my: (+el.dataset.ry - +el.getAttribute('r')) * .94,
      x: +el.getAttribute('cx'), y: +el.getAttribute('cy'),
      drawnX: el.getAttribute('cx'), drawnY: el.getAttribute('cy')
    }));
  function update(pointer, delta, reduced) {
    const amount = reduced ? 1 : 1 - Math.exp(-delta / 55);
    let moving = false;
    // Read all geometry before moving any pupils to avoid repeated layouts.
    const visible = eyes.flatMap(eye => {
      if (eye.el.closest('[hidden]') || !eye.el.getClientRects().length) return [];
      const matrix = eye.el.parentElement.getScreenCTM();
      return matrix && matrix.a * matrix.d - matrix.b * matrix.c ? [{eye, matrix}] : [];
    });
    for (const {eye, matrix} of visible) {
      const local = pointer && !reduced ? new DOMPoint(pointer.x, pointer.y).matrixTransform(matrix.inverse()) : {x: eye.cx, y: eye.cy};
      const dx = local.x - eye.cx, dy = local.y - eye.cy;
      const distance = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, distance / 125);
      const x = eye.cx + dx / distance * eye.mx * reach;
      const y = eye.cy + dy / distance * eye.my * reach;
      eye.x += (x - eye.x) * amount;
      eye.y += (y - eye.y) * amount;
      const drawnX = eye.x.toFixed(3), drawnY = eye.y.toFixed(3);
      if (drawnX !== eye.drawnX) eye.el.setAttribute('cx', drawnX);
      if (drawnY !== eye.drawnY) eye.el.setAttribute('cy', drawnY);
      eye.drawnX = drawnX;
      eye.drawnY = drawnY;
      moving ||= Math.hypot(x - eye.x, y - eye.y) > .025;
    }
    return moving;
  }

    return { update };
  }
};
