const NormalSdk = require("@normalframework/applications-sdk");


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
export const tryParseValue = (value) => {

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
            case DataType.Double:
                parsedValue = {
                    double: value.value.value,
                    ts: value.serverTimestamp,
                }
            case DataType.Float:
                parsedValue = {
                    double: value.value.value,
                    ts: value.serverTimestamp,
                }
            case DataType.Int16:
                parsedValue = {
                    real: value.value.value,
                    ts: value.serverTimestamp,
                }
            case DataType.Int32:
                parsedValue = {
                    real: value.value.value,
                    ts: value.serverTimestamp,
                }
            case DataType.Int64:
                parsedValue = {
                    real: value.value.value,
                    ts: value.serverTimestamp,
                }
        }

        if (parsedValue === undefined) {
            return { result: 'error', message: "value type not supported" };
        }

        return {
            result: 'success',
            value: parsedValue
        }
    }
}

export const isInTargetPath = (targetPath, path) => {
    const targetPathParts = targetPath.split("/");
    const pathParts = path.split("/").slice(0, targetPathParts.length)
    for (let i = 0; i < pathParts.length; i++) {
        if (pathParts[i] !== targetPathParts[i]) {
            return false;
        }
    }
    return true;
}

export const upsertPoint = async () => {
    const sdk = getSdk();

    const request = {
        points: [point]
    };

    return await sdk.http.post("/api/v1/point/points", request);
}

export const addPointValue = async (pointValue) => {
    const sdk = getSdk();
    return sdk.http.post("api/v1/point/data", pointValue);
}



/**
 * Invoke hook function
 * @param {NormalSdk.IRunParams} sdk
 */
export const initialize = async (sdk) => {
    _sdk = sdk;
}

export const getSdk = () => {
    if (_sdk === undefined) {
        throw new Error("SDK not initialized");
    }
    return _sdk;
}