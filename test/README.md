# OPC-UA Test Server

A self-contained Python OPC-UA server for testing the Normal Framework OPC plugin.

## Features

This test server provides:

### Device Structure
- **CoffeeMachine** - Simulates a coffee maker with temperature, water level, brewing status, and settings
- **IndustrialSensors** - Various sensor types including:
  - Pressure sensor (Double)
  - Temperature sensor array (5 Float sensors)
  - Vibration sensor (3-axis Int32)
- **HVACSystem** - 3 zones with temperature, humidity, fan speed, and status
- **TestVariables** - All supported data types for testing

### Data Types Covered
- Boolean
- Int16, Int32, Int64
- UInt16, UInt32
- Float, Double
- String
- Byte

### Synthetic Data
All values are continuously updated with realistic synthetic data:
- Sinusoidal patterns for temperatures
- Random noise for pressure readings
- Vibration patterns for machinery simulation
- Time-based cycling for test variables

## Installation

```bash
cd test
pip install -r requirements.txt
```

## Running the Server

```bash
python opc_test_server.py
```

The server will start at: `opc.tcp://0.0.0.0:4840/freeopcua/server/`

Press `Ctrl+C` to stop the server.

## Connecting from the OPC Plugin

Update your `app.json` configuration:

```json
{
  "endpoint": "opc.tcp://localhost:4840/freeopcua/server/",
  "targetPaths": "RootFolder/Objects/DeviceSet"
}
```

## Testing Specific Paths

You can target specific devices:

```json
{
  "endpoint": "opc.tcp://localhost:4840/freeopcua/server/",
  "targetPaths": "RootFolder/Objects/DeviceSet/CoffeeMachine"
}
```

Or multiple paths:

```json
{
  "endpoint": "opc.tcp://localhost:4840/freeopcua/server/",
  "targetPaths": "RootFolder/Objects/DeviceSet/CoffeeMachine,RootFolder/Objects/DeviceSet/IndustrialSensors"
}
```

## Browsing with UAExpert

You can also browse this server using [UAExpert](https://www.unified-automation.com/products/development-tools/uaexpert.html):

1. Add a new server with endpoint: `opc.tcp://localhost:4840/freeopcua/server/`
2. Connect and browse the namespace
3. Navigate to DeviceSet to see all devices

## Server Structure

```
RootFolder
└── Objects
    └── DeviceSet
        ├── CoffeeMachine
        │   ├── Temperature (Double)
        │   ├── WaterLevel (Double)
        │   ├── IsBrewing (Boolean)
        │   ├── CupsMadeToday (Int32)
        │   └── Settings
        │       ├── BrewStrength (Int32)
        │       └── CupSize (String)
        ├── IndustrialSensors
        │   ├── PressureSensor
        │   │   ├── Value (Double)
        │   │   ├── Unit (String)
        │   │   └── Status (String)
        │   ├── TemperatureArray
        │   │   ├── Sensor1 (Float)
        │   │   ├── Sensor2 (Float)
        │   │   ├── Sensor3 (Float)
        │   │   ├── Sensor4 (Float)
        │   │   └── Sensor5 (Float)
        │   └── VibrationSensor
        │       ├── X_Axis (Int32)
        │       ├── Y_Axis (Int32)
        │       └── Z_Axis (Int32)
        ├── HVACSystem
        │   ├── Zone1
        │   │   ├── CurrentTemp (Float)
        │   │   ├── Setpoint (Float)
        │   │   ├── Humidity (Float)
        │   │   ├── FanSpeed (Int16)
        │   │   └── IsActive (Boolean)
        │   ├── Zone2 (same structure)
        │   └── Zone3 (same structure)
        └── TestVariables
            ├── TestBoolean (Boolean)
            ├── TestInt16 (Int16)
            ├── TestInt32 (Int32)
            ├── TestInt64 (Int64)
            ├── TestUInt16 (UInt16)
            ├── TestUInt32 (UInt32)
            ├── TestFloat (Float)
            ├── TestDouble (Double)
            ├── TestString (String)
            └── TestByte (Byte)
```

## Notes

- The server updates all values every second
- Anonymous access is enabled (no authentication required)
- All variables are writable for testing
- Server logs are printed to stdout
