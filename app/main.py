
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import uvicorn


# --------------------------------------------------
# Base directory
# --------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent


# --------------------------------------------------
# FastAPI application
# --------------------------------------------------
app = FastAPI(
    title="My FastAPI Application",
    description="Test FastAPI application running on Acer Ubuntu",
    version="1.0.0",
)


# --------------------------------------------------
# Static files
# --------------------------------------------------
STATIC_DIR = BASE_DIR / "static"

if STATIC_DIR.exists():
    app.mount(
        "/static",
        StaticFiles(directory=STATIC_DIR),
        name="static",
    )


# --------------------------------------------------
# HTML templates
# --------------------------------------------------
TEMPLATES_DIR = BASE_DIR / "templates"

templates = Jinja2Templates(
    directory=TEMPLATES_DIR
)


# --------------------------------------------------
# Web page
# --------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "app_name": "My FastAPI Application",
            "version": "1.0.0",
        },
    )


# --------------------------------------------------
# API: Hello
# --------------------------------------------------
@app.get("/api/hello")
async def hello():
    return {
        "message": "Hello from FastAPI!",
        "server": "Acer Ubuntu",
    }


# --------------------------------------------------
# API: Status
# --------------------------------------------------
@app.get("/api/status")
async def status():
    return {
        "status": "running",
        "application": "FastAPI",
        "version": "1.0.0",
        "server": "Acer Ubuntu",
    }


# --------------------------------------------------
# API: Health check
# --------------------------------------------------
@app.get("/api/health")
async def health():
    return {
        "status": "UP",
        "message": "FastAPI server is healthy",
    }


# --------------------------------------------------
# API: Server information
# --------------------------------------------------
@app.get("/api/info")
async def info():
    return {
        "application": "My FastAPI Application",
        "framework": "FastAPI",
        "version": "1.0.0",
        "server": "Acer Ubuntu",
        "environment": "test",
    }

if __name__ == "__main__": uvicorn.run( "main:app", host="0.0.0.0", port=8000, reload=True, )