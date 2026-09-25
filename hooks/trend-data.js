// Scheduled polling. Bound to a point query on `period`, so it only ever sees
// points a user marked for trending in the Object Explorer.
//
// This hook NEVER browses. The OPC nodeId lives on each point as protocol_id,
// so the whole poll is one batched session.read() instead of walking the tree.

const NormalSdk = require("@normalframework/applications-sdk");
const {
    initialize, connect, closeSession, dropConnection,
    tryParseValue, postPointData, AttributeIds,
} = require("../helpers");

const READ_BATCH = Number(process.env.OPC_READ_BATCH || 100);

/** protocol_id is canonical; id_string is the same value kept for search. */
const nodeIdOf = (p) =>
    p.protocolId || p.protocol_id || p.attrs?.id_string || "";

module.exports = async ({ sdk, config, points }) => {
    initialize(sdk);

    if (!config.endpoint) return NormalSdk.InvokeError("No endpoint configured.");
    if (!points || points.length === 0) {
        sdk.logEvent("No points bound to this hook — set a period on some points to start trending.");
        return;
    }

    const targets = [];
    let skipped = 0;
    for (const p of points) {
        const nid = nodeIdOf(p);
        if (!nid) { skipped++; continue; }
        targets.push({ uuid: p.uuid, nodeId: nid });
    }
    if (skipped) sdk.logEvent(`${skipped} point(s) have no protocol_id and were skipped.`);
    if (!targets.length) return NormalSdk.InvokeError("No points carried a usable protocol_id.");

    let client, session;
    let good = 0, degraded = 0, failed = 0;
    const badSamples = [];

    try {
        ({ client, session } = await connect(config));

        for (let i = 0; i < targets.length; i += READ_BATCH) {
            const chunk = targets.slice(i, i + READ_BATCH);
            const nodesToRead = chunk.map((t) => ({
                nodeId: t.nodeId,
                attributeId: AttributeIds.Value,
            }));

            let results;
            try {
                // One round trip for the whole batch -- the entire point of
                // storing the nodeId on the point instead of re-browsing.
                results = await session.read(nodesToRead);
            } catch (e) {
                // A slow or hostile server can time out the whole batch. Fall
                // back to single reads so one bad node can't blind the rest,
                // and record the failure on each point that still fails.
                sdk.logEvent(`batch read failed at offset ${i} (${e.message}); retrying individually`);
                results = [];
                for (const t of chunk) {
                    try {
                        results.push(await session.read({ nodeId: t.nodeId, attributeId: AttributeIds.Value }));
                    } catch (inner) {
                        results.push(null);
                        await postPointData(t.uuid, null, `read failed: ${inner.message}`);
                    }
                }
            }

            for (let j = 0; j < chunk.length; j++) {
                const dv = results[j];
                if (!dv) { failed++; continue; }   // already recorded above
                const parsed = tryParseValue(dv);
                // Value and error go in one request; a degraded point keeps trending.
                await postPointData(chunk[j].uuid, parsed.value, parsed.error);
                if (parsed.error) {
                    degraded++;
                    if (badSamples.length < 10) badSamples.push(`${chunk[j].nodeId}: ${parsed.error}`);
                } else {
                    good++;
                }
            }
        }

        if (degraded === 0 && failed === 0) {
            sdk.logEvent(`Polled ${good} point(s); all statuses Good.`);
        } else {
            sdk.logEvent(`Polled ${targets.length} point(s): ${good} good, ${degraded} bad/uncertain, ${failed} unreadable.`);
            for (const b of badSamples) sdk.logEvent(`  BAD STATUS ${b}`);
            if (degraded > badSamples.length) {
                sdk.logEvent(`  ... and ${degraded - badSamples.length} more`);
            }
        }
    } catch (e) {
        sdk.logEvent(`trend-data error: ${e.message}`);
        await dropConnection();
        return NormalSdk.InvokeError(e.message);
    } finally {
        await closeSession(client, session);
    }
};
