const { OPCUAClient, ClientSession, NodeClass, AttributeIds } = require("node-opcua");
const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const { isInTargetPath, tryParseValue, initialize, getSdk, upsertPoint, addPointValue } = require("./helpers");

const OCP_POINT_NAMESPACE = "068a0ecf-aa20-447e-9467-2f705f066d6c";
const targetClasses = [NodeClass.Object, NodeClass.Variable];


/**
 * Invoke hook function
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ config, sdk }) => {
    initialize(sdk);
    const endpoint = config.endpoint;

    const client = OPCUAClient.create({
        discoveryUrl: endpoint,
        endpointMustExist: false,
    });

    await client.connect(endpoint);
    const session = await client.createSession();
    await getChildren(session, "RootFolder");

}

/**
 * @param {ClientSession} session
 * @param {String} nodeId
 * @param {String?} basePath
 * 
 */
const getChildren = async (session, nodeId, basePath = "") => {
    const sdk = getSdk();
    const data = await session.browse(nodeId);
    if (data.references.length === 0) {
        return;
    }

    for (const reference of data.references) {
        const currentPath = `${basePath}/${reference.displayName.text}`;
        const shouldImport = isInTargetPath(targetPath, currentPath) && targetClasses.includes(reference.nodeClass);
        if (shouldImport) {
            sdk.logEvent(`Importing ${reference.nodeId.displayText()} at ${currentPath}`)
            const point = {
                uuid: uuidv5(reference.nodeId.displayText(), OCP_POINT_NAMESPACE),
                layer: "opc",
                attrs: {
                    path: currentPath,
                    browse_name: reference.browseName.toString(),
                    identifierType: reference.nodeId.identifierType.toString(),
                    identifier: reference.nodeId.value.toString(),
                    namespace: reference.nodeId.namespace.toString(),
                    id_string: reference.nodeId.displayText()
                },
            };

            await upsertPoint(point);

            if (reference.nodeClass === NodeClass.Variable) {
                sdk.logEvent(`Reading value for ${reference.nodeId.displayText()}`);
                const dataValue = await session.read({ nodeId: reference.nodeId, attributeId: AttributeIds.Value });
                const parseValueResult = tryParseValue(dataValue);
                if (parseValueResult.result === 'success') {
                    await addPointValue({ uuid: point.uuid, values: [parseValueResult.value] });
                } else {
                    sdk.logEvent("Unable to parse value: ", parseValueResult.message);
                }
            }
            await getChildren(session, reference.nodeId, currentPath);
        };
    }

}
