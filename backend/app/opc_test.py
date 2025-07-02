import asyncio
from asyncua import Client, ua
from asyncua.crypto.security_policies import SecurityPolicyBasic256Sha256

endpoint_url = "opc.tcp://192.168.11.1:4840"
cert_path = r"E:\My_Business\AltaiMai\FactoryIQ\backend\app\client.der"
key_path = r"E:\My_Business\AltaiMai\FactoryIQ\backend\app\client_private.der"
#server_cert_path = r"E:\My_Business\AltaiMai\FactoryIQ\backend\app\pki\trusted\certs\PLC-PE_OPCUA.der"

mode = getattr(ua.MessageSecurityMode, "Sign")  # можно "Sign" или "SignAndEncrypt"

MAX_DEPTH = 3  # чтобы не захлебнуться — можно увеличить

async def browse_node(node, depth=0, max_depth=MAX_DEPTH):
    try:
        browse_name = await node.read_browse_name()
    except Exception:
        browse_name = "???"
    indent = "  " * depth
    print(f"{indent}- {browse_name if hasattr(browse_name, 'Name') else browse_name} [{node.nodeid}]")
    if depth >= max_depth:
        return
    try:
        children = await node.get_children()
    except Exception:
        children = []
    for child in children:
        await browse_node(child, depth+1, max_depth)

async def main():
    client = Client(endpoint_url)
    await client.set_security(
        policy=SecurityPolicyBasic256Sha256,
        certificate=cert_path,
        private_key=key_path,
        server_certificate=None, #server_cert_path,
        mode=mode,
    )
    client.set_user("adm_dmitriys")
    client.set_password("mnemic6778")

    try:
        await client.connect()
        print("✅ Успешное подключение!")
        root = client.get_node("i=85")
        print("\n== Дерево нодов (с ограничением глубины) ==\n")
        await browse_node(root)
    except Exception as e:
        print(f"❌ Ошибка подключения: {e}")
    finally:
        await client.disconnect()

if __name__ == "__main__":
    asyncio.run(main())
