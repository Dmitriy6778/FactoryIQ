# WSGI-обёртка для FastAPI под IIS/wfastcgi
from asgiref.wsgi import AsgiToWsgi
from app.main import app  # FastAPI() экземпляр

application = AsgiToWsgi(app)
