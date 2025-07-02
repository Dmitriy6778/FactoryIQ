from pydantic import BaseModel

class OpcServer(BaseModel):
    id: int
    name: str
    endpoint_url: str
    description: str | None = None

class OpcTag(BaseModel):
    id: int
    server_id: int
    browse_name: str
    node_id: str
    data_type: str
    description: str | None = None

class OpcData(BaseModel):
    id: int
    tag_id: int
    value: float
    timestamp: str
    status: str

class User(BaseModel):
    id: int
    username: str
    email: str
    role: str
