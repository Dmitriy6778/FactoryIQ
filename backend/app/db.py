import pyodbc
from .config import get_conn_str

def get_db_connection():
    return pyodbc.connect(get_conn_str())
