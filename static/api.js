// Plugin-side helpers on window.NF. Loaded as a plain <script>.
// App id and auth token come from the host URL -- never hardcoded.
(function () {
  const NF = {};

  NF.getAppId = function () {
    const qp = new URLSearchParams(window.location.search);
    const fromQuery = qp.get("applicationId") || qp.get("app_id");
    if (fromQuery) return fromQuery;
    const m = /\/api\/v1\/apps\/static\/([^/?]+)/.exec(window.location.pathname);
    if (m) return m[1];
    const hp = window.location.hash ? new URLSearchParams(window.location.hash.slice(1)) : null;
    const fromHash = hp && (hp.get("applicationId") || hp.get("app_id"));
    if (fromHash) return fromHash;
    throw new Error("Cannot derive app id from " + window.location.href);
  };

  NF.getAuthToken = function () {
    const qp = new URLSearchParams(window.location.search);
    let t = qp.get("token") || qp.get("auth_token");
    if (!t && window.location.hash) {
      const hp = new URLSearchParams(window.location.hash.slice(1));
      t = hp.get("token") || hp.get("auth_token");
    }
    return t;
  };

  function headers() {
    const h = { "Content-Type": "application/json", Accept: "application/json" };
    const t = NF.getAuthToken();
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }

  async function jfetch(url, options) {
    const resp = await fetch(url, options);
    if (resp.status === 401 || resp.status === 403) { window.location.reload(); throw new Error("auth failed"); }
    if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + (await resp.text().catch(() => "")).slice(0, 200));
    return resp.json();
  }

  let _ids = null;
  NF.getHookIds = async function (appId) {
    if (_ids) return _ids;
    const data = await jfetch(window.location.origin + "/api/v1/apps", { headers: headers() });
    const app = (data.applications || []).find((a) => a.id === appId);
    if (!app) throw new Error("App '" + appId + "' not found");
    _ids = {};
    for (const h of app.hooks || []) _ids[h.name] = h.id;
    return _ids;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Invoke an on-request hook, poll to terminal state, return parsed returnValue.
  // onEvent(events, state) receives the live log while it runs.
  NF.invokeHook = async function (name, args, opts) {
    opts = opts || {};
    const appId = NF.getAppId();
    const ids = await NF.getHookIds(appId);
    const hookId = ids[name];
    if (!hookId) throw new Error("Hook '" + name + "' not found on '" + appId + "'");

    const flat = {};
    for (const k of Object.keys(args || {})) {
      const v = args[k];
      flat[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    const base = window.location.origin + "/api/v1/apps/" + encodeURIComponent(appId) +
                 "/hooks/" + encodeURIComponent(hookId);
    const start = await jfetch(base, { method: "POST", headers: headers(), body: JSON.stringify(flat) });
    const pid = start.pid;
    if (!pid) throw new Error("StartHook returned no pid");

    const deadline = Date.now() + (opts.timeoutMs || 60000);
    const pollMs = opts.pollMs || 700;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const data = await jfetch(base + "/results?page_size=10", { headers: headers() });
      const r = (data.results || []).find((x) => x.pid === pid);
      if (!r) continue;
      if (opts.onEvent && r.events) { try { opts.onEvent(r.events, r.state); } catch (_) {} }
      if (r.state === "STATE_ENQUEUED" || r.state === "STATE_RUNNING") continue;
      if (r.state === "STATE_SUCCESS") {
        try { return JSON.parse(r.returnValue || "{}"); }
        catch (e) { throw new Error("Hook returned non-JSON: " + r.returnValue); }
      }
      throw new Error("Hook '" + name + "' failed (" + r.state + "): " +
        ((r.error && r.error.message) || (r.events && r.events[0] && r.events[0].message) || r.state));
    }
    throw new Error("Hook '" + name + "' timed out");
  };

  NF.opc = {
    loadConfig:   ()        => NF.invokeHook("discover", { action: "load_config" }),
    saveConfig:   (partial) => NF.invokeHook("discover", Object.assign({ action: "save_config" }, partial || {})),
    testConn:     ()        => NF.invokeHook("discover", { action: "test_connection" }, { timeoutMs: 45000 }),
    // Written straight to the app config, not through a hook: this PATCH
    // restarts the app, so a hook doing it would be killed before returning.
    // `password` is omitted when blank so a stored one is never clobbered.
    saveConnection: async function (fields) {
      const appId = NF.getAppId();
      const configuration = {};
      for (const f of ["endpoint", "username", "securityMode", "securityPolicy"]) {
        if (fields[f] !== undefined) configuration[f] = { string: String(fields[f]) };
      }
      if (fields.password) configuration.password = { string: String(fields.password) };
      if (!Object.keys(configuration).length) throw new Error("nothing to save");
      await jfetch(window.location.origin + "/api/v1/apps/" + encodeURIComponent(appId), {
        method: "PATCH", headers: headers(),
        body: JSON.stringify({ id: appId, configuration, updateMask: ["configuration"] }),
      });
      return { saved: Object.keys(configuration), passwordChanged: !!fields.password };
    },
    browse:       (nodeId)  => NF.invokeHook("discover", { action: "browse_node", nodeId: nodeId || "RootFolder" }, { timeoutMs: 45000 }),
    read:         (nodeId)  => NF.invokeHook("discover", { action: "read_node", nodeId }, { timeoutMs: 30000 }),
    inspect:      (nodeId)  => NF.invokeHook("discover", { action: "inspect_node", nodeId }, { timeoutMs: 60000 }),
    extent:       (nodeId)  => NF.invokeHook("discover",
      { action: "history_extent", nodeId }, { timeoutMs: 60000 }),
    history:      (nodeId, from, to, limit) => NF.invokeHook("discover",
      { action: "read_history", nodeId, from, to, limit: String(limit || 500) }, { timeoutMs: 90000 }),
    importSelected: (opts, onEvent) =>
      NF.invokeHook("import-selected", opts || {}, { timeoutMs: 4 * 60 * 60 * 1000, pollMs: 1500, onEvent }),
    trendNow:     (onEvent) => NF.invokeHook("trend-data", {}, { timeoutMs: 20 * 60 * 1000, pollMs: 1500, onEvent }),
  };

  window.NF = NF;
})();
