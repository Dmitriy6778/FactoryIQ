from opcua import Client

endpoint = "opc.tcp://192.168.11.1:4840"

# АНОНИМНО:
# sec = "None,None,,"

# ЗАЩИТА (нужны PEM!):
cert = r"D:\FactoryIQ\backend\app\client.pem"
key  = r"D:\FactoryIQ\backend\app\client_private.pem"
sec = f"Basic256Sha256,Sign,{cert},{key}"

cl = Client(endpoint, timeout=10)
cl.set_security_string(sec)
cl.set_user("adm_dmitriys")
cl.set_password("mnemic6778")

try:
    cl.connect()
    print("OK, connected")
    print(cl.get_node("i=85"))
finally:
    cl.disconnect()
