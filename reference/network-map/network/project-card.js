function createProjectCard(scene, viewport) {
  const card = document.createElement("section");
  card.className = "network-project-card", card.id = "network-project-card", card.setAttribute("aria-label", "Project details"), card.hidden = true;
  const title = document.createElement("h2"), details = document.createElement("p"), preview = document.createElement("img"), link = document.createElement("a");
  preview.alt = "", preview.decoding = "async", preview.referrerPolicy = "no-referrer", preview.hidden = true, preview.className = "network-project-preview", preview.addEventListener("load", () => {
    preview.currentSrc === preview.src && preview.naturalWidth > 0 && (preview.hidden = false, position());
  }), preview.addEventListener("error", () => {
    preview.hidden = true, position();
  }), link.textContent = "Open project", card.append(preview, title, details, link), scene.append(card);
  const agents = document.createElement("p"); agents.className="network-project-agents"; agents.hidden=true; card.insertBefore(agents,link);
  const work = document.createElement("div");
  work.className = "network-work-links", work.hidden = true, card.append(work);
  let active = null, timer;
  const cancel = () => clearTimeout(timer);
  function hide() {
    cancel(), active && active.setAttribute("aria-expanded", "false"), active = null, card.hidden = true;
  }
  function later() {
    cancel(), timer = setTimeout(hide, 220);
  }
  function position() {
    if (!active) return;
    const node = active.getBoundingClientRect(), bounds = viewport.getBoundingClientRect(), base = scene.getBoundingClientRect(), area = { left: bounds.left, right: bounds.right, width: bounds.width, top: bounds.top, bottom: bounds.bottom, height: bounds.height }, activity = scene.querySelector(".network-activity"), activityBounds = activity && getComputedStyle(activity).visibility !== "hidden" && (!matchMedia("(max-width:1100px)").matches || activity.classList.contains("is-open")) ? activity.getBoundingClientRect() : null;
    if (activityBounds?.width && activityBounds.left > area.left && (area.right = Math.min(area.right, activityBounds.left - 12), area.width = area.right - area.left), area.height < 64 || area.width < 120) {
      hide();
      return;
    }
    const width = Math.min(280, area.width - 24);
    card.style.width = width + "px", card.style.maxHeight = Math.max(0, area.height - 16) + "px";
    const height = card.offsetHeight;
    let left = node.left + node.width / 2 > area.left + area.width / 2 ? node.left - width - 12 : node.right + 12, top = node.top + node.height / 2 - height / 2;
    (left < area.left + 12 || left + width > area.right - 12) && (left = Math.max(area.left + 12, Math.min(area.right - width - 12, node.left + node.width / 2 - width / 2)), top = node.top + node.height / 2 < area.top + area.height / 2 ? node.top - height - 12 : node.bottom + 12, top < area.top + 8 && (top = node.bottom + 12), top + height > area.bottom - 8 && (top = node.top - height - 12)), top = Math.max(area.top + 8, Math.min(area.bottom - height - 8, top)), card.style.left = left - base.left + "px", card.style.top = top - base.top + "px";
  }
  function show(node, project) {
    if (viewport.classList.contains("is-dragging")) return;
    cancel(), active && active !== node && active.setAttribute("aria-expanded", "false"), active = node, title.textContent = project.label, link.href = project.href, work.replaceChildren();
    for (const partner of (project.collaborators ?? []).slice(0, 3)) {
      const row = document.createElement("a");
      row.href = partner.evidenceHref, row.target = "_blank", row.rel = "noopener noreferrer", row.textContent = "Accepted work \xB7 " + partner.label, row.title = "Public acceptance receipt. This does not prove payment or independent ownership.", work.append(row);
    }
    work.hidden = !work.childElementCount;
    const owned=(project.resources??[]).filter(item=>item.kind==="agent"&&item.relationship==="owned");
    agents.textContent=owned.length?"Owned agents · "+owned.map(item=>item.label).join(" · "):""; agents.hidden=!owned.length;
    const image = project.presentation?.preview ?? null;
    preview.getAttribute("src") !== image && (preview.hidden = true, image ? preview.src = image : preview.removeAttribute("src")), preview.hidden = !(image && preview.complete && preview.naturalWidth > 0);
    const counts = /* @__PURE__ */ new Map();
    for (const item of project.resources ?? []) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    details.textContent = project.presentation?.description || project.description || [...counts].map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`).join(" \xB7 "), details.hidden = !details.textContent, card.hidden = false, node.setAttribute("aria-expanded", "true"), position();
  }
  function bind(node, project) {
    let touch = false, currentProject = project;
    return node.setAttribute("aria-controls", card.id), node.setAttribute("aria-expanded", "false"), node.addEventListener("pointerdown", (e) => {
      touch = e.pointerType === "touch";
    }), node.addEventListener("pointerenter", (e) => {
      e.pointerType !== "touch" && show(node, currentProject);
    }), node.addEventListener("pointerleave", later), node.addEventListener("focus", () => {
      node.matches(":focus-visible") && show(node, currentProject);
    }), node.addEventListener("blur", (e) => {
      card.contains(e.relatedTarget) || later();
    }), node.addEventListener("click", (e) => {
      touch && !e.ctrlKey && !e.metaKey && (show(node, currentProject), card.hidden || e.preventDefault());
    }), node.addEventListener("keydown", (e) => {
      e.key === "Escape" && (hide(), e.preventDefault()), e.key === "Tab" && !e.shiftKey && active === node && (e.preventDefault(), link.focus({ preventScroll: true }));
    }), (next) => {
      currentProject = next, active === node && show(node, next);
    };
  }
  return card.addEventListener("pointerenter", cancel), card.addEventListener("pointerleave", later), card.addEventListener("focusin", cancel), card.addEventListener("focusout", (e) => {
    !card.contains(e.relatedTarget) && e.relatedTarget !== active && later();
  }), card.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Tab" && e.shiftKey && e.target === link) {
      e.preventDefault();
      const previous = active;
      hide(), previous?.focus({ preventScroll: true }), hide();
    }
  }), scene.addEventListener("claus:mapmove", hide), document.addEventListener("pointerdown", (e) => {
    !card.contains(e.target) && !active?.contains(e.target) && hide();
  }), window.addEventListener("resize", hide), { bind, hide };
}
export {
  createProjectCard
};
