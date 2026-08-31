from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI(
    title="My FastAPI Application",
    version="1.0.0"
)

# Static files: CSS and JavaScript
app.mount(
    "/static",
    StaticFiles(directory="app/static"),
    name="static"
)

# HTML templates
templates = Jinja2Templates(
    directory="app/templates"
)


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request}
    )


@app.get("/api/hello")
async def hello():
    return {
        "message": "Hello from FastAPI!",
        "server": "Acer Ubuntu"
    }


@app.get("/api/status")
async def status():
    return {
        "status": "running",
        "application": "FastAPI",
        "version": "1.0.0"
    }