from pydantic import BaseModel
from typing import Optional

class OpcServer(BaseModel):
    id: Optional[int] = None
    name: str
    endpoint_url: str
    description: Optional[str] = None

class OpcTag(BaseModel):
    id: Optional[int] = None
    server_id: int
    browse_name: str
    node_id: str
    data_type: str
    description: Optional[str] = None
    polling_interval: Optional[int] = None

class OpcData(BaseModel):
    id: Optional[int] = None
    tag_id: int
    value: float
    timestamp: str
    status: str

class User(BaseModel):
    id: int
    username: str
    email: str
    role: str

class PollingInterval(BaseModel):
    id: Optional[int] = None
    name: str
    interval_seconds: int
    type: str  # например, 'fixed' или 'change'
    description: Optional[str] = None
