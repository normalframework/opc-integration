const {
    OPCUAClient,
    MessageSecurityMode,
    SecurityPolicy,
    DataType,
    AttributeIds,
    NodeClass,
    ClientSubscription,
    TimestampsToReturn,
} = require("node-opcua");
const { v5: uuidv5 } = require("uuid");
const fs = require("fs/promises");
const path = require("path");

const LAYER = "hpl:opc:1";
const POINT_NAMESPACE = "068a0ecf-aa20-447e-9467-2f705f066d6c";

const STATE_DIR = path.join(__dirname, "state");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");

let _sdk;
const initialize = (sdk) => { _sdk = sdk; };
const getSdk = () => {
    if (_sdk === undefined) throw new Error("SDK not initialized");
    return _sdk;
};

// --------------------------------------------------------------------------
// UI-owned state. Connection credentials deliberately do NOT live here --
// they stay in the app's config options so NF can keep `password` encrypted.
// This file holds only what the browser UI chooses: which subtrees to import
// and how often to trend them.
// --------------------------------------------------------------------------
const DEFAULT_CONFIG = {
    selectedNodes: [],   // [{ nodeId, path, browseName }]
    trendPeriod: 300,    // seconds; written to each imported point's `period`
};

const loadConfig = async () => {
    try {
        return { ...DEFAULT_CONFIG, ...JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8")) };
    } catch (e) {
        return { ...DEFAULT_CONFIG };
    }
};

const saveConfig = async (partial) => {
    const merged = { ...(await loadConfig()), ...(partial || {}) };
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
    return merged;
};

// --------------------------------------------------------------------------
// Connection
// --------------------------------------------------------------------------
const securityModeOf = (name) =>
    MessageSecurityMode[name] ?? MessageSecurityMode.None;

const securityPolicyOf = (name) =>
    SecurityPolicy[name] ?? SecurityPolicy.None;

// A hook runtime is long-lived, so the session lives at module scope and is
// reused across invocations. Opening a fresh session per UI click meant one
// full connect/createSession/disconnect per tree expansion, which is a lot of
// churn to put on a production DCS -- and churn is what produced intermittent
// BadUnexpectedError from the server.
let _client = null;
let _session = null;
let _key = "";
let _lastUsed = 0;
let _createdAt = 0;

// Two-layer guard, same shape as the Desigo driver's token cache.
//
// Reuse is worth having -- a fresh connect/createSession per UI click is a lot
// of churn on a production DCS. But a DeltaV session left idle goes subtly
// stale: its browse of the HDA namespace collapses from 755 history items to
// nothing while the session still answers a liveness read perfectly. Silently
// wrong is worse than an error, so a session that has been idle or is simply
// old gets replaced rather than trusted.
// Measured behaviour of this server's HDA interface: rapidly creating and
// destroying sessions starves it (browse of the HDA namespace returns an empty
// item list and every ns=5 nodeId reads BadNodeIdUnknown), and two minutes of
// quiet restores it. Session CHURN is the thing it cannot take -- not a session
// being held. So hold one session across a whole browsing session and let it go
// well after the last use, rather than cycling one every few seconds.
const IDLE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 30 * 60 * 1000;

// Hand the slot back once nobody is using it, but only after a long pause --
// see the note on IDLE_MS above for why cycling sessions quickly is worse than
// holding one.
const RELEASE_AFTER_MS = 5 * 60 * 1000;
let _releaseTimer = null;

const scheduleRelease = () => {
    if (_releaseTimer) clearTimeout(_releaseTimer);
    _releaseTimer = setTimeout(() => {
        _releaseTimer = null;
        hardClose().catch(() => {});
    }, RELEASE_AFTER_MS);
    // Never hold the runtime open just to keep a session warm.
    if (_releaseTimer.unref) _releaseTimer.unref();
};

const connKey = (c) =>
    [c.endpoint, c.username || "", c.securityMode || "None", c.securityPolicy || "None"].join("|");

// A module-scope session dies with the process, and an app restart or redeploy
// kills the process without closing it -- so every restart abandons a live
// session on the server until its own timeout reaps it. Dozens of redeploys in
// an afternoon is how you exhaust a DeltaV HDA interface's client slots, which
// then reports Running while serving an empty item list. Closing on the way out
// costs nothing and removes the leak.
let _shutdownHooked = false;
const installShutdownHook = () => {
    if (_shutdownHooked) return;
    _shutdownHooked = true;
    const bye = () => { hardClose().catch(() => {}); };
    process.once("SIGTERM", bye);
    process.once("SIGINT", bye);
    process.once("beforeExit", bye);
};

const hardClose = async () => {
    if (_releaseTimer) { clearTimeout(_releaseTimer); _releaseTimer = null; }
    if (_session) { try { await _session.close(); } catch (e) { /* closing anyway */ } }
    if (_client) { try { await _client.disconnect(); } catch (e) { /* closing anyway */ } }
    _session = null; _client = null; _key = ""; _lastUsed = 0; _createdAt = 0;
};

/**
 * Open (or reuse) a session. Credentials come from the app config options, so
 * nothing sensitive is ever written into the app's source files.
 * On any error the caller should call dropConnection() so the next call
 * reconnects rather than reusing a half-dead session.
 */
const connect = async (config) => {
    if (!config.endpoint) throw new Error("Missing config.endpoint");
    const key = connKey(config);

    const now = Date.now();
    const idle = now - _lastUsed;
    const age = now - _createdAt;

    if (_session && _key === key && idle < IDLE_MS && age < MAX_AGE_MS) {
        try {
            // Cheap liveness probe: the server's own status node. Necessary but
            // NOT sufficient -- it keeps passing on a session whose namespace
            // view has already gone stale, which is why the timers above exist.
            await _session.read({ nodeId: "i=2259", attributeId: AttributeIds.Value });
            _lastUsed = now;
            scheduleRelease();
            return { client: _client, session: _session, reused: true };
        } catch (e) {
            await hardClose();
        }
    } else if (_session) {
        await hardClose();   // wrong config, idle too long, or simply too old
    }

    installShutdownHook();

    const client = OPCUAClient.create({
        endpointMustExist: false,
        securityMode: securityModeOf(config.securityMode),
        securityPolicy: securityPolicyOf(config.securityPolicy),
        connectionStrategy: { maxRetry: 1, initialDelay: 500, maxDelay: 2000 },
        keepSessionAlive: true,
    });
    await client.connect(config.endpoint);

    const userIdentity = config.username
        ? { userName: config.username, password: config.password || "" }
        : null; // anonymous
    const session = await client.createSession(userIdentity || undefined);

    _client = client; _session = session; _key = key;
    _createdAt = Date.now(); _lastUsed = _createdAt;
    scheduleRelease();
    return { client, session, reused: false };
};

/** Called in a finally block: keeps the session warm for the next invocation. */
const closeSession = async () => { /* intentionally a no-op -- see connect() */ };

/** Called on error paths so the next call starts from a clean session. */
const dropConnection = async () => { await hardClose(); };

// --------------------------------------------------------------------------
// Value parsing
// --------------------------------------------------------------------------
/**
 * A non-Good status (Bad *or* Uncertain) is returned as `error` so the caller
 * can put it on the point's error stream. It does not suppress the reading:
 * whatever the server returned is still trended alongside the error.
 */
/** node-opcua hands back 64-bit integers as [high, low] word pairs. */
const toNumber = (raw) => {
    if (Array.isArray(raw) && raw.length === 2) return raw[0] * 4294967296 + raw[1];
    return Number(raw);
};

const NUMERIC_TYPES = new Set([
    DataType.Double, DataType.Float,
    DataType.Int16, DataType.Int32, DataType.Int64,
    DataType.UInt16, DataType.UInt32, DataType.UInt64,
    DataType.Byte, DataType.SByte,
]);

const tryParseValue = (value) => {
    const error = value.statusCode.isGood() ? undefined : value.statusCode.toString();
    const dt = value.value?.dataType;
    const raw = value.value?.value;
    const ts = value.serverTimestamp || new Date();

    if (raw === null || raw === undefined) {
        return { result: "error", error: error || "server returned no value" };
    }

    if (dt === DataType.Boolean) {
        return { result: "success", value: { boolean: !!raw, ts }, error };
    }

    if (NUMERIC_TYPES.has(dt)) {
        // Everything numeric goes out as `double`: it is exact for 32-bit ints
        // (float32 is not) and it is the only field wide enough for 64-bit.
        const n = toNumber(raw);
        if (!Number.isFinite(n)) {
            return { result: "error", error: error || `unrepresentable ${DataType[dt]} value` };
        }
        return { result: "success", value: { double: n, ts }, error };
    }

    return { result: "error", error: error || `value type ${DataType[dt]} not supported` };
};


// --------------------------------------------------------------------------
// HDA item attributes
// --------------------------------------------------------------------------
// Classic-OPC HDA exposes item attributes as properties whose BrowseName is the
// numeric attribute id with the 0x80000000 vendor bit set. Servers usually give
// the property node a readable DisplayName ("Mod DESC", "Eng Units"); this map
// is the fallback for the ones that don't, and it is how we find the
// description/units regardless of what a given vendor calls them.
const HDA_ATTR_BASE = 0x80000000;
const HDA_ATTRS = {
    0x01: "Data type",      0x02: "Description",    0x03: "Engineering units",
    0x04: "Stepped",        0x05: "Archiving",      0x06: "Derive equation",
    0x07: "Node name",      0x08: "Process name",   0x09: "Source name",
    0x0a: "Source type",    0x0b: "Normal maximum", 0x0c: "Normal minimum",
    0x0d: "Item id",        0x0e: "Max time interval", 0x0f: "Min time interval",
    0x10: "Exception deviation", 0x11: "Exception deviation type",
    0x12: "High entry limit",    0x13: "Low entry limit",
};

/** "ns=5;s=3:TAG/PV.CV?2147483650" -> 2 (the HDA attribute id), else null. */
const hdaAttrId = (nodeId) => {
    const m = /\?(\d+)$/.exec(String(nodeId || ""));
    if (!m) return null;
    const n = Number(m[1]);
    return n >= HDA_ATTR_BASE ? n - HDA_ATTR_BASE : null;
};

const hdaAttrName = (id) => HDA_ATTRS[id] || null;


/**
 * Read Value on many nodes, re-reading the ones that answer
 * BadWaitingForInitialData. DeltaV puts an attribute item on scan only when it
 * is first asked for, so a single read of a cold item returns nothing useful.
 * Items that never settle keep their Bad status -- that is real information.
 */
const readValuesSettling = async (session, nodeIds, attempts = 6, delayMs = 600) => {
    const asRead = (ids) => ids.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value }));
    let dvs = await session.read(asRead(nodeIds));
    for (let a = 1; a < attempts; a++) {
        const pending = [];
        dvs.forEach((dv, i) => {
            if (dv && /BadWaitingForInitialData/.test(dv.statusCode.toString())) pending.push(i);
        });
        if (!pending.length) break;
        // DeltaV can take several seconds to bring a cold attribute item on
        // scan; cap the backoff so a big import does not stall on stragglers.
        await new Promise((r) => setTimeout(r, Math.min(delayMs * Math.pow(2, a - 1), 4000)));
        const again = await session.read(asRead(pending.map((i) => nodeIds[i])));
        pending.forEach((idx, k) => { if (again[k]) dvs[idx] = again[k]; });
    }
    return dvs;
};


/**
 * Bring cold items on scan by subscribing to them.
 *
 * DeltaV answers BadWaitingForInitialData to a plain Read of an item nobody is
 * watching, and keeps answering it however long you retry -- a Read alone never
 * puts the item on scan. Creating a MonitoredItem does, and the first data
 * change carries the value. Returns a DataValue (or null) per node id.
 */
const readValuesSubscribed = async (session, nodeIds, timeoutMs = 10000) => {
    const results = new Array(nodeIds.length).fill(null);
    if (!nodeIds.length) return results;

    let sub;
    try {
        sub = ClientSubscription.create(session, {
            requestedPublishingInterval: 200,
            requestedLifetimeCount: 200,
            requestedMaxKeepAliveCount: 20,
            maxNotificationsPerPublish: 1000,
            publishingEnabled: true,
            priority: 1,
        });

        await new Promise((resolve) => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            sub.on("started", done);
            sub.on("error", done);
            setTimeout(done, 3000);
        });

        let remaining = nodeIds.length;
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
            const timer = setTimeout(finish, timeoutMs);

            Promise.all(nodeIds.map(async (nodeId, i) => {
                try {
                    const mi = await sub.monitor(
                        { nodeId, attributeId: AttributeIds.Value },
                        { samplingInterval: 200, queueSize: 1, discardOldest: true },
                        TimestampsToReturn.Both);
                    mi.on("changed", (dv) => {
                        if (results[i] !== null) return;
                        results[i] = dv;
                        if (--remaining <= 0) finish();
                    });
                } catch (e) {
                    if (results[i] === null && --remaining <= 0) finish();
                }
            })).catch(() => { /* individual failures already counted */ });
        });
    } catch (e) {
        // Subscription unsupported or refused -- caller keeps its Read results.
    } finally {
        if (sub) { try { await sub.terminate(); } catch (e) { /* closing anyway */ } }
    }
    return results;
};

/**
 * Read HDA attribute items.
 *
 * Measured on the DeltaV server: the FIRST read of an attribute item returns
 * the value; reads of the same item soon after return BadWaitingForInitialData
 * and keep doing so. Retrying, re-reading inline after the browse, and
 * subscribing with a MonitoredItem were all tried and none recovers a hot item
 * -- so a single read is not only sufficient, it is the only thing that works,
 * and repeating it just loads the server for nothing.
 *
 * The consequence for callers: treat these values as read-once. Persist them on
 * the point at import; do not expect a second inspect of the same node to show
 * them again straight away.
 */
const readValuesRobust = async (session, nodeIds) => {
    if (!nodeIds.length) return [];
    return session.read(nodeIds.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value })));
};

// --------------------------------------------------------------------------
// Points
// --------------------------------------------------------------------------
const pointUuid = (nodeIdString) => uuidv5(nodeIdString, POINT_NAMESPACE);

/**
 * `protocol_id` is the canonical home for the OPC nodeId: it is a first-class
 * point field, so the trend hook can read it straight off the point and never
 * has to browse. id_string carries the same value for search/display only.
 */
const buildPoint = (opts) => {
    const idString = opts.nodeId;
    return {
        uuid: pointUuid(idString),
        layer: LAYER,
        name: opts.name,
        parent_name: opts.parentName || "",
        parent_uuid: opts.parentUuid,
        protocol_id: idString,
        type: "POINT",
        attrs: {
            path: opts.path,
            id_string: idString,
            browse_name: opts.browseName || "",
            namespace: String(opts.namespace ?? ""),
            identifier_type: opts.identifierType || "",
            identifier: opts.identifier || "",
            units_display: opts.units || "",
        },
    };
};

const upsertPoints = async (points) => {
    const sdk = getSdk();
    return sdk.http.post("/api/v1/point/points", { points });
};

/** Write a value and/or an error for one point in a single request. */
const postPointData = async (uuid, value, error) => {
    const sdk = getSdk();
    const payload = { uuid, layer: LAYER };
    if (value) payload.values = [value];
    if (error) payload.errors = [{ ts: new Date(), message: error }];
    if (!payload.values && !payload.errors) return;
    try {
        return await sdk.http.post("/api/v1/point/data", payload);
    } catch (e) {
        getSdk().logEvent(`error posting data for ${uuid}: ${e.message}`);
    }
};

module.exports = {
    LAYER, POINT_NAMESPACE, NodeClass, AttributeIds,
    hdaAttrId, hdaAttrName, readValuesSettling, readValuesRobust,
    initialize, getSdk,
    loadConfig, saveConfig,
    connect, closeSession, dropConnection,
    tryParseValue,
    pointUuid, buildPoint, upsertPoints, postPointData,
};
