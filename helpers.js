const NormalSdk = require("@normalframework/applications-sdk");
const { DataType } = require("node-opcua");

/**
 * @type {NormalSdk.IRunParams}
 */
let _sdk;

/**
 * @param {DataValue} value
 * @param {String} nodeId
 * @param {Object} acc
 * @param {String} basePath
 * @returns {{result: 'error', message: String} | {result: 'success', value: NormalSdk.WritePointValue & {ts: string}}}
 * 
 */
const tryParseValue = (value) => {

    let parsedValue = undefined;


    if (!value.statusCode.isGood()) {
        return { result: 'error', message: value.statusCode.toString() };
    }
    else {
        switch (value.value.dataType) {
            case DataType.Boolean:
                parsedValue = {
                    boolean: value.value.value,
                    ts: value.serverTimestamp,
                }
                break;
            case DataType.Double:
                parsedValue = {
                    double: value.value.value,
                    ts: value.serverTimestamp,
                }
                break;
            case DataType.Float:
                parsedValue = {
                    double: value.value.value,
                    ts: value.serverTimestamp,
                }
                break;
            case DataType.Int16:
                parsedValue = {
                    real: value.value.value,
                    ts: value.serverTimestamp,
                }
                break;
            case DataType.Int32:
                parsedValue = {
                    real: value.value.value,
                    ts: value.serverTimestamp,
                }
                break;
            case DataType.Int64:
                parsedValue = {
                    real: value.value.value,
                    ts: value.serverTimestamp,
                }
                break;
        }

        if (parsedValue === undefined) {
            return { result: 'error', message: `value type ${DataType[value.value.dataType]} not supported` };
        }

        return {
            result: 'success',
            value: parsedValue
        }
    }
}

const isInTargetPath = (targetPath, path) => {
    const targetPathParts = targetPath.split("/");
    const pathParts = path.split("/").slice(0, targetPathParts.length)
    for (let i = 0; i < pathParts.length; i++) {
        if (pathParts[i] !== targetPathParts[i]) {
            return false;
        }
    }
    return true;
}

const upsertPoint = async (point) => {
    const sdk = getSdk();

    const request = {
        points: [point]
    };
    return await sdk.http.post("/api/v1/point/points", request);
}

const addPointValue = async (pointValue) => {
    const sdk = getSdk();
    try {
        console.log("staring add point value")
        const res = await sdk.http.post("/api/v1/point/data", pointValue);
        console.log("successfully added data")
        return res;
    } catch (e) {
        console.log("error adding data", e)
    }
}



/**
 * Invoke hook function
 * @param {NormalSdk.IRunParams} sdk
 */
const initialize = async (sdk) => {
    _sdk = sdk;
}

const getSdk = () => {
    if (_sdk === undefined) {
        throw new Error("SDK not initialized");
    }
    return _sdk;
}

module.exports = { getSdk, tryParseValue, isInTargetPath, upsertPoint, addPointValue, initialize };