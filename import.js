const { OPCUAClient, ClientSession, NodeClass, AttributeIds, ReferenceDescription } = require("node-opcua");
const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const { isInTargetPath, tryParseValue, initialize, getSdk, upsertPoint, addPointValue } = require("./helpers");

const OCP_POINT_NAMESPACE = "068a0ecf-aa20-447e-9467-2f705f066d6c";
const targetClasses = [NodeClass.Variable];
const exploreClasses = [NodeClass.Object, NodeClass.Variable];
targetPath = "";

// endpoint = "opc.tcp://opcuademo.sterfive.com:26543";
// targetPath = "RootFolder/Objects/DeviceSet/CoffeeMachine";


/**
 * Invoke hook function
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ config, sdk }) => {
    initialize(sdk);
    targetPath = config.targetPath;


    const client = OPCUAClient.create({
        discoveryUrl: config.endpoint,
        endpointMustExist: false,
    });

    console.log("starting connect")
    await client.connect(endpoint)
    console.log("connected");
    const session = await client.createSession();

    console.log("starting root folder")
    const refs = await getReferencesWithValue("RootFolder", session)
    await getChildren(session, "RootFolder", refs);

}

/**
 * @param {ReferenceDescription[]} references
 * 
 */
const getUnits = async (references) => {
    const unitsUri = "http://www.opcfoundation.org/UA/units/un/cefact";
    for (const ref of references) { 
        if(ref.value?.value?.namespaceUri === unitsUri) {
            return ref.value.value.description.text
        }
    }
}

const getReferencesWithValue = async (nodeId, session) => {
    const result = [];
    const references = (await session.browse(nodeId)).references;
    for (const reference of references) {
       const value = await session.read({ nodeId: reference.nodeId, attributeId: AttributeIds.Value }); 
        result.push({reference, value})
    }
    return result;
}

/**
 * @param {ClientSession} session
 * @param {String} nodeId
 * @param {String?} basePath
 * @param {ReferenceDescription[]} references
 * 
 */
const getChildren = async (session, basePath = "", references, parentReference) => {
    const sdk = getSdk()

    for (const ref of references) { 
        const currentPath = `${basePath}/${ref.reference.displayName.text}`;
        // we don't want to import children of variables (they are all just value types e.g. engineering units)
        const shouldImport = isInTargetPath(targetPath, currentPath) && targetClasses.includes(ref.reference.nodeClass) && parentReference?.reference?.nodeClass !== NodeClass.Variable;
        const shouldDiscover = isInTargetPath(targetPath, currentPath) && exploreClasses.includes(ref.reference.nodeClass);
        const innerReferences = await getReferencesWithValue(ref.reference.nodeId, session)
        if (shouldImport) {
            const units = await getUnits(innerReferences)
            const point = {
                uuid: uuidv5(ref.reference.nodeId.displayText(), OCP_POINT_NAMESPACE),
                layer: "opc",
                attrs: {
                    path: currentPath,
                    browse_name: ref.reference.browseName.toString(),
                    identifierType: ref.reference.nodeId.identifierType.toString(),
                    identifier: ref.reference.nodeId.value.toString(),
                    namespace: ref.reference.nodeId.namespace.toString(),
                    id_string: ref.reference.nodeId.displayText(),
                    display: units
                },
            };

            await upsertPoint(point);

            if (ref.reference.nodeClass === NodeClass.Variable) {
                const parseValueResult = tryParseValue(ref.value);
                if (parseValueResult.result === 'success') {
                    await addPointValue({ uuid: point.uuid, values: [parseValueResult.value] });
                } else {
                    sdk.logEvent("Unable to parse value: ", parseValueResult.message);
                }
            }
        };
        if(shouldDiscover) {
            await getChildren(session, currentPath, innerReferences, ref);
        }
    }
}