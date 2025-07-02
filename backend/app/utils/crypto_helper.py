# app/utils/crypto_helper.py
import os
from cryptography.fernet import Fernet

FERNET_KEY = os.getenv("FERNET_KEY")

if not FERNET_KEY:
    raise RuntimeError("FERNET_KEY not set in environment variables")

fernet = Fernet(FERNET_KEY)

def encrypt_password(password: str) -> str:
    return fernet.encrypt(password.encode()).decode()

def decrypt_password(token: str) -> str:
    return fernet.decrypt(token.encode()).decode()
