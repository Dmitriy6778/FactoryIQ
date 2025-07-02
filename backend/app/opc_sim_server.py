from asyncua import Server
import asyncio
import random

async def main():
    server = Server()
    await server.init()
    server.set_endpoint("opc.tcp://127.0.0.1:4849/freeopcua/server/")
    server.set_server_name("FactoryIQ OPC UA Sim")

    idx = await server.register_namespace("http://factoryiq.org")

    obj = await server.nodes.objects.add_object(idx, "PLC_1")

    # Основные весовые теги (инкрементируются)
    tags_config = [
        ("Weight_Sunflower",      8,  random.uniform(12_000_000, 25_000_000)),   # Семечка, общий вес (сырьё)
        ("Weight_Huls",           9,  random.uniform(1_500_000, 4_000_000)),     # Лузга
        ("Weight_Meal",          10,  random.uniform(5_000_000, 11_000_000)),    # Шрот гранулированный
        ("Weight_PressOil",      14,  random.uniform(3_000_000, 7_000_000)),     # Масло прессовое
        ("Weight_ExtractedOil",  15,  random.uniform(3_000_000, 7_000_000)),     # Масло экстракционное
        ("Weight_ToastMeal",     16,  random.uniform(4_500_000, 9_000_000)),     # Шрот тостированный
        ("Weight_GranMeal",      17,  random.uniform(4_000_000, 8_700_000)),     # Шрот гранулированный
    ]

    # Новые температурные и давленческие теги (колебания в диапазоне)
    analog_tags = [
        ("PressTemp_1stStage",     19, random.uniform(75, 95),     75,   95),
        ("PressTemp_2ndStage",     20, random.uniform(80, 110),    80,  110),
        ("PressPressure_Main",     21, random.uniform(18, 27),     18,   27),
        ("ExtractorTemp",          22, random.uniform(52, 60),     52,   60),
        ("ExtractorPressure",      23, random.uniform(0.5, 1.2),  0.5,  1.2),
        ("DTTemp_Bottom",          24, random.uniform(96, 105),    96,  105),
        ("DTTemp_Top",             25, random.uniform(42, 55),     42,   55),
        ("MiscellaTemp",           26, random.uniform(38, 47),     38,   47),
        ("NeutralizerTemp",        27, random.uniform(85, 120),    85,  120),
        ("BleacherTemp",           28, random.uniform(80, 110),    80,  110),
        ("DeodorizerTemp",         29, random.uniform(180, 240),  180,  240),
        ("DeodorizerPressure",     30, random.uniform(2, 7),        2,    7),
    ]

    tag_vars = {}

    # Весовые — инкрементируются каждый раз
    for name, nodeid, start_val in tags_config:
        var = await obj.add_variable(idx, name, float(start_val))
        var._nodeid = f"ns=2;i={nodeid}"
        await var.set_writable()
        tag_vars[name] = {"var": var, "type": "weight"}

    # Температуры и давления — меняются плавно в диапазоне
    for name, nodeid, start_val, min_val, max_val in analog_tags:
        var = await obj.add_variable(idx, name, float(start_val))
        var._nodeid = f"ns=2;i={nodeid}"
        await var.set_writable()
        tag_vars[name] = {
            "var": var,
            "type": "analog",
            "min": min_val,
            "max": max_val
        }

    print("✅ OPC UA сервер работает на opc.tcp://localhost:4849/freeopcua/server/")
    for name, cfg in tag_vars.items():
        nodeid = cfg["var"].nodeid.Identifier
        print(f"NodeId {name}: ns=2;i={nodeid}")

    async with server:
        while True:
            for name, cfg in tag_vars.items():
                var = cfg["var"]
                old = await var.read_value()
                if cfg["type"] == "weight":
                    inc = random.uniform(180, 700)
                    await var.write_value(old + inc)
                else:
                    # Плавное колебание температуры/давления в диапазоне
                    min_val = cfg["min"]
                    max_val = cfg["max"]
                    drift = random.uniform(-1, 1)
                    # Можно сделать плавнее: если значение вышло за границы — возвращаем к середине
                    new_val = old + drift
                    if new_val < min_val:
                        new_val = min_val + abs(drift)
                    elif new_val > max_val:
                        new_val = max_val - abs(drift)
                    await var.write_value(round(new_val, 2))
            await asyncio.sleep(1)

if __name__ == "__main__":
    asyncio.run(main())
