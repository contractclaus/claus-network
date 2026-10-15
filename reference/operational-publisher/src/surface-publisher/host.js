import { createHash } from "node:crypto";
const team = "team_uolDmrwvORBaI3V7q4JVMKNS";
const bridge = "(()=>{const home='https://claus.si';const nested=parent!==self;const send=(type,extra={})=>parent.postMessage({type,...extra},home);\ndocument.addEventListener('click',e=>{const a=e.target.closest?.('a[href]');if(!a)return;const u=new URL(a.href,location.href);if(u.origin!==location.origin||u.pathname.startsWith('/assets/'))return;if(u.pathname===location.pathname&&u.hash)return;e.preventDefault();e.stopImmediatePropagation();if(!nested){location.assign(home+u.pathname+u.search+u.hash);return;}const r=a.getBoundingClientRect();send('claus-surface-navigate',{path:u.pathname+u.search+u.hash,x:r.x+r.width/2,y:r.y+r.height/2});},true);\nlet sent=false;function ready(){if(!sent&&document.querySelector('#world-claus')&&document.querySelector('.network-activity')){sent=true;send('claus-surface-ready');}}new MutationObserver(ready).observe(document.documentElement,{childList:true,subtree:true});addEventListener('load',ready);\n})();";
function deploymentFiles(files, id, hash) {
  const routes = [{ source: "/surface-data", destination: "https://claus.si/api/network-surface-data?id=" + id }, ...["/assets/:path*", "/network.json", "/api/network-activity", "/about.json", "/state.json", "/published.json", "/journal.json"].map((source) => ({ source, destination: "https://claus.si" + source }))];
  const config = { framework: null, buildCommand: "", installCommand: "", outputDirectory: "public", cleanUrls: false, rewrites: routes, headers: [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://claus-network-api.vercel.app; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://claus.si" }, { key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Content-Type-Options", value: "nosniff" }, { key: "Cache-Control", value: "public,max-age=60" }] }] };
  return [...files.map((f) => ({ file: "public/" + f.path, data: f.content, encoding: "utf-8" })), { file: "public/surface-bridge.js", data: bridge, encoding: "utf-8" }, { file: "public/health.json", data: JSON.stringify({ schema: "claus-network-surface-v1", id, sourceHash: hash }), encoding: "utf-8" }, { file: "vercel.json", data: JSON.stringify(config), encoding: "utf-8" }];
}
class SurfaceHost {
  constructor(request = fetch, token = () => process.env.PUBLISHER_SURFACE_TOKEN) {
    this.request = request;
    this.token = token;
  }
  request;
  token;
  async api(path, init = {}) {
    const token = this.token();
    if (!token) throw Error("surface_host_not_connected");
    const r = await this.request("https://api.vercel.com" + path + (path.includes("?") ? "&" : "?") + "teamId=" + team, { ...init, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(2e4) });
    if (!r.ok) {
      await r.body?.cancel();
      throw Error("surface_host_" + r.status);
    }
    return r.json();
  }
  async assertProject(projectId) {
    const p = await this.api("/v9/projects/" + projectId);
    if (p.name !== "claus-network-surface" || p.id !== projectId || p.link || p.ssoProtection || p.env?.length || p.buildCommand || p.installCommand || p.outputDirectory !== "public") throw Error("surface_host_scope_changed");
  }
  async deploy(projectId, files, id, hash) {
    await this.assertProject(projectId);
    const d = await this.api("/v13/deployments?skipAutoDetectionConfirmation=1", { method: "POST", body: JSON.stringify({ name: "claus-network-surface", project: projectId, files: deploymentFiles(files, id, hash), meta: { clausSurfaceId: id, clausSourceHash: hash }, projectSettings: { framework: null, buildCommand: "", installCommand: "", outputDirectory: "public", nodeVersion: "24.x" } }) });
    return this.receipt(d, projectId, id, hash);
  }
  receipt(d, projectId, id, hash) {
    if (d.projectId !== projectId || d.meta?.clausSurfaceId !== id || d.meta?.clausSourceHash !== hash || !/^dpl_[A-Za-z0-9]+$/.test(d.id) || !/^claus-network-surface-[a-z0-9-]+\.vercel\.app$/.test(d.url)) throw Error("surface_deployment_mismatch");
    return { id: d.id, url: "https://" + d.url, state: d.readyState ?? d.state };
  }
  async reconcile(projectId, id, hash, deploymentId) {
    if (deploymentId) return this.receipt(await this.api("/v13/deployments/" + deploymentId), projectId, id, hash);
    const found = await this.api("/v6/deployments?projectId=" + projectId + "&limit=100");
    const matches = (found.deployments ?? []).filter((d) => d.meta?.clausSurfaceId === id && d.meta?.clausSourceHash === hash);
    if (matches.length !== 1) return null;
    return this.receipt(await this.api("/v13/deployments/" + matches[0].uid), projectId, id, hash);
  }
  async verifySource(deploymentId, files, id, hash) {
    const tree = await this.api("/v6/deployments/" + deploymentId + "/files"), actual = {};
    const walk = (nodes, prefix = "") => {
      for (const n of nodes) if (n.children) walk(n.children, prefix + n.name + "/");
      else actual[prefix + n.name] = n.uid;
    };
    const root = tree.find((n) => n.name === "src");
    if (!root) throw Error("surface_source_missing");
    walk(root.children);
    const expected = Object.fromEntries(deploymentFiles(files, id, hash).map((f) => [f.file, createHash("sha1").update(f.data).digest("hex")]));
    if (Object.keys(actual).length !== Object.keys(expected).length || Object.keys(expected).some((k) => actual[k] !== expected[k])) throw Error("surface_deployed_source_mismatch");
    return true;
  }
  async verify(url, id, hash, data = false) {
    if (!/^https:\/\/claus-network-surface-[a-z0-9-]+\.vercel\.app$/.test(url)) throw Error("surface_url_invalid");
    const get = async (path) => {
      const r = await this.request(url + path, { redirect: "error", signal: AbortSignal.timeout(1e4), cache: "no-store" });
      if (!r.ok) throw Error("surface_health_http");
      const text = await r.text();
      if (text.length > 1e6) throw Error("surface_health_size");
      return text;
    };
    const [health, html] = await Promise.all([get("/health.json"), get("/index.html")]);
    const h = JSON.parse(health);
    if (h.id !== id || h.sourceHash !== hash || !html.includes('id="scene"') || !html.includes("/surface-bridge.js")) throw Error("surface_health_mismatch");
    if (data) {
      const value = JSON.parse(await get("/surface-data?view=projects"));
      if (value.schemaVersion !== "1.0" || !Array.isArray(value.nodes)) throw Error("surface_data_unavailable");
    }
    return { passed: true, id, sourceHash: hash, observedAt: (/* @__PURE__ */ new Date()).toISOString(), probes: ["health.json", "index.html", ...data ? ["surface-data"] : []] };
  }
}
export {
  SurfaceHost,
  bridge,
  deploymentFiles
};
