/* ============================================================
   HyperDrop - business edition
   Transfer engine (simple + bulletproof):
     * ONE ordered, reliable WebRTC DataChannel per receiver
     * 64 KB chunks, 8-byte header: [chunk index][file id]
     * polled backpressure: never queue more than 1 MB
     * a file is finalized only when ALL bytes arrived
   ============================================================ */
"use strict";

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatBytes(bytes) {
    if (bytes == undefined || bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, i);
    return (val >= 100 ? Math.round(val) : val.toFixed(val < 10 && i > 0 ? 1 : 0)) + " " + units[i];
}

function formatSpeed(bytesPerSec) {
    if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(2) + " MB/s";
    if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + " KB/s";
    return bytesPerSec.toFixed(0) + " B/s";
}

let toastTimer = null;
function toast(msg, type = "info", ms = 3000) {
    const el = $("toast");
    el.className = "toast " + type;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/* ---------------- activity log ---------------- */
function logBot(text) {
    const box = $("bot-log");
    if (!box) return;
    const line = document.createElement("div");
    line.className = "bot-line";
    const t = new Date().toLocaleTimeString([], { hour12: false });
    line.innerHTML = '<span class="bot-time">' + t + '</span><span class="bot-text"></span>';
    line.querySelector(".bot-text").textContent = text;
    box.appendChild(line);
    while (box.children.length > 100) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
}

/* ---------------- screen router ---------------- */
function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
    window.scrollTo(0, 0);
}

/* ---------------- app state ---------------- */
const state = {
    role: null,
    files: [],
    roomCode: null,
    ws: null,
    peerId: null,
    hostId: null,
    isHost: false,
    peers: new Map(),
    cancelled: false,
    sending: false,
    finished: false,
    transferShown: false,
    totalSize: 0,
    filesMap: new Map(),
    fidMap: new Map(),
    orphanChunks: new Map(),
    receivedFiles: [],
    recvExpected: 0,
    recvBytes: 0,
    pendingEndIds: new Set(),  /* end seen before its meta (reordered delivery) */
    speed: 0,
    segBytes: 0,
    segStart: performance.now(),
    probeDone: false,     /* max-link-speed probe finished */
    pendingStart: false,  /* transfer waiting for the probe to finish */
    pingTimer: null,      /* signaling keepalive interval */
};

/* ---------------- protocol constants ---------------- */
const RTC_CONFIG = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
    ],
    bundlePolicy: "max-bundle",
};

/* One ordered + reliable channel: nothing can be lost or reordered.
   256 KB chunks (max supported by every modern browser) with an event-driven
   backpressure window of 8 MB keep gigabit / 5 GHz Wi-Fi links saturated. */
const DC_OPTIONS = { ordered: true };
const CHUNK_SIZE = 256 * 1024;
const MAX_QUEUE = 8 * 1024 * 1024;
const POLL_MS = 2;

/* ---------------- file selection ---------------- */
const dropZone = $("drop-zone");
const fileInput = $("file-input");

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => addFiles([...fileInput.files]));

["dragenter", "dragover"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); })
);
dropZone.addEventListener("drop", (e) => {
    const files = [...e.dataTransfer.files];
    if (files.length) addFiles(files);
});

function addFiles(list) {
    for (const f of list) {
        if (!state.files.some((x) => x.name === f.name && x.size === f.size)) {
            state.files.push(f);
        }
    }
    state.totalSize = state.files.reduce((s, f) => s + f.size, 0);
    renderFileList();
    toast(`${list.length} file(s) ready`, "info");
}

function fileIcon(name) {
    const ext = name.split(".").pop().toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "IMG";
    if (["mp4", "mkv", "mov", "avi", "webm"].includes(ext)) return "VID";
    if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) return "AUD";
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "ZIP";
    if (ext === "pdf") return "PDF";
    return "FILE";
}

function renderFileList() {
    const list = $("file-list");
    list.innerHTML = "";
    state.files.forEach((f, i) => {
        const row = document.createElement("div");
        row.className = "file-row";

        const tag = document.createElement("span");
        tag.className = "file-tag";
        tag.textContent = fileIcon(f.name);

        const meta = document.createElement("div");
        meta.className = "file-meta";
        const name = document.createElement("div");
        name.className = "file-name";
        name.textContent = f.name;
        const size = document.createElement("div");
        size.className = "file-size";
        size.textContent = formatBytes(f.size);
        meta.append(name, size);

        const remove = document.createElement("button");
        remove.className = "file-remove";
        remove.textContent = "Remove";
        if (!state.peers.size) {
            remove.addEventListener("click", () => {
                state.files.splice(i, 1);
                state.totalSize = state.files.reduce((s, x) => s + x.size, 0);
                renderFileList();
            });
        } else {
            remove.disabled = true;
        }

        row.append(tag, meta, remove);
        list.appendChild(row);
    });
}

/* ---------------- signaling ---------------- */
function wsUrl(code) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws/${code}`;
}

function sendSignal(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        obj.from = state.peerId;
        state.ws.send(JSON.stringify(obj));
    }
}

function shortId(id) {
    return (id || "????").slice(0, 4).toUpperCase();
}

function ensurePeer(pid) {
    if (!state.peers.has(pid)) {
        state.peers.set(pid, {
            id: pid,
            pc: null,
            dc: null,
            connecting: false,
            connected: false,
            sending: false,
            done: false,
            sent: 0,
            total: 0,
            nextFid: 0,
        });
        renderFileList();
    }
    return state.peers.get(pid);
}

async function createRoom() {
    try {
        const res = await fetch("/api/room/new");
        const data = await res.json();
        if (!data.room) throw new Error("no room");
        state.role = "sender";
        state.roomCode = data.room;
        $("room-code").textContent = data.room;
        $("qr-img").src = `/api/room/${data.room}/qr`;
        $("qr-img").hidden = false;
        if (data.join_url) {
            $("join-link").textContent = data.join_url;
            $("join-link").hidden = false;
        }
        $("room-banner").hidden = false;
        $("btn-start").disabled = true;
        $("btn-start").textContent = "Waiting for receivers...";
        connectSocket(data.room);
        logBot("Searching for receivers... Share the code, link, or QR code.");
        logBot(data.join_url ? ("Receiver must open: " + data.join_url) : "Share the room code.");
    } catch (err) {
        toast("Could not reach the signaling server", "error");
    }
}

async function joinRoom() {
    const code = ($("join-code").value || "").trim().toUpperCase().replace(/\s/g, "");
    if (code.length < 4) {
        toast("Please enter the full 6-character code", "error");
        return;
    }
    try {
        const res = await (await fetch(`/api/room/${code}`)).json();
        if (!res.exists) {
            toast("Room not found. Ask the sender to wait on the share screen.", "error");
            return;
        }
        if (res.peers >= res.max) {
            toast("This room is already full", "error");
            return;
        }
        state.role = "receiver";
        state.roomCode = code;
        showTransferScreen("Searching for sender...");
        $("btn-cancel").hidden = false;
        logBot("Searching for sender in room " + code + "...");
        connectSocket(code);
    } catch (err) {
        toast("Could not reach the signaling server", "error");
    }
}

function connectSocket(code) {
    state.ws = new WebSocket(wsUrl(code));

    state.ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        handleSignal(msg);
    };

    state.ws.onclose = () => {
        if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
        if (state.cancelled || state.finished) return;
        /* If a transfer is already in flight, the direct WebRTC channel does
           not need signaling anymore - NEVER kill it because the signaling
           socket dropped. Just warn and keep the transfer running. */
        const busy = state.sending || state.recvExpected > 0 || state.filesMap.size > 0;
        if (busy) {
            toast("Signaling lost - transfer continues on the direct connection", "info", 5000);
            logBot("Signaling connection dropped. The direct file transfer is NOT affected and continues.");
            return;
        }
        if (state.role === "receiver") {
            toast("Disconnected from the signaling server", "error");
            resetTransfer();
        }
    };
    state.ws.onerror = () => {
        const busy = state.sending || state.recvExpected > 0 || state.filesMap.size > 0;
        if (!busy) toast("Signal connection error", "error");
    };

    /* Keepalive: the signaling socket is IDLE during the whole transfer
       (file data goes device-to-device). Idle WebSockets are dropped by
       docker-proxy / NAT gateways, and the server then wrongly declares
       the sender gone. A tiny ping every 20 s keeps it alive. */
    if (state.pingTimer) clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            try { state.ws.send(JSON.stringify({ type: "ping" })); } catch (_) {}
        }
    }, 20000);
}

function handleSignal(msg) {
    switch (msg.type) {
        case "welcome": onWelcome(msg); break;
        case "peer-joined": onPeerJoined(msg.peerId); break;
        case "peer-left": onPeerLeft(msg.peerId); break;
        case "room-closed": onRoomClosed(); break;
        case "offer": onOffer(msg); break;
        case "answer": onAnswer(msg); break;
        case "ice": onIce(msg); break;
    }
}

function onWelcome(msg) {
    state.peerId = msg.peerId;
    state.hostId = msg.hostId;
    state.isHost = msg.peerId === msg.hostId;
    if (state.isHost) {
        state.role = "sender";
        for (const pid of msg.peers) {
            if (pid !== state.peerId) connectToPeer(pid);
        }
    } else {
        state.role = "receiver";
        if (msg.peers.length) {
            showTransferScreen("Sender found - connecting...");
            logBot("Sender found. Negotiating encrypted connection...");
        } else {
            showTransferScreen("Searching for sender...");
            logBot("Joined room. Searching for sender... waiting for the sender's device.");
        }
        $("btn-cancel").hidden = false;
    }
}

function onPeerJoined(pid) {
    ensurePeer(pid);
    updatePeerChips();
    if (state.isHost && pid !== state.peerId) connectToPeer(pid);
}

function onPeerLeft(pid) {
    const peer = state.peers.get(pid);
    if (peer) {
        try { if (peer.dc) peer.dc.close(); } catch (_) { /* noop */ }
        try { if (peer.pc) peer.pc.close(); } catch (_) { /* noop */ }
        state.peers.delete(pid);
    }
    if (state.role === "receiver" && pid === state.hostId && !state.finished) {
        const busy = state.recvExpected > 0 || state.filesMap.size > 0;
        if (busy) {
            /* Sender's signaling socket dropped, but the data channel may
               still be alive - never kill an in-flight transfer for this. */
            toast("Sender signaling lost - transfer continues", "info", 5000);
            return;
        }
        toast("The sender disconnected", "error");
        resetTransfer();
        return;
    }
    updatePeerChips();
    if (state.isHost) logBot(`Device ${shortId(pid)} left the room.`);
}

function onRoomClosed() {
    /* Signaling drops can look like "room closed" mid-transfer. If data is
       still flowing, do NOT reset - the direct channel doesn't need the room. */
    if (state.finished) {
        $("transfer-title").textContent = "Transfer complete";
        $("btn-download").hidden = false;
        toast("Session ended - your files are ready to download", "info", 5000);
        return;
    }
    const busy = state.sending || state.recvExpected > 0 || state.filesMap.size > 0;
    if (busy) {
        toast("Session closed by server - transfer continues on the direct connection", "info", 5000);
        logBot("Signaling room closed. The direct file transfer is NOT affected and continues.");
        return;
    }
    toast("The sender closed this session", "error");
    resetTransfer();
}

/* ---------------- WebRTC ---------------- */
function connectToPeer(pid) {
    const peer = ensurePeer(pid);
    if (peer.pc || peer.connecting) return;
    peer.connecting = true;
    const pc = makePeer(pid);
    peer.pc = pc;
    const dc = pc.createDataChannel("hyperdrop", DC_OPTIONS);
    peer.dc = dc;
    wireDataChannel(dc, pid);
    pc.createOffer().then((offer) => {
        pc.setLocalDescription(offer);
        sendSignal({ type: "offer", sdp: offer, to: pid });
    }).catch((err) => console.error("offer error", err));
}

function makePeer(forPeerId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal({ type: "ice", candidate: e.candidate, to: forPeerId });
    };
    pc.ondatachannel = (e) => {
        const peer = ensurePeer(forPeerId);
        if (e.channel.label === "probe") { wireProbe(e.channel, peer); return; }
        peer.dc = e.channel;
        wireDataChannel(e.channel, forPeerId);
    };
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
            const peer = state.peers.get(forPeerId);
            if (peer) peer.connecting = false;
            onConnected();
            logRoute(pc);
        }
        if (pc.connectionState === "failed") {
            const peer = state.peers.get(forPeerId);
            if (peer) peer.connecting = false;
            if (!state.cancelled) {
                toast(`Could not reach device ${shortId(forPeerId)}`, "error");
                logBot(`ERROR: could not reach device ${shortId(forPeerId)}. Both devices must be on the same network.`);
            }
        }
    };
    /* Host creates a side "probe" channel used to measure the raw max link
       speed before the transfer starts (receiver gets it via ondatachannel). */
    if (state.isHost) {
        const probe = pc.createDataChannel("probe", { ordered: false });
        probe.binaryType = "arraybuffer";
        probe.onopen = () => runProbe(probe);
    }
    return pc;
}

/* ---------------- link speed probe + route info ---------------- */
const PROBE_BYTES = 8 * 1024 * 1024; /* 8 MB burst to measure the link */

/* Host side: blast 8 MB as fast as SCTP accepts it. */
async function runProbe(dc) {
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    try {
        while (sent < PROBE_BYTES && dc.readyState === "open" && !state.cancelled) {
            if (dc.bufferedAmount > 4 * 1024 * 1024) { await sleep(1); continue; }
            dc.send(chunk);
            sent += chunk.length;
        }
    } catch (_) { /* channel closed early - measurement just ends short */ }
}

/* Receiver side: count arriving probe bytes for 1 second-equivalent, then
   report the measured raw link speed back to the sender. */
function wireProbe(dc, peer) {
    dc.binaryType = "arraybuffer";
    let received = 0;
    let t0 = 0;
    dc.onopen = () => { t0 = performance.now(); };
    const finish = () => {
        if (finish.done || !t0) return;
        finish.done = true;
        const secs = Math.max(0.001, (performance.now() - t0) / 1000);
        const mbs = received / secs / 1048576;
        const mbps = (received * 8) / secs / 1e6;
        logBot(`MAX LINK SPEED: ${mbs.toFixed(1)} MB/s (${mbps.toFixed(0)} Mbps).`);
        $("connection-tag").textContent = `Max ~${mbs.toFixed(1)} MB/s`;
        if (mbs < 5) logBot("Tip: speeds under ~6 MB/s usually mean 2.4 GHz Wi-Fi. Switch both devices to 5 GHz Wi-Fi.");
        const send = () => {
            try { peer.dc.send(JSON.stringify({ type: "probe-result", mbs, mbps })); } catch (_) {}
        };
        if (peer.dc && peer.dc.readyState === "open") send();
        else {
            const waiter = setInterval(() => {
                if (peer.dc && peer.dc.readyState === "open") { clearInterval(waiter); send(); }
            }, 50);
            setTimeout(() => clearInterval(waiter), 8000);
        }
    };
    dc.onmessage = (e) => {
        received += e.data.byteLength || e.data.size || 0;
        if (received >= PROBE_BYTES) finish();
    };
    setTimeout(finish, 5000); /* safety stop on slow links */
}

/* Read ICE stats after connect: tells us LAN vs internet and, when both
   devices report a Wi-Fi interface, the Wi-Fi link's nominal rate. */
async function logRoute(pc) {
    try {
        const stats = await pc.getStats();
        const cands = {};
        stats.forEach((r) => {
            if (r.type === "local-candidate" || r.type === "remote-candidate") cands[r.id] = r;
        });
        stats.forEach((r) => {
            if (r.type !== "candidate-pair") return;
            if (!(r.selected || r.nominated) || r.state !== "succeeded") return;
            const l = cands[r.localCandidateId], rem = cands[r.remoteCandidateId];
            if (!l || !rem) return;
            const lan = l.candidateType === "host" && rem.candidateType === "host";
            logBot(lan
                ? "Route: direct LOCAL NETWORK (host-to-host). No mobile data is used for the transfer."
                : `Route: via internet (${l.candidateType}/${rem.candidateType}). This transfer WILL use your data pack on both sides.`);
        });
    } catch (_) { /* stats are best-effort */ }
}

/* Read one framed chunk: [uint32 index][uint32 fid][payload]. */
async function readChunk(file, index, fid) {
    const start = index * CHUNK_SIZE;
    const slice = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
    const payload = await slice.arrayBuffer();
    const buf = new Uint8Array(8 + payload.byteLength);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, index, true);
    dv.setUint32(4, fid, true);
    buf.set(new Uint8Array(payload), 8);
    return buf.buffer;
}

async function onOffer(msg) {
    const pid = msg.from;
    const peer = ensurePeer(pid);
    if (!peer.pc) peer.pc = makePeer(pid);
    try {
        await peer.pc.setRemoteDescription(msg.sdp);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        sendSignal({ type: "answer", sdp: answer, to: pid });
    } catch (err) { console.error("offer error", err); }
}

async function onAnswer(msg) {
    const peer = state.peers.get(msg.from);
    if (!peer || !peer.pc) return;
    try { await peer.pc.setRemoteDescription(msg.sdp); }
    catch (err) { console.error("answer error", err); }
}

async function onIce(msg) {
    const peer = state.peers.get(msg.from);
    if (!peer || !peer.pc || !msg.candidate) return;
    try { await peer.pc.addIceCandidate(msg.candidate); } catch (_) { /* races are fine */ }
}

/* ---------------- data channel ---------------- */
function wireDataChannel(dc, pid) {
    const peer = ensurePeer(pid);
    dc.binaryType = "arraybuffer";

    dc.onopen = () => {
        peer.connected = true;
        peer.connecting = false;
        updatePeerChips();
        logBot(state.isHost
            ? `Connected to device ${shortId(pid)}. Starting transfer.`
            : "Connected to sender. Waiting for files...");
        if (state.isHost) {
            if (!state.transferShown) {
                showTransferScreen("Sending files...");
                $("btn-cancel").hidden = false;
            }
            /* Wait for the max-link-speed probe so the measurement is clean. */
            if (!state.probeDone && !state.sending) {
                state.pendingStart = true;
                logBot("Measuring maximum link speed first...");
                setTimeout(() => {
                    if (!state.probeDone) {   /* fallback: never block the transfer */
                        state.probeDone = true;
                        if (state.pendingStart && state.files.length && !state.sending) {
                            state.pendingStart = false;
                            startSendingAll();
                        }
                    }
                }, 7000);
            }
            else if (state.files.length && !state.sending) startSendingAll();
            else if (state.sending) sendToPeer(peer, state.files);
        } else {
            if (!state.transferShown) {
                showTransferScreen("Receiving files...");
                $("btn-cancel").hidden = false;
            }
            onConnected();
        }
    };

    dc.onclose = () => {
        peer.connected = false;
        if (state.isHost && !peer.done && !state.cancelled) {
            logBot(`WARNING: device ${shortId(pid)} disconnected mid-transfer.`);
            toast(`Device ${shortId(pid)} disconnected mid-transfer`, "error");
        }
        updatePeerChips();
    };

    dc.onerror = () => { /* surfaced via pc.onconnectionstatechange */ };

    dc.onmessage = (e) => {
        if (typeof e.data === "string") {
            try { receiveControl(JSON.parse(e.data)); } catch (_) { /* ignore */ }
        } else {
            receiveChunk(e.data);
        }
    };
}

/* ---------------- transfer screen ---------------- */
function showTransferScreen(title) {
    state.transferShown = true;
    showScreen("screen-transfer");
    $("transfer-title").textContent = title;
}

function onConnected() {
    $("conn-orb").classList.add("connected");
    $("transfer-title").textContent = state.role === "sender" ? "Sending" : "Receiving";
    $("connection-tag").textContent = "Encrypted direct connection";
}

/* ---------------- peer chips ---------------- */
function updatePeerChips() {
    const peers = [...state.peers.values()];
    const sendStrip = $("send-peer-strip");
    if (sendStrip) {
        sendStrip.innerHTML = "";
        const count = peers.filter((p) => p.connected).length;
        const chip = document.createElement("span");
        chip.className = "peer-chip " + (count ? "ok" : "wait");
        chip.textContent = count ? `${count} device(s) connected` : "Waiting for receivers to join";
        sendStrip.appendChild(chip);
    }

    const strip = $("peers-strip");
    if (!strip) return;
    strip.innerHTML = "";
    const connected = peers.filter((p) => p.connected);
    if (!connected.length) {
        const chip = document.createElement("span");
        chip.className = "peer-chip wait";
        chip.textContent = state.isHost ? "Waiting for a receiver" : "Connecting to sender";
        strip.appendChild(chip);
        return;
    }
    connected.forEach((p) => {
        const chip = document.createElement("span");
        chip.className = "peer-chip " + (p.done ? "ok" : "live");
        chip.textContent = `${p.done ? "Done" : "Transferring"} - ${shortId(p.id)}`;
        strip.appendChild(chip);
    });
}

/* ---------------- progress + speed ---------------- */
function updateThroughput(add) {
    state.segBytes += add;
    const now = performance.now();
    if (now - state.segStart >= 500) {
        const dt = (now - state.segStart) / 1000;
        state.speed = state.segBytes / dt;
        state.segBytes = 0;
        state.segStart = now;
        const [val, unit] = formatSpeed(state.speed).split(" ");
        $("speed-num").textContent = val;
        $("speed-unit").textContent = unit;
    }
}

function reportProgress(frac) {
    const pct = Math.min(100, Math.max(0, Math.round(frac * 100)));
    $("progress-fill").style.width = pct + "%";
    $("progress-pct").textContent = pct + "%";
}

function updateSenderProgress() {
    let sent = 0, total = 0;
    for (const p of state.peers.values()) {
        if (p.total > 0) { sent += p.sent; total += p.total; }
    }
    reportProgress(total ? sent / total : 0);
    $("progress-size").textContent = `${formatBytes(sent)} / ${formatBytes(total)}`;
}

/* ---------------- sender ---------------- */
function startSendingAll() {
    state.sending = true;
    $("btn-cancel").hidden = false;
    logBot(`Transfer started: ${state.files.length} file(s), ${formatBytes(state.totalSize)} total.`);
    for (const p of state.peers.values()) {
        if (p.connected) sendToPeer(p, state.files);
    }
}

function sendToPeer(peer, files) {
    if (peer.sending || peer.done || !peer.dc || peer.dc.readyState !== "open") return;
    peer.sending = true;
    peer.total = files.reduce((s, f) => s + f.size, 0);
    updatePeerChips();
    (async () => {
        for (let i = 0; i < files.length; i++) {
            if (state.cancelled) break;
            await sendOneFile(files[i], peer, i, files.length);
        }
        peer.sending = false;
        peer.done = true;
        updatePeerChips();
        checkSenderDone();
    })();
}

/* Wait until the send queue is below MAX_QUEUE. Primary signal is the
   `bufferedamountlow` event (zero CPU while waiting); a short poll is kept
   as a bulletproof fallback for browsers without reliable event firing. */
function waitDrain(dc) {
    return new Promise((resolve) => {
        if (state.cancelled || dc.readyState !== "open" || dc.bufferedAmount <= MAX_QUEUE) {
            resolve();
            return;
        }
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            dc.removeEventListener("bufferedamountlow", finish);
            clearInterval(timer);
            resolve();
        };
        dc.bufferedAmountLowThreshold = MAX_QUEUE / 2;
        dc.addEventListener("bufferedamountlow", finish);
        const timer = setInterval(() => {
            if (dc.readyState !== "open" || dc.bufferedAmount <= MAX_QUEUE) finish();
        }, POLL_MS);
    });
}

async function sendOneFile(file, peer, fileIndex, fileCount) {
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const fid = ++peer.nextFid;
    logBot(`Sending file ${fileIndex + 1}/${fileCount}: "${file.name}" (${formatBytes(file.size)})`);
    peer.dc.send(JSON.stringify({ type: "meta", id, fid, name: file.name, size: file.size, mime: file.type }));

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let lastPct = 0;

    /* Pipelined: the next chunk is read from disk WHILE the current one is
       in flight, so the network is never idle waiting for the file system. */
    let buf = await readChunk(file, 0, fid);
    for (let index = 0; index < totalChunks; index++) {
        if (state.cancelled) return;
        await waitDrain(peer.dc);
        if (state.cancelled || peer.dc.readyState !== "open") return;

        const nextPromise = index + 1 < totalChunks ? readChunk(file, index + 1, fid) : null;
        peer.dc.send(buf);

        peer.sent += buf.byteLength - 8;
        updateThroughput(buf.byteLength - 8);
        updateSenderProgress();
        if (nextPromise) buf = await nextPromise;

        const pct = Math.floor(((index + 1) / totalChunks) * 100);
        if (pct - lastPct >= 25) {
            lastPct = pct;
            logBot(`"${file.name}": ${pct}% sent (${formatSpeed(state.speed)})`);
        }
    }

    if (!state.cancelled && peer.dc.readyState === "open") {
        peer.dc.send(JSON.stringify({ type: "end", id }));
        logBot(`File "${file.name}" delivered to ${shortId(peer.id)}.`);
    }
}

function checkSenderDone() {
    if (state.cancelled || !state.sending || state.finished) return;
    const active = [...state.peers.values()].filter((p) => p.connected && p.total > 0);
    if (active.length && active.every((p) => p.done)) finishAsSender();
}

/* ---------------- receiver ---------------- */
function receiveControl(msg) {
    if (msg.type === "meta") {
        const entry = {
            id: msg.id,
            fid: msg.fid,
            name: msg.name,
            size: msg.size,
            mime: msg.mime || "",
            chunks: [],
            received: 0,
            done: false,
            endSeen: false,
            lastPct: 0,
        };
        const orphan = state.orphanChunks.get(msg.fid);
        if (orphan) {
            entry.chunks = orphan.chunks;
            entry.received = orphan.received;
            state.orphanChunks.delete(msg.fid);
        }
        state.filesMap.set(msg.id, entry);
        state.fidMap.set(msg.fid, entry);
        if (state.pendingEndIds.has(msg.id)) {
            entry.endSeen = true;   /* its end arrived before this meta */
            state.pendingEndIds.delete(msg.id);
        }
        state.recvExpected += msg.size;
        addStatusCard(entry);
        logBot(`Receiving "${entry.name}" (${formatBytes(entry.size)})`);
        tryFinalize(entry);
    } else if (msg.type === "end") {
        const entry = state.filesMap.get(msg.id);
        if (!entry) {
            state.pendingEndIds.add(msg.id);  /* end arrived before meta */
            return;
        }
        entry.endSeen = true;
        tryFinalize(entry);
    } else if (msg.type === "probe-result") {
        state.probeDone = true;
        logBot(`MAX LINK SPEED to this device: ${msg.mbs.toFixed(1)} MB/s (${msg.mbps.toFixed(0)} Mbps).`);
        $("connection-tag").textContent = `Max ~${msg.mbs.toFixed(1)} MB/s`;
        if (state.pendingStart) {
            state.pendingStart = false;
            if (state.files.length && !state.sending) startSendingAll();
        }
    }
}

function tryFinalize(entry) {
    if (entry.done || !entry.endSeen) return;
    if (entry.size > 0 && entry.received < entry.size) return; /* wait for remaining chunks */
    entry.blob = new Blob(entry.chunks, { type: entry.mime });
    entry.done = true;
    state.receivedFiles.push({ name: entry.name, blob: entry.blob });
    markStatusCardDone(entry);
    if (entry.blob.size !== entry.size) {
        logBot(`ERROR: "${entry.name}" is incomplete (${formatBytes(entry.blob.size)} of ${formatBytes(entry.size)}).`);
    } else {
        logBot(`Received "${entry.name}" completely (${formatBytes(entry.blob.size)}).`);
    }
    if ([...state.filesMap.values()].every((f) => f.done)) {
        logBot(`All ${state.filesMap.size} file(s) received. Click Download All.`);
        finishAsReceiver();
    }
}

function receiveChunk(buf) {
    if (buf.byteLength < 8) return;
    const view = new DataView(buf);
    const idx = view.getUint32(0, true);
    const fid = view.getUint32(4, true);
    const payload = buf.slice(8);

    let entry = state.fidMap.get(fid);
    if (!entry) {
        let orphan = state.orphanChunks.get(fid);
        if (!orphan) {
            orphan = { chunks: [], received: 0 };
            state.orphanChunks.set(fid, orphan);
        }
        orphan.chunks[idx] = payload;
        orphan.received += payload.byteLength;
        state.recvBytes += payload.byteLength;
        updateThroughput(payload.byteLength);
        return;
    }
    if (entry.done) return;

    entry.chunks[idx] = payload;
    entry.received += payload.byteLength;
    state.recvBytes += payload.byteLength;
    updateThroughput(payload.byteLength);
    reportProgress(state.recvExpected ? state.recvBytes / state.recvExpected : 0);
    $("progress-size").textContent = `${formatBytes(state.recvBytes)} / ${formatBytes(state.recvExpected)}`;

    const pct = entry.size ? Math.floor((entry.received / entry.size) * 100) : 100;
    if (pct - entry.lastPct >= 25) {
        entry.lastPct = pct;
        logBot(`"${entry.name}": ${pct}% received`);
    }
    tryFinalize(entry);
}

/* ---------------- status cards (receiver) ---------------- */
function addStatusCard(entry) {
    const box = $("file-status");
    const card = document.createElement("div");
    card.className = "file-card";
    card.id = "fc-" + entry.id;

    const tag = document.createElement("span");
    tag.className = "file-tag";
    tag.textContent = fileIcon(entry.name);

    const meta = document.createElement("div");
    meta.className = "file-meta";
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = entry.name;
    const size = document.createElement("div");
    size.className = "file-size";
    size.textContent = formatBytes(entry.size);
    meta.append(name, size);

    const badge = document.createElement("div");
    badge.className = "status-badge";
    badge.textContent = "Receiving";
    badge.id = "badge-" + entry.id;

    card.append(tag, meta, badge);
    box.appendChild(card);
}

function markStatusCardDone(entry) {
    const card = document.getElementById("fc-" + entry.id);
    if (card) {
        card.classList.add("done");
        const b = document.getElementById("badge-" + entry.id);
        if (b) b.textContent = entry.blob && entry.blob.size === entry.size ? "OK" : "INCOMPLETE";
    }
}

/* ---------------- completion ---------------- */
function finishAsSender() {
    state.finished = true;
    $("transfer-title").textContent = "Transfer complete";
    $("btn-done").hidden = false;
    $("btn-cancel").hidden = true;
    logBot("All files sent to every connected device.");
}

function finishAsReceiver() {
    state.finished = true;
    $("transfer-title").textContent = "Transfer complete";
    $("btn-download").hidden = false;
    $("btn-cancel").hidden = true;
}

function downloadAll() {
    state.receivedFiles.forEach((entry, i) => {
        setTimeout(() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(entry.blob);
            a.download = entry.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
        }, i * 400);
    });
    toast("Check your Downloads folder!", "success");
}

/* ---------------- lifecycle ---------------- */
function resetTransfer() {
    for (const peer of state.peers.values()) {
        try { if (peer.dc) peer.dc.close(); } catch (_) { /* noop */ }
        try { if (peer.pc) peer.pc.close(); } catch (_) { /* noop */ }
    }
    try { if (state.ws) state.ws.close(); } catch (_) { /* noop */ }
    state.peers = new Map();
    state.role = null;
    state.files = [];
    state.roomCode = null;
    state.ws = null;
    state.peerId = null;
    state.hostId = null;
    state.isHost = false;
    state.cancelled = false;
    state.sending = false;
    state.finished = false;
    state.transferShown = false;
    state.totalSize = 0;
    state.speed = 0;
    state.segBytes = 0;
    state.segStart = performance.now();
    state.filesMap = new Map();
    state.fidMap = new Map();
    state.orphanChunks = new Map();
    state.receivedFiles = [];
    state.recvExpected = 0;
    state.recvBytes = 0;
    state.pendingEndIds = new Set();
    state.probeDone = false;
    state.pendingStart = false;
    if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }

    $("file-list").innerHTML = "";
    $("file-status").innerHTML = "";
    const botLog = $("bot-log");
    if (botLog) botLog.innerHTML = "";
    $("room-banner").hidden = true;
    $("qr-img").hidden = true;
    $("join-link").hidden = true;
    $("btn-start").disabled = false;
    $("btn-start").textContent = "Start transfer";
    $("progress-fill").style.width = "0%";
    $("progress-pct").textContent = "0%";
    $("progress-size").textContent = "0 B / 0 B";
    $("speed-num").textContent = "0.00";
    $("speed-unit").textContent = "MB/s";
    $("btn-download").hidden = true;
    $("btn-done").hidden = true;
    $("btn-cancel").hidden = true;
    $("conn-orb").classList.remove("connected");
    $("transfer-title").textContent = "Connecting...";
    $("connection-tag").textContent = "Secure channel";
    const strip = $("peers-strip");
    if (strip) strip.innerHTML = "";
    const sendStrip = $("send-peer-strip");
    if (sendStrip) sendStrip.innerHTML = "";
    showScreen("screen-home");
}

function cancelTransfer() {
    state.cancelled = true;
    resetTransfer();
}

/* ---------- copy helpers ---------- */
function copyText(text, okMsg) {
    const done = () => toast(okMsg, "success");
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
        fallbackCopy(text, done);
    }
}

function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (_) { /* ignore */ }
    ta.remove();
}

function copyCode() {
    if (state.roomCode) copyText(state.roomCode, "Room code copied!");
}

function copyLink() {
    if (state.roomCode) {
        const url = `${location.origin}${location.pathname}?code=${state.roomCode}`;
        copyText(url, "Share link copied!");
    }
}

/* ---------- wire up UI ---------- */
$("btn-send").addEventListener("click", () => {
    if (state.role === "sender" || state.role === "receiver") resetTransfer();
    state.role = "sender";
    showScreen("screen-send");
});

$("btn-receive").addEventListener("click", () => {
    if (state.role === "sender" || state.role === "receiver") resetTransfer();
    showScreen("screen-receive");
    setTimeout(() => $("join-code").focus(), 200);
});

$("btn-start").addEventListener("click", () => {
    if (!state.files.length) {
        toast("Pick at least one file first", "error");
        return;
    }
    createRoom();
});

$("btn-join").addEventListener("click", joinRoom);

$("btn-copy").addEventListener("click", copyCode);
$("btn-copy-link").addEventListener("click", copyLink);
$("btn-download").addEventListener("click", downloadAll);
$("btn-done").addEventListener("click", () => { resetTransfer(); showScreen("screen-send"); });
$("btn-cancel").addEventListener("click", cancelTransfer);

document.querySelectorAll(".back-btn").forEach((b) =>
    b.addEventListener("click", () => showScreen(b.dataset.back))
);

$("join-code").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
});

$("join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        $("btn-join").click();
    }
});

$("qr-img").addEventListener("error", () => { $("qr-img").hidden = true; });

/* auto-join via ?code=XXXXXX share link / QR scan */
const autoCode = new URLSearchParams(location.search).get("code");
if (autoCode) {
    $("join-code").value = autoCode.toUpperCase();
    showScreen("screen-receive");
    setTimeout(() => joinRoom(), 300);
}
