/* Protocol simulation test: replicates the EXACT frame format and
   reassembly algorithm used in app/static/js/app.js, then hammers it with
   adversarial delivery (interleaved files, full reordering, split chunks)
   to prove reassembly is byte-perfect. Run: node test_protocol.mjs */
import { strict as assert } from "node:assert";
import crypto from "node:crypto";

const CHUNK_SIZE = 64 * 1024;

/* ---- sender side (mirrors sendOneFile) ---- */
function frameChunks(fileBytes, fid) {
    const frames = [];
    const totalChunks = Math.ceil(fileBytes.length / CHUNK_SIZE) || 0;
    for (let index = 0; index < totalChunks; index++) {
        const header = Buffer.alloc(8);
        header.writeUInt32LE(index, 0);
        header.writeUInt32LE(fid, 4);
        const slice = fileBytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
        frames.push(Buffer.concat([header, slice]));
    }
    return frames;
}

/* ---- receiver side (mirrors receiveControl/receiveChunk/tryFinalize) ---- */
function makeReceiver() {
    const filesMap = new Map();
    const fidMap = new Map();
    const orphanChunks = new Map();
    const pendingEndIds = new Set();
    const finished = [];

    function tryFinalize(entry) {
        if (entry.done || !entry.endSeen) return;
        if (entry.size > 0 && entry.received < entry.size) return;
        entry.blob = Buffer.concat(entry.chunks.map((c) => c || Buffer.alloc(0)));
        entry.done = true;
        finished.push(entry);
    }

    function onMeta(msg) {
        const entry = {
            id: msg.id, fid: msg.fid, name: msg.name, size: msg.size,
            chunks: [], received: 0, done: false, endSeen: false,
        };
        const orphan = orphanChunks.get(msg.fid);
        if (orphan) {
            entry.chunks = orphan.chunks;
            entry.received = orphan.received;
            orphanChunks.delete(msg.fid);
        }
        filesMap.set(msg.id, entry);
        fidMap.set(msg.fid, entry);
        if (pendingEndIds.has(msg.id)) {
            entry.endSeen = true;
            pendingEndIds.delete(msg.id);
        }
        tryFinalize(entry);
    }

    function onEnd(msg) {
        const entry = filesMap.get(msg.id);
        if (!entry) {
            pendingEndIds.add(msg.id);
            return;
        }
        entry.endSeen = true;
        tryFinalize(entry);
    }

    function onChunk(buf) {
        const idx = buf.readUInt32LE(0);
        const fid = buf.readUInt32LE(4);
        const payload = buf.subarray(8);
        let entry = fidMap.get(fid);
        if (!entry) {
            let orphan = orphanChunks.get(fid);
            if (!orphan) { orphan = { chunks: [], received: 0 }; orphanChunks.set(fid, orphan); }
            orphan.chunks[idx] = payload;
            orphan.received += payload.length;
            return;
        }
        if (entry.done) return;
        entry.chunks[idx] = payload;
        entry.received += payload.length;
        tryFinalize(entry);
    }

    return { onMeta, onEnd, onChunk, finished, filesMap };
}

/* ---- test: 10 files (including a 0-byte file and a 20 MB one > 16 MB),
        delivered fully interleaved and SHUFFLED (worse than any real
        unordered channel could produce) ---- */
const files = [];
for (let i = 0; i < 9; i++) {
    files.push({
        name: `video${i + 1}.mp4`,
        bytes: crypto.randomBytes(i === 0 ? 20 * 1024 * 1024 : Math.floor(Math.random() * 500000) + 1000),
    });
}
files.push({ name: "empty.txt", bytes: Buffer.alloc(0) });

const rx = makeReceiver();
let allFrames = [];
files.forEach((f, i) => {
    const id = `id-${i}`;
    const frames = frameChunks(f.bytes, i);
    allFrames.push({ kind: "meta", msg: { type: "meta", id, fid: i, name: f.name, size: f.bytes.length } });
    allFrames.push(...frames.map((b) => ({ kind: "chunk", buf: b })));
    allFrames.push({ kind: "end", msg: { type: "end", id } });
});

/* shuffle: worst-case out-of-order delivery */
for (let i = allFrames.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allFrames[i], allFrames[j]] = [allFrames[j], allFrames[i]];
}

for (const f of allFrames) {
    if (f.kind === "meta") rx.onMeta(f.msg);
    else if (f.kind === "end") rx.onEnd(f.msg);
    else rx.onChunk(f.buf);
}

/* ---- assertions ---- */
assert.equal(rx.finished.length, files.length, "all files finalized");
for (let i = 0; i < files.length; i++) {
    const got = rx.filesMap.get(`id-${i}`);
    assert.equal(got.done, true, `${files[i].name} done`);
    assert.equal(got.blob.length, files[i].bytes.length, `${files[i].name} size match`);
    assert.ok(got.blob.equals(files[i].bytes), `${files[i].name} byte-identical`);
}
console.log(`PASS: ${files.length} files (incl. 20 MB and 0-byte) reassembled byte-perfectly from ${allFrames.length} fully shuffled frames.`);
