

# NF OPC Integration

The OPC Integration uses the OPC protocol to import objects from an OPC into the Normal Framework. The integration leverages the [node-opcua](https://github.com/node-opcua/node-opcua) npm package to connect to the OPC Server. 

Currently, only variable type points are imported.

### Getting Started

Install the application using git. Then configure it.

### Configuration

`endpoint` (required) - the OPC Server URL to connect to. E.g. `opc.tcp://opcuademo.sterfive.com:26543`

`targetPaths` (optional) - comma delimited paths to import. If not defined, all objects on the server will be imported. E.g. `RootFolder/Objects/DeviceSet/CoffeeMachine,RootFolder/Objects/Boiler#1`

### Authentication
*** TODO ***


### Viewing Data

Data is imported to the `hpl:opc:1` layer. This layer utilized the NF path type feature to organize the data a hierachy which follows the OPC structure.


