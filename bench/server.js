'use strict';
/**
 * bench/server.js - Local desktop preview server for idrive7-cluster-plus (Cluster+).
 * Emulates the cluster-render Unix socket protocol and streams RGBA layers to bench/ui.html over SSE.
 *
 *   node bench/server.js
 *   PORT=18078 node bench/server.js
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, fork } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const BUILD_SCRIPT = path.join(ROOT_DIR, 'vendor', 'cauliflowermossgrape-idrive7-apps', 'kit', 'tools', 'build.py');
const visible = require(path.join(ROOT_DIR, 'shared', 'visible'));

const APP_ID = 'cluster_metrics';
const HTTP_PORT = Number(process.env.PORT || 8078);
const IPC_SOCK = process.env.BENCH_SOCK || path.join(os.tmpdir(), 'cluster-metrics-bench-' + process.pid + '.sock');
const MAX_LAYERS_PER_CONN = Number(process.env.BENCH_LAYER_CAP || 8);
const MAX_PIXEL_MEMORY = 16 * 1024 * 1024;
const DISPLAY_TARGETS = {
    hud: { w: 800, h: 480 },
    panel: { w: 1920, h: 720 },
    map: { w: 1088, h: 480 },
};

const activeLayers = new Map();
const eventStreams = new Set();
let connCounter = 1;
let workerProc = null;
let latestStatusText = '';
let latestSettings = null;
let latestTelemetry = null;
let rpcErrorCount = 0;

function emitLog(level, message) {
    console.log('[bench] ' + (level !== 'info' ? level.toUpperCase() + ' ' : '') + message);
    pushSse({ t: 'log', level, ts: Date.now(), text: message });
}

function pushSse(eventObj, targetStream) {
    const frame = 'data: ' + JSON.stringify(eventObj) + '\n\n';
    if (targetStream) {
        try { targetStream.write(frame); } catch (e) { /* disconnected */ }
        return;
    }
    eventStreams.forEach((stream) => {
        try { stream.write(frame); } catch (e) { /* disconnected */ }
    });
}

function allocatedBytes() {
    let bytes = 0;
    activeLayers.forEach((layer) => {
        if (layer.pixels) bytes += layer.pixels.length * 2;
    });
    return bytes;
}

function serializeScene() {
    const list = [];
    activeLayers.forEach((l, id) => {
        list.push({
            key: id,
            conn: l.connId,
            ref: l.ref,
            target: l.target,
            klass: l.klass,
            z: l.z,
            x: l.x,
            y: l.y,
            w: l.w,
            h: l.h,
            iw: l.iw,
            ih: l.ih,
            visible: l.visible,
            contend: l.contend,
        });
    });
    return list;
}

function sendSocketEvent(socket, msg) {
    const jsonBuf = Buffer.from(JSON.stringify(msg), 'utf8');
    const pkt = Buffer.alloc(5 + jsonBuf.length);
    pkt.writeUInt32LE(jsonBuf.length + 1, 0);
    pkt[4] = 0x4a;
    jsonBuf.copy(pkt, 5);
    try { socket.write(pkt); } catch (e) { /* closed */ }
}

const ipcServer = net.createServer((socket) => {
    const connId = connCounter++;
    let rxBuf = Buffer.alloc(0);

    function sendError(op, ref, reason) {
        rpcErrorCount++;
        emitLog('error', 'refused ' + op + ' ref=' + ref + ': ' + reason);
        sendSocketEvent(socket, { ev: 'error', op, ref, reason });
    }

    function handleCommand(payload) {
        let cmd;
        try { cmd = JSON.parse(payload.toString('utf8')); } catch (e) { rpcErrorCount++; return; }

        if (cmd.op === 'hello') {
            sendSocketEvent(socket, { ev: 'hello', backend: 'bench', targets: 'hud panel map', proto: 1 });
        } else if (cmd.op === 'layer') {
            let ownedCount = 0;
            activeLayers.forEach((l) => { if (l.connId === connId) ownedCount++; });
            if (ownedCount >= MAX_LAYERS_PER_CONN) {
                return sendError('layer', cmd.ref, 'layer cap exceeded (' + MAX_LAYERS_PER_CONN + ')');
            }
            const iw = cmd.iw || cmd.w || 1;
            const ih = cmd.ih || cmd.h || 1;
            if (allocatedBytes() + iw * ih * 8 > MAX_PIXEL_MEMORY) {
                return sendError('layer', cmd.ref, 'pixel memory cap reached');
            }
            const id = connId + ':' + cmd.ref;
            const entry = {
                key: id,
                connId,
                ref: cmd.ref,
                target: cmd.target || 'hud',
                klass: cmd.class || 'overlay',
                z: cmd.z || 0,
                x: cmd.x || 0,
                y: cmd.y || 0,
                w: cmd.w || iw,
                h: cmd.h || ih,
                iw,
                ih,
                visible: cmd.visible !== 0,
                contend: cmd.contend !== 0,
                pixels: Buffer.alloc(iw * ih * 4),
                initialized: false,
            };
            activeLayers.set(id, entry);
            sendSocketEvent(socket, { ev: 'layer', ref: cmd.ref, state: entry.visible ? 'shown' : 'hidden' });
            pushSse({ t: 'scene', layers: serializeScene(), pixels: allocatedBytes() });
        } else if (cmd.op === 'set') {
            const entry = activeLayers.get(connId + ':' + cmd.ref);
            if (!entry) return sendError('set', cmd.ref, 'unknown layer');
            if (cmd.x !== undefined) entry.x = cmd.x;
            if (cmd.y !== undefined) entry.y = cmd.y;
            if (cmd.w !== undefined) entry.w = cmd.w;
            if (cmd.h !== undefined) entry.h = cmd.h;
            if (cmd.z !== undefined) entry.z = cmd.z;
            if (cmd.visible !== undefined) entry.visible = Boolean(cmd.visible);
            if (cmd.contend !== undefined) entry.contend = Boolean(cmd.contend);
            pushSse({ t: 'scene', layers: serializeScene(), pixels: allocatedBytes() });
        } else if (cmd.op === 'drop') {
            activeLayers.delete(connId + ':' + cmd.ref);
            pushSse({ t: 'scene', layers: serializeScene(), pixels: allocatedBytes() });
        } else if (cmd.op === 'status') {
            sendSocketEvent(socket, { ev: 'status', text: 'bench: ' + activeLayers.size + ' layers, ' + allocatedBytes() + ' bytes' });
        }
    }

    function handleFrame(payload) {
        if (payload.length < 14) return;
        const ref = payload.readUInt32LE(0);
        const rectCount = payload.readUInt16LE(12);
        const entry = activeLayers.get(connId + ':' + ref);
        if (!entry) return sendError('frame', ref, 'unknown layer');
        const rgba = payload.slice(14 + rectCount * 8);
        if (rectCount === 0) {
            if (rgba.length !== entry.pixels.length) return sendError('frame', ref, 'buffer size mismatch');
            rgba.copy(entry.pixels);
            entry.initialized = true;
            pushSse({ t: 'px', key: entry.key, iw: entry.iw, ih: entry.ih, x: 0, y: 0, w: entry.iw, h: entry.ih });
            return;
        }
        let cursor = 0;
        const dirty = [];
        for (let i = 0; i < rectCount; i++) {
            const rx = payload.readUInt16LE(14 + i * 8);
            const ry = payload.readUInt16LE(16 + i * 8);
            const rw = payload.readUInt16LE(18 + i * 8);
            const rh = payload.readUInt16LE(20 + i * 8);
            if (rx + rw > entry.iw || ry + rh > entry.ih) return sendError('frame', ref, 'dirty rect out of bounds');
            for (let row = 0; row < rh; row++) {
                const dstOff = ((ry + row) * entry.iw + rx) * 4;
                rgba.copy(entry.pixels, dstOff, cursor, cursor + rw * 4);
                cursor += rw * 4;
            }
            dirty.push([rx, ry, rw, rh]);
        }
        if (entry.initialized) {
            dirty.forEach((d) => pushSse({ t: 'px', key: entry.key, iw: entry.iw, ih: entry.ih, x: d[0], y: d[1], w: d[2], h: d[3] }));
        } else {
            entry.initialized = true;
            pushSse({ t: 'px', key: entry.key, iw: entry.iw, ih: entry.ih, x: 0, y: 0, w: entry.iw, h: entry.ih });
        }
    }

    socket.on('data', (chunk) => {
        rxBuf = rxBuf.length ? Buffer.concat([rxBuf, chunk]) : chunk;
        while (rxBuf.length >= 5) {
            const frameLen = rxBuf.readUInt32LE(0);
            if (frameLen < 1 || frameLen > 16 * 1024 * 1024) { socket.destroy(); return; }
            if (rxBuf.length < 4 + frameLen) break;
            const kind = rxBuf[4];
            const payload = rxBuf.slice(5, 4 + frameLen);
            rxBuf = rxBuf.slice(4 + frameLen);
            if (kind === 0x4a) handleCommand(payload);
            else if (kind === 0x46) handleFrame(payload);
        }
    });

    socket.on('close', () => {
        let changed = false;
        Array.from(activeLayers.keys()).forEach((k) => {
            if (activeLayers.get(k).connId === connId) {
                activeLayers.delete(k);
                changed = true;
            }
        });
        if (changed) pushSse({ t: 'scene', layers: serializeScene(), pixels: allocatedBytes() });
    });
});

function launchWorker() {
    const buildOut = execFileSync('python3', [BUILD_SCRIPT, '--app-root', ROOT_DIR, '--stub-sdk', APP_ID], {
        cwd: ROOT_DIR,
        env: Object.assign({}, process.env, { OAP_STUB_SDK: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    String(buildOut).split('\n').filter(Boolean).forEach((line) => emitLog('info', 'build: ' + line.trim()));

    workerProc = fork(path.join(__dirname, 'run-app.js'), [path.join(ROOT_DIR, 'dist', APP_ID), path.join(ROOT_DIR, 'bench', '.data', APP_ID)], {
        env: Object.assign({}, process.env, {
            CLUSTER_METRICS_SOCKET: IPC_SOCK,
            HUD_CLUSTER_SOCKET: IPC_SOCK,
            CLUSTER_METRICS_BENCH: '1',
        }),
    });
    workerProc.on('message', (msg) => {
        if (!msg) return;
        if (msg.t === 'status') { latestStatusText = msg.s; pushSse({ t: 'status', s: latestStatusText }); }
        else if (msg.t === 'settings') { latestSettings = msg; pushSse(msg); }
        else if (msg.t === 'telemetry') { latestTelemetry = msg.v; pushSse(msg); }
        else if (msg.t === 'log') { emitLog(msg.level || 'info', msg.s); }
    });
    workerProc.on('exit', (code) => {
        emitLog(code ? 'error' : 'info', 'worker exited with code ' + code);
        workerProc = null;
    });
}

function parseJsonBody(req) {
    return new Promise((resolve) => {
        const parts = [];
        req.on('data', (d) => parts.push(d));
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); }
            catch (e) { resolve({}); }
        });
    });
}

function parseQuery(rawUrl) {
    const q = {};
    const qIdx = rawUrl.indexOf('?');
    if (qIdx < 0) return q;
    const pairs = rawUrl.slice(qIdx + 1).split('&');
    for (let i = 0; i < pairs.length; i++) {
        const eq = pairs[i].indexOf('=');
        if (eq > 0) q[decodeURIComponent(pairs[i].slice(0, eq))] = decodeURIComponent(pairs[i].slice(eq + 1));
    }
    return q;
}

const httpServer = http.createServer(async (req, res) => {
    const route = req.url.split('?')[0];
    if (req.method === 'GET' && route === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(__dirname, 'ui.html')).pipe(res);
    }
    if (req.method === 'GET' && route.indexOf('/assets/') === 0) {
        const fileName = path.basename(route.slice(8));
        const fullPath = path.join(__dirname, 'assets', fileName);
        if (/^[a-zA-Z0-9_.-]+\.(jpg|jpeg|png)$/.test(fileName) && fs.existsSync(fullPath)) {
            res.writeHead(200, {
                'content-type': /\.png$/i.test(fileName) ? 'image/png' : 'image/jpeg',
                'cache-control': 'public, max-age=300',
            });
            return fs.createReadStream(fullPath).pipe(res);
        }
        res.writeHead(404);
        return res.end();
    }
    if (req.method === 'GET' && route === '/state') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({
            running: Boolean(workerProc),
            status: latestStatusText,
            telemetry: latestTelemetry,
            protocolErrors: rpcErrorCount,
            layerCount: activeLayers.size,
            pixelBytes: allocatedBytes(),
            layers: serializeScene(),
            geometry: visible,
        }));
    }
    if (req.method === 'GET' && route === '/px') {
        const q = parseQuery(req.url);
        const layer = activeLayers.get(q.key);
        const x = Number(q.x), y = Number(q.y), w = Number(q.w), h = Number(q.h);
        if (!layer || !layer.pixels || !(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= layer.iw && y + h <= layer.ih)) {
            res.writeHead(404);
            return res.end();
        }
        const rectBuf = Buffer.alloc(w * h * 4);
        for (let r = 0; r < h; r++) {
            const srcStart = ((y + r) * layer.iw + x) * 4;
            layer.pixels.copy(rectBuf, r * w * 4, srcStart, srcStart + w * 4);
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(rectBuf);
    }
    if (req.method === 'GET' && route === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        eventStreams.add(res);
        req.on('close', () => eventStreams.delete(res));
        pushSse({ t: 'hello', targets: DISPLAY_TARGETS, geometry: visible }, res);
        pushSse({ t: 'scene', layers: serializeScene(), pixels: allocatedBytes() }, res);
        activeLayers.forEach((l) => pushSse({ t: 'px', key: l.key, iw: l.iw, ih: l.ih, x: 0, y: 0, w: l.iw, h: l.ih }, res));
        if (latestSettings) pushSse(latestSettings, res);
        if (latestStatusText) pushSse({ t: 'status', s: latestStatusText }, res);
        if (latestTelemetry) pushSse({ t: 'telemetry', v: latestTelemetry }, res);
        return;
    }
    if (req.method === 'POST' && route === '/signals') {
        const body = await parseJsonBody(req);
        if (workerProc) workerProc.send({ t: 'signals', mode: body.mode, values: body.values || {} });
        res.writeHead(204);
        return res.end();
    }
    if (req.method === 'POST' && route === '/setting') {
        const body = await parseJsonBody(req);
        if (workerProc) workerProc.send({ t: 'set', key: body.key, value: body.value });
        res.writeHead(204);
        return res.end();
    }
    res.writeHead(404);
    res.end();
});

try { fs.unlinkSync(IPC_SOCK); } catch (e) { /* none */ }
ipcServer.listen(IPC_SOCK, () => {
    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
        emitLog('info', 'bench listening at http://127.0.0.1:' + HTTP_PORT + ' (sock ' + IPC_SOCK + ')');
        launchWorker();
    });
});

function cleanupAndExit() {
    if (workerProc) workerProc.kill('SIGTERM');
    try { fs.unlinkSync(IPC_SOCK); } catch (e) { /* none */ }
    process.exit(0);
}
process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
