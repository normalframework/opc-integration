// Creates points for the nodes the UI selected. On-request only -- this is the
// discovery half, and it never runs on a schedule.
//
// args: selectedNodes (JSON array of {nodeId,path}), trendPeriod (seconds).
// When omitted, both are read from state/config.json.

const NormalSdk = require("@normalframework/applications-sdk");
const {
    initialize, loadConfig, connect, closeSession, dropConnection,
    buildPoint, upsertPoints, pointUuid,
    hdaAttrId, readValuesRobust,
    NodeClass, AttributeIds,
} = require("../helpers");

// Classic-OPC HDA item attributes. These two also populate first-class point
// fields; every other attribute the server exposes is carried as an attr.
const ATTR_DESCRIPTION = 0x02;
const ATTR_ENG_UNITS   = 0x03;

/** "Eng 100%" -> "eng_100", so attrs are searchable and stable to type. */
const slug = (v) => String(v || "").toLowerCase()
    .replace(/%/g, "_pct").replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 40);

const attrKey = (a) =>
    "opc_" + (slug(a.name) || slug(hdaAttrName(a.attrId)) || "attr_" + a.attrId.toString(16));

const attrText = (raw) => {
    if (raw === null || raw === undefined) return "";
    if (raw instanceof Date) return raw.toISOString();
    if (typeof raw === "object") {
        if (raw.text !== undefined) return String(raw.text);
        try { return JSON.stringify(raw); } catch (e) { return String(raw); }
    }
    return String(raw);
};

const MAX_DEPTH = 12;
// Filled in during the walk; reported once at the end.
const attrStatus = { ok: 0, bad: {} };
const BATCH = 100;

const parseNodeId = (nid) => {
    // "ns=2;s=Demo.Dynamic.Double" -> namespace 2, identifierType s, identifier ...
    const m = /^ns=(\d+);([isgb])=(.*)$/.exec(nid);
    if (!m) return { namespace: "", identifierType: "", identifier: nid };
    return { namespace: m[1], identifierType: m[2], identifier: m[3] };
};

/** Depth-first walk collecting Variable nodes under a starting node. */
const collectVariables = async (session, sdk, node, depth, out, seen, insideVariable) => {
    if (depth > MAX_DEPTH || out.length > 20000) return;
    let refs;
    try {
        refs = (await session.browse(node.nodeId)).references || [];
    } catch (e) {
        sdk.logEvent(`browse failed at ${node.path}: ${e.message}`);
        return;
    }
    // An HDA item's attributes are child Variables too. They are metadata about
    // the node, not points of their own -- importing them would create a point
    // called "Mod DESC" for every tag.
    const attrs = [];
    for (const ref of refs) {
        const nid = ref.nodeId.toString();
        const aid = hdaAttrId(nid);
        if (aid !== null) {
            attrs.push({ attrId: aid, nodeId: nid,
                         name: ref.displayName?.text || ref.browseName?.name || "" });
            continue;
        }
        if (seen.has(nid)) continue;      // servers contain reference cycles
        seen.add(nid);
        const name = ref.browseName?.name ?? ref.displayName?.text ?? nid;
        const child = { nodeId: nid, name, path: `${node.path}/${name}` };
        // A Variable's descendants are its configuration, not process points:
        // under an HDA item sits an "HA Configuration" object holding Stepped,
        // MaxTimeInterval and friends. Once we are inside a Variable, nothing
        // below it becomes a point -- upstream opc-integration draws the same
        // line with `parentReference.nodeClass !== Variable`.
        if (ref.nodeClass === NodeClass.Variable && !insideVariable) {
            out.push({ ...child, parentName: node.name });
        }
        if (ref.nodeClass === NodeClass.Object || ref.nodeClass === NodeClass.Variable) {
            await collectVariables(session, sdk, { ...child, name }, depth + 1, out, seen,
                insideVariable || ref.nodeClass === NodeClass.Variable);
        }
    }
    // Read the attributes NOW, while the server still has this item warm.
    // Deferring them to a batch at the end reliably returns
    // BadWaitingForInitialData -- DeltaV only keeps a cold attribute item on
    // scan briefly after the browse that touched it.
    const self = out.find((v) => v.nodeId === node.nodeId);
    if (self && attrs.length) {
        // Read every attribute the item exposes, not just the two that map to
        // first-class fields -- Eng 100%/Eng 0% give the range, Currently On
        // Scan and Last Download give provenance, and they cost one read.
        try {
            const dvs = await readValuesRobust(session, attrs.map((a) => a.nodeId));
            self.props = self.props || {};
            attrs.forEach((a, i) => {
                const dv = dvs[i];
                if (!dv || !/^Good/.test(dv.statusCode.toString())) {
                    const st = dv ? dv.statusCode.toString() : "no reply";
                    attrStatus.bad[st] = (attrStatus.bad[st] || 0) + 1;
                    return;
                }
                const text = attrText(dv.value?.value);
                if (text === "") return;
                self.props[attrKey(a)] = text;
                attrStatus.ok++;
                if (a.attrId === ATTR_DESCRIPTION) self.description = text;
                if (a.attrId === ATTR_ENG_UNITS) self.units = text;
            });
        } catch (e) {
            sdk.logEvent(`attribute read failed for ${node.path}: ${e.message}`);
        }
    }
};

module.exports = async ({ sdk, config, args }) => {
    initialize(sdk);
    const stored = await loadConfig();
    const selected = safeParse(args?.selectedNodes, null) ?? stored.selectedNodes ?? [];
    const trendPeriod = Number(args?.trendPeriod ?? stored.trendPeriod ?? 0);

    if (!selected.length) return NormalSdk.InvokeError("Nothing selected to import.");
    if (!config.endpoint) return NormalSdk.InvokeError("No endpoint configured.");

    let client, session;
    try {
        ({ client, session } = await connect(config));
        sdk.logEvent(`Connected. Importing ${selected.length} selection(s), period=${trendPeriod}s`);

        // A device point gives every imported point a common parent.
        const deviceUuid = pointUuid(config.endpoint);
        await upsertPoints([{
            uuid: deviceUuid, parent_uuid: deviceUuid,
            name: config.endpoint, type: "DEVICE",
        }]);

        const variables = [];
        const seen = new Set();
        for (const sel of selected) {
            const start = {
                nodeId: sel.nodeId,
                name: sel.browseName || sel.name || sel.nodeId,
                path: sel.path || sel.nodeId,
            };
            // A directly-selected Variable is itself importable.
            if (sel.importable) {
                variables.push({ ...start, parentName: "" });
                seen.add(sel.nodeId);
            }
            await collectVariables(session, sdk, start, 0, variables, seen, !!sel.importable);
            sdk.logEvent(`walked ${start.path}: ${variables.length} variable(s) so far`);
        }

        if (!variables.length) {
            return NormalSdk.InvokeSuccess(JSON.stringify({ imported: 0, message: "no variables found" }));
        }

        if (attrStatus.ok || Object.keys(attrStatus.bad).length) {
            sdk.logEvent(`resolved ${attrStatus.ok} HDA attribute value(s)`);
            for (const [st, n] of Object.entries(attrStatus.bad)) {
                sdk.logEvent(`  ${n} attribute(s) unreadable: ${st}`);
            }
        }

        let imported = 0;
        for (let i = 0; i < variables.length; i += BATCH) {
            const chunk = variables.slice(i, i + BATCH).map((v) => {
                const ids = parseNodeId(v.nodeId);
                const p = buildPoint({
                    nodeId: v.nodeId,
                    name: v.name,
                    parentName: v.parentName,
                    parentUuid: deviceUuid,
                    path: v.path,
                    browseName: v.name,
                    namespace: ids.namespace,
                    identifierType: ids.identifierType,
                    identifier: ids.identifier,
                    units: v.units || "",
                });
                // `description` is a first-class point field, so the friendly
                // name shows up in the Object Explorer without any modelling.
                if (v.description) p.description = v.description;
                // Everything else the item published, as searchable attrs.
                if (v.props) Object.assign(p.attrs, v.props);
                // `period` is what the trend hook's point query selects on, so
                // setting it here is the whole handoff between the two halves.
                // It is a top-level google.protobuf.Duration, NOT an attr: a
                // loose attrs.period string is stored but never indexed, so the
                // numeric query would silently match nothing.
                if (trendPeriod > 0) p.period = `${trendPeriod}s`;
                return p;
            });
            try {
                await upsertPoints(chunk);
                imported += chunk.length;
                sdk.logEvent(`imported ${imported}/${variables.length}`);
            } catch (e) {
                sdk.logEvent(`batch insert failed at ${i}: ${e.message}`);
            }
        }

        return NormalSdk.InvokeSuccess(JSON.stringify({
            imported, found: variables.length, trendPeriod,
        }));
    } catch (e) {
        sdk.logEvent(`import-selected error: ${e.message}`);
        await dropConnection();
        return NormalSdk.InvokeError(e.message);
    } finally {
        await closeSession(client, session);
    }
};

function safeParse(v, fallback) {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
}
