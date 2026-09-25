// RPC endpoint for the plugin UI. Dispatches on args.action and returns JSON
// via NormalSdk.InvokeSuccess(...), which the SDK maps to HookResult.returnValue.
//
//   test_connection -> connect, report server + endpoint details
//   browse_node     -> one level of children (lazy tree expansion)
//   read_node       -> current value + status for a single variable
//   inspect_node    -> every attribute worth seeing, plus child properties,
//                      whether NF already has it, and whether it has history
//   read_history    -> HistoryRead raw values over a time range
//   history_extent  -> oldest and newest archived samples, i.e. how far back
//                      this node's history actually goes
//   load_config     -> read state/config.json
//   save_config     -> merge into state/config.json
//
// Connection settings are NOT written here. PATCHing the app's own config
// restarts the app, which kills the hook mid-run (STATE_ABORTED) even though
// the write succeeded. The UI PATCHes /api/v1/apps/<id> directly instead.
//
// Browsing is ON-REQUEST only. Nothing here runs on a schedule, so the trend
// path never pays for a browse.

const NormalSdk = require("@normalframework/applications-sdk");
const {
    initialize, getSdk, loadConfig, saveConfig,
    connect, closeSession, dropConnection, tryParseValue, pointUuid, LAYER,
    hdaAttrId, hdaAttrName, readValuesRobust,
    NodeClass, AttributeIds,
} = require("../helpers");

const nodeClassName = (nc) => {
    for (const k of Object.keys(NodeClass)) {
        if (NodeClass[k] === nc) return k;
    }
    return String(nc);
};

/**
 * One level of children, shaped for the tree UI.
 *
 * The tree mirrors what the importer will actually do: Objects are containers
 * you can open, Variables are the importable leaves, and nothing below a
 * Variable is shown. An HDA item's children are its attributes (Mod DESC, Eng
 * 0%, an HA Configuration object) -- metadata, never points. Listing them
 * invited you to expand and tick things import deliberately skips; they belong
 * in the inspector, which is where they now live.
 */
const browseNode = async (session, nodeId) => {
    const result = await session.browse(nodeId);
    const children = (result.references || [])
        .filter((ref) => hdaAttrId(ref.nodeId.toString()) === null)
        .map((ref) => {
            const nid = ref.nodeId.toString();
            return {
                nodeId: nid,
                browseName: ref.browseName?.name ?? "",
                displayName: ref.displayName?.text ?? ref.browseName?.name ?? nid,
                nodeClass: nodeClassName(ref.nodeClass),
                expandable: ref.nodeClass === NodeClass.Object,
                importable: ref.nodeClass === NodeClass.Variable,
            };
        });
    // Stable, human order.
    children.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return children;
};


// --------------------------------------------------------------------------
// Inspector
// --------------------------------------------------------------------------

// AccessLevel is a bit mask (OPC UA Part 3, 5.6.2).
const ACCESS_BITS = [
    [0x01, "CurrentRead"], [0x02, "CurrentWrite"],
    [0x04, "HistoryRead"], [0x08, "HistoryWrite"],
    [0x10, "SemanticChange"], [0x20, "StatusWrite"], [0x40, "TimestampWrite"],
];
const decodeAccess = (mask) => {
    const n = Number(mask) || 0;
    return ACCESS_BITS.filter(([bit]) => (n & bit) !== 0).map(([, name]) => name);
};

const VALUE_RANKS = {
    "-3": "Scalar or 1 dimension", "-2": "Any", "-1": "Scalar",
    "0": "One or more dimensions", "1": "Array", "2": "Matrix",
};

const plain = (v) => {
    // Unwrap the node-opcua wrappers the UI has no use for.
    if (v === null || v === undefined) return null;
    if (typeof v === "object") {
        if (v.text !== undefined) return v.text;                 // LocalizedText
        if (v.name !== undefined && v.namespaceIndex !== undefined) return v.name; // QualifiedName
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number") {
            return v[0] * 4294967296 + v[1];                     // 64-bit word pair
        }
        if (typeof v.toString === "function") return v.toString();
    }
    return v;
};

// node-opcua's isGood() is strict equality with Good, so GoodMoreData --
// "here is what you asked for, more exists" -- reads as a failure. Severity is
// what matters: anything named Good* succeeded.
const isGoodish = (sc) => !sc || /^Good/.test(sc.toString());

// BadNodeIdUnknown on a node that exists in the HDA namespace means the
// historian interface has dropped its item list -- it keeps reporting Running,
// but browse returns nothing and every ns=5 id is unknown. It comes back on its
// own after a couple of minutes of quiet. Say that, instead of surfacing a raw
// OPC status the reader has to decode.
const HDA_STARVED =
    "The historian's item list is temporarily unavailable, so this node cannot be " +
    "resolved right now. It recovers on its own after a minute or two without " +
    "activity -- wait, then try again. (The historian itself is still running.)";

const looksStarved = (nodeId, status) =>
    /^ns=5;/.test(String(nodeId || "")) && /BadNodeIdUnknown/.test(String(status || ""));

const readAttrs = async (session, nodeId, ids) => {
    const dvs = await session.read(ids.map((attributeId) => ({ nodeId, attributeId })));
    const out = {};
    ids.forEach((id, i) => {
        const dv = dvs[i];
        out[id] = dv && dv.statusCode.isGood() ? dv.value?.value : undefined;
    });
    return out;
};


/** Child Variables of a node are its properties (EURange, EngineeringUnits, ...). */
const readProperties = async (session, nodeId) => {
    let refs;
    try { refs = (await session.browse(nodeId)).references || []; }
    catch (e) { return []; }
    const vars = refs.filter((r) => r.nodeClass === NodeClass.Variable).slice(0, 25);
    if (!vars.length) return [];
    let dvs = [];
    try {
        dvs = await readValuesRobust(session, vars.map((r) => r.nodeId.toString()));
    } catch (e) { return []; }
    return vars.map((r, i) => {
        const dv = dvs[i];
        let val = dv ? plain(dv.value?.value) : null;
        // EURange arrives as a structure; flatten it to something readable.
        if (val && typeof val === "object" && val.low !== undefined && val.high !== undefined) {
            val = `${val.low} … ${val.high}`;
        }
        const nid = r.nodeId.toString();
        // Prefer the server's DisplayName. BrowseName on an HDA property is the
        // raw numeric attribute id (2147483650), which is useless in a UI.
        const attrId = hdaAttrId(nid);
        const display = r.displayName?.text;
        const name = display || hdaAttrName(attrId) || r.browseName?.name || "";
        return {
            name,
            attrId,
            attrStandardName: attrId !== null ? hdaAttrName(attrId) : null,
            nodeId: nid,
            value: typeof val === "object" ? JSON.stringify(val) : val,
            status: dv ? dv.statusCode.toString() : "no reply",
        };
    });
};

module.exports = async ({ sdk, config, args }) => {
    initialize(sdk);
    const action = args?.action || "";

    // Config-only actions need no OPC connection.
    try {
        if (action === "load_config") {
            const cfg = await loadConfig();
            return NormalSdk.InvokeSuccess(JSON.stringify({
                config: cfg,
                // Echo connection settings so the UI can show them (never the password).
                connection: {
                    endpoint: config.endpoint || "",
                    username: config.username || "",
                    securityMode: config.securityMode || "None",
                    securityPolicy: config.securityPolicy || "None",
                    hasPassword: !!config.password,
                },
            }));
        }

        if (action === "save_config") {
            const partial = {};
            if (args.selectedNodes !== undefined) partial.selectedNodes = safeParse(args.selectedNodes, []);
            if (args.trendPeriod !== undefined) partial.trendPeriod = Number(args.trendPeriod) || 0;
            const merged = await saveConfig(partial);
            return NormalSdk.InvokeSuccess(JSON.stringify({ config: merged }));
        }
    } catch (e) {
        return NormalSdk.InvokeError(`${action} failed: ${e.message}`);
    }

    // Everything below needs a live session.
    if (!config.endpoint) {
        return NormalSdk.InvokeError("No endpoint configured. Set it in the app configuration.");
    }

    let client, session;
    try {
        ({ client, session } = await connect(config));

        switch (action) {
            case "test_connection": {
                const server = await session.readNamespaceArray().catch(() => []);
                return NormalSdk.InvokeSuccess(JSON.stringify({
                    ok: true,
                    endpoint: config.endpoint,
                    anonymous: !config.username,
                    namespaces: server,
                }));
            }

            case "browse_node": {
                const nodeId = args.nodeId || "RootFolder";
                const children = await browseNode(session, nodeId);
                return NormalSdk.InvokeSuccess(JSON.stringify({ nodeId, children }));
            }

            case "read_node": {
                const nodeId = args.nodeId;
                if (!nodeId) return NormalSdk.InvokeError("read_node requires nodeId");
                const dv = await session.read({ nodeId, attributeId: AttributeIds.Value });
                const parsed = tryParseValue(dv);
                // tryParseValue only yields NF-storable numerics/booleans. A
                // String or DateTime is perfectly readable, just not trendable,
                // so show it rather than reporting "not supported" -- that gap
                // hid the historian's own ServerState during a real outage.
                const display = parsed.value
                    ? (parsed.value.double ?? parsed.value.boolean)
                    : plain(dv.value?.value);
                return NormalSdk.InvokeSuccess(JSON.stringify({
                    nodeId,
                    status: dv.statusCode.toString(),
                    value: parsed.value ?? null,
                    display: typeof display === "object" ? JSON.stringify(display) : display,
                    error: parsed.error ?? null,
                }));
            }

            case "inspect_node": {
                const nodeId = args.nodeId;
                if (!nodeId) return NormalSdk.InvokeError("inspect_node requires nodeId");
                const A = AttributeIds;

                const a = await readAttrs(session, nodeId, [
                    A.NodeClass, A.BrowseName, A.DisplayName, A.Description,
                    A.DataType, A.ValueRank, A.ArrayDimensions,
                    A.AccessLevel, A.UserAccessLevel,
                    A.MinimumSamplingInterval, A.Historizing,
                ]);

                // Value is read separately so a Bad status does not poison the rest.
                let value = null, status = null, sourceTs = null, serverTs = null;
                try {
                    const dv = await session.read({ nodeId, attributeId: A.Value });
                    status = dv.statusCode.toString();
                    sourceTs = dv.sourceTimestamp || null;
                    serverTs = dv.serverTimestamp || null;
                    const parsed = tryParseValue(dv);
                    value = parsed.value
                        ? (parsed.value.double ?? parsed.value.boolean)
                        : plain(dv.value?.value);
                    if (typeof value === "object") value = JSON.stringify(value);
                } catch (e) { status = `read failed: ${e.message}`; }

                // Resolve the DataType nodeId to a human name.
                let dataTypeName = null;
                const dtNode = a[A.DataType];
                if (dtNode) {
                    try {
                        const dn = await session.read({
                            nodeId: dtNode.toString(), attributeId: A.BrowseName });
                        dataTypeName = plain(dn.value?.value);
                    } catch (e) { /* leave null */ }
                }

                const accessFlags = decodeAccess(a[A.AccessLevel]);
                const historizing = a[A.Historizing] === true;
                const properties = await readProperties(session, nodeId);

                // Does NF already hold this node?
                let nf = { imported: false };
                try {
                    const uuid = pointUuid(nodeId);
                    const r = await sdk.http.get("/api/v1/point/points-id", {
                        params: { layer: LAYER, uuids: uuid } });
                    const pt = (r.data?.points || [])[0];
                    if (pt) nf = { imported: true, uuid, period: pt.period || null,
                                   name: pt.name, layer: LAYER };
                } catch (e) { /* non-fatal */ }

                return NormalSdk.InvokeSuccess(JSON.stringify({
                    nodeId,
                    starved: looksStarved(nodeId, status),
                    explain: looksStarved(nodeId, status) ? HDA_STARVED : null,
                    identity: {
                        browseName: plain(a[A.BrowseName]),
                        displayName: plain(a[A.DisplayName]),
                        description: plain(a[A.Description]),
                        nodeClass: nodeClassName(a[A.NodeClass]),
                    },
                    value: { value, status, sourceTimestamp: sourceTs, serverTimestamp: serverTs },
                    dataType: {
                        nodeId: dtNode ? dtNode.toString() : null,
                        name: dataTypeName,
                        valueRank: VALUE_RANKS[String(a[A.ValueRank])] ?? a[A.ValueRank] ?? null,
                        arrayDimensions: a[A.ArrayDimensions] ?? null,
                    },
                    access: {
                        flags: accessFlags,
                        userFlags: decodeAccess(a[A.UserAccessLevel]),
                        historizing,
                        minimumSamplingInterval: a[A.MinimumSamplingInterval] ?? null,
                        // Either bit is enough to try a HistoryRead.
                        supportsHistory: accessFlags.includes("HistoryRead") || historizing,
                    },
                    properties,
                    nf,
                }));
            }

            case "read_history": {
                const nodeId = args.nodeId;
                if (!nodeId) return NormalSdk.InvokeError("read_history requires nodeId");
                const to = args.to ? new Date(args.to) : new Date();
                const from = args.from ? new Date(args.from)
                                       : new Date(to.getTime() - 60 * 60 * 1000);
                const limit = Math.min(Number(args.limit) || 500, 5000);

                let res;
                try {
                    res = await session.readHistoryValue(nodeId, from, to);
                } catch (e) {
                    return NormalSdk.InvokeError(`HistoryRead failed: ${e.message}`);
                }
                const r = Array.isArray(res) ? res[0] : res;
                if (r && r.statusCode && !isGoodish(r.statusCode)) {
                    const st = r.statusCode.toString();
                    return NormalSdk.InvokeSuccess(JSON.stringify({
                        nodeId, from, to, supported: false, status: st,
                        starved: looksStarved(nodeId, st),
                        explain: looksStarved(nodeId, st) ? HDA_STARVED : null,
                        values: [], count: 0,
                    }));
                }
                const dvs = (r && r.historyData && r.historyData.dataValues) || [];
                const values = dvs.slice(0, limit).map((dv) => ({
                    ts: dv.sourceTimestamp || dv.serverTimestamp || null,
                    value: plain(dv.value?.value),
                    status: dv.statusCode ? dv.statusCode.toString() : "",
                }));
                return NormalSdk.InvokeSuccess(JSON.stringify({
                    nodeId, from, to, supported: true,
                    count: values.length, truncated: dvs.length > limit, values,
                }));
            }

            case "history_extent": {
                const nodeId = args.nodeId;
                if (!nodeId) return NormalSdk.InvokeError("history_extent requires nodeId");

                // A HistoryRead with startTime > endTime is defined to walk
                // backwards, so one bounded read at each end gives the extent
                // without pulling the archive. numValuesPerNode caps the reply;
                // if a server ignores it we still only take the first sample.
                const EPOCH = new Date("1970-01-01T00:00:00Z");
                const now = new Date();

                const probe = async (from, to) => {
                    try {
                        const r0 = await session.readHistoryValue(
                            nodeId, from, to, { numValuesPerNode: 1, returnBounds: false });
                        const r = Array.isArray(r0) ? r0[0] : r0;
                        if (r && r.statusCode && !isGoodish(r.statusCode)) {
                            return { error: r.statusCode.toString() };
                        }
                        const dvs = (r && r.historyData && r.historyData.dataValues) || [];
                        const dv = dvs[0];
                        if (!dv) return { empty: true, returned: dvs.length };
                        return {
                            ts: dv.sourceTimestamp || dv.serverTimestamp || null,
                            value: plain(dv.value?.value),
                            status: dv.statusCode ? dv.statusCode.toString() : "",
                            returned: dvs.length,
                        };
                    } catch (e) {
                        return { error: e.message };
                    }
                };

                const oldest = await probe(EPOCH, now);
                const newest = await probe(now, EPOCH);
                const starved = looksStarved(nodeId, oldest.error) || looksStarved(nodeId, newest.error);

                let spanDays = null;
                if (oldest.ts && newest.ts) {
                    spanDays = (new Date(newest.ts) - new Date(oldest.ts)) / 86400000;
                    spanDays = Math.round(spanDays * 100) / 100;
                }
                return NormalSdk.InvokeSuccess(JSON.stringify({
                    nodeId, oldest, newest, spanDays,
                    starved, explain: starved ? HDA_STARVED : null,
                    // True when the server ignored numValuesPerNode -- worth
                    // knowing before anyone widens a range in the UI.
                    boundedReadHonoured: (oldest.returned ?? 1) <= 1 && (newest.returned ?? 1) <= 1,
                }));
            }

            default:
                return NormalSdk.InvokeError(`unknown action: ${action}`);
        }
    } catch (e) {
        sdk.logEvent(`discover ${action} error: ${e.message}`);
        await dropConnection();
        return NormalSdk.InvokeError(`${action}: ${e.message}`);
    } finally {
        await closeSession(client, session);
    }
};

function safeParse(v, fallback) {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
}
