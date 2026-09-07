# ⚡ HyperDrop — Multi-device Peer-to-Peer File Sharing (Zero-Storage)

Share **very large files** (images, documents, videos, ISOs, anything) with **many
devices at once** at **full network speed**. Files fly **directly device-to-device**
over encrypted **WebRTC DataChannels** — the backend server **never stores, uploads,
or even sees a single byte of your files**. The server only acts as a tiny signaling
room that helps the browsers find each other.

![features](https://img.shields.io/badge/WebRTC-P2P-blue) ![storage](https://img.shields.io/badge/Zero%20Storage-green) ![backend](https://img.shields.io/badge/FastAPI-Python-682B89) ![multipeer](https://img.shields.io/badge/Multi-Device-22d3ee)

---

## ✨ Key features

- 👥 **Many devices per room** — one sender + up to 20 receivers (configurable via
  `MAX_PEERS`). Each receiver gets its own encrypted DataChannel and the sender's
  browser **fans the files out to everyone in parallel**.
- 📷 **QR join** — the sender's screen shows a QR code; any device that scans it
  opens the page **and auto-joins the room instantly**. The 6-character code and
  `?code=XXXXXX` share links still work too.
- ⚡ **AirDrop-style speed** — 128 KB Blob chunks with `ordered:false` data channels
  (no head-of-line blocking), tuned `bufferedAmount` backpressure, fast ICE candidate
  pre-fetching, and parallel per-device send loops saturating LAN / gigabit links.
- 🗑️ **Zero server storage** — no file content is ever sent to or stored on the
  backend. Rooms live in memory and vanish seconds after a transfer ends.
- 🔒 **End-to-end encryption** — WebRTC DTLS encryption between devices by default;
  your ISP / server operator sees nothing but connection handshakes.
- 📁 **Any size, any type** — images, documents, archives, 50 GB video files …
- 🖥️ **Cross-device** — phones ↔ laptop ↔ PC ↔ tablet, works on any modern browser
  (Chrome, Edge, Firefox, Safari).
- 🎨 **Advanced animated UI** — particle network background, floating glow orbs,
  glassmorphism, animated gradients, dragging drop zone, pulsing radar,
  per-device status chips, shimmering progress bar, live speedometer and a confetti finale.

---

## 🚀 Quick start

```bash
# 1. install dependencies (Python 3.9+)
pip install -r app/requirements.txt

# 2. start the server
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open **http://localhost:8000** on both devices (use your machine's LAN IP, e.g.
`http://192.168.1.10:8000`, for another device on the same network).

> ℹ️ For transfers across the internet, a public TURN server is required (STUN
> alone can fail behind symmetric NATs). You can add your own TURN credentials in
> `app/static/js/app.js` → `RTC_CONFIG.iceServers`.

---

## 🎯 How to use

1. On the **sender** device click **📤 Send Files**, drag & drop your files and hit
   **🚀 Start Secure Transfer**.
2. A **QR code** appears on screen — every other device simply **points its camera
   at the QR code** (or types the 6-character code / opens the share link) to join.
3. Each receiver auto-connects; the sender's files are streamed **simultaneously to
   every receiver** over direct encrypted channels. Watch the live speedometer,
   per-device chips and shimmering progress bar.
4. Receivers hit **💾 Download All** — done. The room is destroyed and nothing was
   ever stored on the server.

No app installs, no accounts: just a browser on every device.

---

## 🧠 How it works

```
   sender browser                          N receiver browsers
        |                                        |
        |  A) GET /api/room/new          code: XXXXXX + QR
        |  B) WS /ws/XXXXXX                  |
        |<---------- tiny JSON signaling --------->|   <- SDP offer/answer + ICE
        |                                        |
        |  == WebRTC DataChannel #1 (direct) ===>|   receiver 1
        |  == WebRTC DataChannel #2 (direct) ===>|   receiver 2
        |  == WebRTC DataChannel #3 (direct) ===>|   receiver 3
        |<=========== file chunks ===============>|   bytes NEVER hit the server
```

| Layer            | What travels there                          | File data? |
|------------------|---------------------------------------------|:----------:|
| HTTP (FastAPI)   | HTML / CSS / JS + room API + **QR (SVG)**   | ❌ No      |
| WebSocket        | SDP offers, answers & ICE candidates        | ❌ No      |
| WebRTC DataChannel | raw binary file chunks (device-to-device) | ✅ Yes     |

**Backend (`app/main.py`)** — FastAPI app that serves the UI, generates the join QR,
and runs a room-based WebSocket signaling server. One room = one sender ("host") +
up to `MAX_PEERS` devices. It assigns every device a `peerId`, broadcasts
join/leave events, routes SDP/ICE messages to the right device, and self-destructs
the room when everyone leaves. Nothing is ever written to disk.

**Frontend (`app/static/js/app.js`)** — the sender keeps one `RTCPeerConnection`
per receiver, opens an **`ordered:false`** DataChannel on each, slices files into
128 KB Blob frames (`[uint32 index][payload]`) and streams them to *all* receivers
in parallel with `bufferedAmount` backpressure; each receiver re-assembles the
out-of-order chunks into `Blob` downloads.

---

## 📁 Project structure

```
app/
├── main.py              # FastAPI app + multi-peer WebSocket signaling + QR (SVG)
├── requirements.txt     # fastapi, uvicorn[standard], jinja2, qrcode
├── static/
│   ├── css/style.css    # animated theme (particles, orbs, glass, peer chips, confetti)
│   └── js/app.js        # WebRTC client, parallel multi-sender/receiver, QR join
└── templates/
    └── index.html       # single-page UI (send / receive / transfer screens)
```

---

## ⚠️ Notes

- Both devices must keep their pages open for the whole transfer.
- The browser buffers incoming files in memory — avoid a >4–8 GB single transfer on
  low-RAM devices.
- For LAN use, connect via the host's LAN IP and firewall-allowed port 8000.
- The signaling server is stateless and keeps **nothing** after a room closes. 
