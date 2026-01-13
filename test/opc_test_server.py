#!/usr/bin/env python3
"""
OPC-UA Test Server with Synthetic Data
Demonstrates various OPC-UA features and data types for testing the OPC plugin
"""

import asyncio
import random
import math
import time
from datetime import datetime
from asyncua import Server, ua
from asyncua.common.methods import uamethod


class OPCTestServer:
    def __init__(self, endpoint="opc.tcp://0.0.0.0:4840/freeopcua/server/"):
        self.server = Server()
        self.endpoint = endpoint
        self.running = True
        
    async def init(self):
        """Initialize the OPC-UA server"""
        await self.server.init()
        self.server.set_endpoint(self.endpoint)
        self.server.set_server_name("Normal Framework OPC Test Server")
        
        # Set up security (optional - allows anonymous access)
        self.server.set_security_policy([
            ua.SecurityPolicyType.NoSecurity,
        ])
        
        # Get Objects node
        objects = self.server.nodes.objects
        
        # Create namespace
        uri = "http://normalframework.com/opctest"
        idx = await self.server.register_namespace(uri)
        
        # Create device structure
        await self._create_device_structure(objects, idx)
        
        print(f"Server initialized at {self.endpoint}")
        print(f"Namespace index: {idx}")
        
    async def _create_device_structure(self, objects, idx):
        """Create a hierarchical device structure with various data types"""
        
        # Create main device set
        device_set = await objects.add_folder(idx, "DeviceSet")
        
        # Create Coffee Machine (similar to demo server)
        coffee_machine = await device_set.add_folder(idx, "CoffeeMachine")
        await self._create_coffee_machine(coffee_machine, idx)
        
        # Create Industrial Sensors
        sensors = await device_set.add_folder(idx, "IndustrialSensors")
        await self._create_sensors(sensors, idx)
        
        # Create HVAC System
        hvac = await device_set.add_folder(idx, "HVACSystem")
        await self._create_hvac(hvac, idx)
        
        # Create Test Variables (all data types)
        test_vars = await device_set.add_folder(idx, "TestVariables")
        await self._create_test_variables(test_vars, idx)
        
    async def _create_coffee_machine(self, parent, idx):
        """Create coffee machine with status and controls"""
        
        # Status variables
        self.coffee_temp = await parent.add_variable(idx, "Temperature", 85.5)
        await self.coffee_temp.set_writable()
        await self.coffee_temp.set_attr(ua.AttributeIds.Description, 
            ua.LocalizedText("Coffee temperature in Celsius"))
        
        self.coffee_level = await parent.add_variable(idx, "WaterLevel", 75.0)
        await self.coffee_level.set_writable()
        
        self.coffee_brewing = await parent.add_variable(idx, "IsBrewing", False)
        await self.coffee_brewing.set_writable()
        
        self.coffee_cups_made = await parent.add_variable(idx, "CupsMadeToday", 0)
        await self.coffee_cups_made.set_writable()
        
        # Settings folder
        settings = await parent.add_folder(idx, "Settings")
        self.coffee_strength = await settings.add_variable(idx, "BrewStrength", 3)
        await self.coffee_strength.set_writable()
        
        self.coffee_size = await settings.add_variable(idx, "CupSize", "Medium")
        await self.coffee_size.set_writable()
        
    async def _create_sensors(self, parent, idx):
        """Create industrial sensors with various data types"""
        
        # Pressure sensor
        pressure_sensor = await parent.add_folder(idx, "PressureSensor")
        self.pressure_value = await pressure_sensor.add_variable(idx, "Value", 101.3, 
                                                                  varianttype=ua.VariantType.Double)
        await self.pressure_value.set_writable()
        
        self.pressure_unit = await pressure_sensor.add_variable(idx, "Unit", "kPa")
        self.pressure_status = await pressure_sensor.add_variable(idx, "Status", "OK")
        
        # Temperature sensor array
        temp_array = await parent.add_folder(idx, "TemperatureArray")
        self.temp_sensors = []
        for i in range(5):
            temp = await temp_array.add_variable(idx, f"Sensor{i+1}", 20.0 + i, 
                                                 varianttype=ua.VariantType.Float)
            await temp.set_writable()
            self.temp_sensors.append(temp)
        
        # Vibration sensor (Int32)
        vibration = await parent.add_folder(idx, "VibrationSensor")
        self.vibration_x = await vibration.add_variable(idx, "X_Axis", 0, 
                                                        varianttype=ua.VariantType.Int32)
        await self.vibration_x.set_writable()
        
        self.vibration_y = await vibration.add_variable(idx, "Y_Axis", 0, 
                                                        varianttype=ua.VariantType.Int32)
        await self.vibration_y.set_writable()
        
        self.vibration_z = await vibration.add_variable(idx, "Z_Axis", 0, 
                                                        varianttype=ua.VariantType.Int32)
        await self.vibration_z.set_writable()
        
    async def _create_hvac(self, parent, idx):
        """Create HVAC system with multiple zones"""
        
        for zone_num in range(1, 4):
            zone = await parent.add_folder(idx, f"Zone{zone_num}")
            
            # Create zone variables
            temp = await zone.add_variable(idx, "CurrentTemp", 22.0, 
                                          varianttype=ua.VariantType.Float)
            await temp.set_writable()
            setattr(self, f"hvac_zone{zone_num}_temp", temp)
            
            setpoint = await zone.add_variable(idx, "Setpoint", 21.0, 
                                              varianttype=ua.VariantType.Float)
            await setpoint.set_writable()
            
            humidity = await zone.add_variable(idx, "Humidity", 45.0, 
                                              varianttype=ua.VariantType.Float)
            await humidity.set_writable()
            setattr(self, f"hvac_zone{zone_num}_humidity", humidity)
            
            fan_speed = await zone.add_variable(idx, "FanSpeed", 50, 
                                               varianttype=ua.VariantType.Int16)
            await fan_speed.set_writable()
            setattr(self, f"hvac_zone{zone_num}_fan", fan_speed)
            
            is_active = await zone.add_variable(idx, "IsActive", True, 
                                               varianttype=ua.VariantType.Boolean)
            await is_active.set_writable()
            
    async def _create_test_variables(self, parent, idx):
        """Create variables of all supported data types for testing"""
        
        # Boolean
        self.test_bool = await parent.add_variable(idx, "TestBoolean", True, 
                                                   varianttype=ua.VariantType.Boolean)
        await self.test_bool.set_writable()
        
        # Integers
        self.test_int16 = await parent.add_variable(idx, "TestInt16", 100, 
                                                    varianttype=ua.VariantType.Int16)
        await self.test_int16.set_writable()
        
        self.test_int32 = await parent.add_variable(idx, "TestInt32", 100000, 
                                                    varianttype=ua.VariantType.Int32)
        await self.test_int32.set_writable()
        
        self.test_int64 = await parent.add_variable(idx, "TestInt64", 10000000000, 
                                                    varianttype=ua.VariantType.Int64)
        await self.test_int64.set_writable()
        
        # Unsigned integers
        self.test_uint16 = await parent.add_variable(idx, "TestUInt16", 200, 
                                                     varianttype=ua.VariantType.UInt16)
        await self.test_uint16.set_writable()
        
        self.test_uint32 = await parent.add_variable(idx, "TestUInt32", 200000, 
                                                     varianttype=ua.VariantType.UInt32)
        await self.test_uint32.set_writable()
        
        # Floating point
        self.test_float = await parent.add_variable(idx, "TestFloat", 3.14159, 
                                                    varianttype=ua.VariantType.Float)
        await self.test_float.set_writable()
        
        self.test_double = await parent.add_variable(idx, "TestDouble", 2.718281828, 
                                                     varianttype=ua.VariantType.Double)
        await self.test_double.set_writable()
        
        # String
        self.test_string = await parent.add_variable(idx, "TestString", "Hello OPC-UA", 
                                                     varianttype=ua.VariantType.String)
        await self.test_string.set_writable()
        
        # Byte
        self.test_byte = await parent.add_variable(idx, "TestByte", 255, 
                                                   varianttype=ua.VariantType.Byte)
        await self.test_byte.set_writable()
        
    async def update_values(self):
        """Update synthetic values to simulate real data"""
        counter = 0
        
        while self.running:
            try:
                current_time = time.time()
                
                # Coffee machine updates
                await self.coffee_temp.write_value(85 + 5 * math.sin(current_time / 10))
                await self.coffee_level.write_value(50 + 40 * abs(math.sin(current_time / 20)))
                
                if counter % 30 == 0:  # Change brewing status occasionally
                    is_brewing = await self.coffee_brewing.read_value()
                    await self.coffee_brewing.write_value(not is_brewing)
                
                # Pressure sensor with noise
                await self.pressure_value.write_value(101.3 + random.gauss(0, 0.5))
                
                # Temperature sensor array
                for i, sensor in enumerate(self.temp_sensors):
                    base_temp = 20 + i * 2
                    await sensor.write_value(base_temp + 2 * math.sin(current_time / 15 + i))
                
                # Vibration sensors (simulating machinery vibration)
                await self.vibration_x.write_value(int(100 * math.sin(current_time * 2)))
                await self.vibration_y.write_value(int(100 * math.cos(current_time * 2)))
                await self.vibration_z.write_value(int(50 * math.sin(current_time * 3)))
                
                # HVAC zones
                for zone_num in range(1, 4):
                    temp_var = getattr(self, f"hvac_zone{zone_num}_temp")
                    humidity_var = getattr(self, f"hvac_zone{zone_num}_humidity")
                    fan_var = getattr(self, f"hvac_zone{zone_num}_fan")
                    
                    await temp_var.write_value(22 + zone_num + math.sin(current_time / 30))
                    await humidity_var.write_value(45 + 10 * math.cos(current_time / 25))
                    await fan_var.write_value(int(50 + 30 * abs(math.sin(current_time / 20))))
                
                # Test variables cycling through values
                await self.test_bool.write_value(counter % 2 == 0)
                await self.test_int16.write_value(int(100 * math.sin(current_time)))
                await self.test_int32.write_value(int(100000 + 10000 * math.cos(current_time)))
                await self.test_int64.write_value(int(10000000000 + 1000000 * math.sin(current_time)))
                await self.test_float.write_value(3.14159 + 0.1 * math.sin(current_time))
                await self.test_double.write_value(2.718281828 + 0.01 * math.cos(current_time))
                
                counter += 1
                await asyncio.sleep(1)  # Update every second
                
            except Exception as e:
                print(f"Error updating values: {e}")
                await asyncio.sleep(1)
    
    async def start(self):
        """Start the OPC-UA server"""
        async with self.server:
            print("=" * 60)
            print("OPC-UA Test Server Started")
            print("=" * 60)
            print(f"Endpoint: {self.endpoint}")
            print("Press Ctrl+C to stop")
            print("=" * 60)
            
            # Start updating values
            await self.update_values()
    
    async def stop(self):
        """Stop the server"""
        self.running = False
        await self.server.stop()


async def main():
    """Main function to run the test server"""
    server = OPCTestServer(endpoint="opc.tcp://0.0.0.0:4840/freeopcua/server/")
    
    try:
        await server.init()
        await server.start()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        await server.stop()
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
