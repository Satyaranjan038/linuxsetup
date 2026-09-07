"""
HyperDrop - Peer-to-Peer File Sharing (multi-device)
====================================================
FastAPI backend that ONLY serves the web app and acts as a lightweight
WebSocket *signaling* server.

How it works
------------
* File data NEVER touches this server. It flows directly between the
  sender's browser and every receiver over encrypted WebRTC DataChannels.
* The server just helps the peers find each other by relaying small JSON
  handshake messages (SDP offer / answer + ICE candidates) and routing
  them to the right device.
* One room = one sender ("host") + up to MAX_PEERS-1 receivers. A receiver
  joins by typing the 6-char code or by scanning the room's QR code, which
  encodes a URL like  https://host/?code=XXXXXX  and auto-joins.
* Rooms live in memory only and are removed automatically when empty.
  Nothing is ever written to disk and no file content is stored.

Run
---
    uvicorn app.main:app --host 0.0.0.0 --port 8000

Optional env vars
-----------------
    MAX_PEERS          max devices per room            (default 20)
    ROOM_TTL_SECONDS   empty room lifetime in seconds  (default 1800)
    PUBLIC_BASE_URL    public origin used for QR links when the app is
                       served behind a proxy or under a different domain,
                       e.g. https://drop.example.com
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
import socket
import time
import uuid
from pathlib import Path
from typing import Dict, List

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import uvicorn

# Pure-Python QR generator (SVG output => no Pillow / image dependencies).
import qrcode
from qrcode import constants
from qrcode.image.svg import SvgPathImage

BASE_DIR = Path(__file__).resolve().parent

# How long an empty room lingers before the background sweeper removes it.
ROOM_TTL_SECONDS = int(os.getenv("ROOM_TTL_SECONDS", "1800"))
# Maximum number of devices that may share one room (1 sender + receivers).
MAX_PEERS = int(os.getenv("MAX_PEERS", "20"))
# Optional public origin used when building QR join links.
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")


# ---------------------------------------------------------------
# In-memory signaling room registry
# ---------------------------------------------------------------
class Peer:
    """One connected browser inside a room (one per WebSocket)."""

    __slots__ = ("ws", "peer_id", "joined_at")

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.peer_id = uuid.uuid4().hex[:12]
        self.joined_at = time.time()


class Room:
    """A single share session: one host + up to MAX_PEERS-1 receivers."""

    def __init__(self, code: str) -> None:
        self.code = code
        self.peers: List[Peer] = []
        self.host_id: str | None = None
        self.created_at: float = time.time()


ROOMS: Dict[str, Room] = {}


def _generate_code(length: int = 6) -> str:
    """Generate a human-friendly room code (no confusing chars)."""
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(length))
        if code not in ROOMS:
            return code


async def _sweep_stale_rooms() -> None:
    """Background task - clean up empty rooms nobody ever joined."""
    while True:
        await asyncio.sleep(60)
        now = time.time()
        for code in list(ROOMS):
            room = ROOMS[code]
            if not room.peers and now - room.created_at > ROOM_TTL_SECONDS:
                ROOMS.pop(code, None)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_sweep_stale_rooms())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(
    title="HyperDrop - P2P File Sharing",
    description="Zero-storage, multi-device peer-to-peer file sharing via WebRTC",
    version="3.0.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------
# Static assets + templates
# ---------------------------------------------------------------
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


# ---------------------------------------------------------------
# Web pages
# ---------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    # New Starlette signature: (request, template_name, context)
    return templates.TemplateResponse(
        request,
        "index.html",
        {"app_name": "HyperDrop"},
    )


# ---------------------------------------------------------------
# Room API (used by the frontend to create / probe rooms)
# ---------------------------------------------------------------
def _get_lan_ip() -> str:
    """Best-effort LAN IPv4 address of this machine (for QR join links)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "127.0.0.1"
    finally:
        s.close()


def _join_base(request: Request) -> str:
    """Base URL a phone on the same network can actually reach.
    Never 'localhost' — that would point the scanning device at itself.
    Inside Docker, _get_lan_ip() returns the unreachable container IP
    (e.g. 172.17.0.2), so prefer the Host the sender's browser used —
    that address is reachable by every device on the same network."""
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    host = (request.headers.get("host") or "").strip()
    if host:
        hostname = host.split(":")[0].strip("[]")
        if hostname not in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
            return f"http://{host}"
    return f"http://{_get_lan_ip()}:8000"


@app.get("/api/room/new")
async def new_room(request: Request):
    """Create a fresh room (sender side). No data is stored."""
    room = Room(_generate_code())
    ROOMS[room.code] = room
    base = _join_base(request)
    return {
        "room": room.code,
        "peers": 0,
        "max": MAX_PEERS,
        "join_url": f"{base}/?code={room.code}",
    }


@app.get("/api/room/{code}")
async def room_exists(code: str):
    code = code.strip().upper()
    room = ROOMS.get(code)
    if room is None:
        return {"exists": False, "peers": 0, "max": MAX_PEERS}
    return {
        "exists": True,
        "peers": len(room.peers),
        "max": MAX_PEERS,
        "hostId": room.host_id,
    }


@app.get("/api/room/{code}/qr")
async def room_qr(code: str, request: Request):
    """Return an SVG QR code that opens the app and auto-joins the room."""
    room = ROOMS.get(code.strip().upper())
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    base = PUBLIC_BASE_URL or _join_base(request)
    url = f"{base}/?code={room.code}"
    qr = qrcode.QRCode(
        version=None,
        error_correction=constants.ERROR_CORRECT_H,
        box_size=8,
        border=2,
    )
    qr.add_data(url)
    qr.make(fit=True)
    svg = qr.make_image(image_factory=SvgPathImage)
    return Response(content=svg.to_string(), media_type="image/svg+xml")


# ---------------------------------------------------------------
# WebSocket signaling endpoint.
# Only tiny JSON handshake blobs (offer / answer / ice) pass through.
# Messages may carry "to": <peerId> to reach a single device, otherwise
# they are broadcast to everyone else in the room.
# ---------------------------------------------------------------
@app.websocket("/ws/{code}")
async def signaling(websocket: WebSocket, code: str):
    code = code.strip().upper()
    if code not in ROOMS:
        ROOMS[code] = Room(code)
    room = ROOMS[code]

    if len(room.peers) >= MAX_PEERS:
        await websocket.close(code=4001, reason="room full")
        return

    await websocket.accept()
    peer = Peer(websocket)
    room.peers.append(peer)

    # The very first device to connect is the sender / host.
    if room.host_id is None:
        room.host_id = peer.peer_id

    # Welcome: our id, the host id and who else is already here.
    await websocket.send_json(
        {
            "type": "welcome",
            "peerId": peer.peer_id,
            "hostId": room.host_id,
            "peers": [p.peer_id for p in room.peers if p.peer_id != peer.peer_id],
            "max": MAX_PEERS,
        }
    )

    # Tell everyone who was already here that a new device just joined.
    for other in room.peers:
        if other.peer_id != peer.peer_id:
            with contextlib.suppress(Exception):
                await other.ws.send_json({"type": "peer-joined", "peerId": peer.peer_id})

    try:
        while True:
            msg = await websocket.receive_text()
            try:
                data = json.loads(msg)
            except ValueError:
                continue
            if data.get("type") == "ping":
                # Client keepalive - never broadcast it to the room.
                continue
            target = data.get("to")
            for other in room.peers:
                if other.peer_id == peer.peer_id:
                    continue
                if target and other.peer_id != target:
                    continue
                with contextlib.suppress(Exception):
                    await other.ws.send_text(msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if peer in room.peers:
            room.peers.remove(peer)

        if room.host_id == peer.peer_id:
            # The sender left - the session is over for everyone inside.
            leftovers = list(room.peers)
            room.peers.clear()
            ROOMS.pop(code, None)
            for other in leftovers:
                with contextlib.suppress(Exception):
                    await other.ws.send_json({"type": "room-closed", "reason": "host-left"})
                with contextlib.suppress(Exception):
                    await other.ws.close(code=4002, reason="host-left")
        else:
            # A receiver left - tell the rest so the host can drop that channel.
            for other in room.peers:
                with contextlib.suppress(Exception):
                    await other.ws.send_json({"type": "peer-left", "peerId": peer.peer_id})
            if not room.peers:
                ROOMS.pop(code, None)


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        reload=False,
    )