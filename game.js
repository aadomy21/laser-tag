/* ============================================================
   NEON TAG — a laser-tag battle royale in the browser
   Three.js for 3D, PeerJS (WebRTC) for peer-to-peer multiplayer.
   Host is authoritative for hearts / power cores / bots / timer.
   ============================================================ */

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.157.0/build/three.module.js";

const WORDS_A = ["Turbo", "Neon", "Cosmic", "Rapid", "Shadow", "Blazing", "Frosty", "Rogue", "Silent", "Cyber", "Solar", "Lunar", "Wild", "Electric", "Sneaky", "Mighty", "Jumpy", "Glowing", "Rocket", "Pixel"];
const WORDS_B = ["Fox", "Falcon", "Otter", "Comet", "Panda", "Wolf", "Tiger", "Hawk", "Ninja", "Robot", "Dragon", "Phoenix", "Shark", "Yeti", "Viper", "Badger", "Raccoon", "Cheetah", "Griffin", "Koala"];
const WORDS_C = ["Blaster", "Dash", "Spark", "Bolt", "Glide", "Storm", "Flash", "Zoom", "Beam", "Strike", "Nova", "Drift", "Ranger", "Pulse", "Rush"];
function randomName() {
  const r = a => a[Math.floor(Math.random() * a.length)];
  return `${r(WORDS_A)}${r(WORDS_B)}${r(WORDS_C)}`;
}

/* ---------------- Persistent local data ---------------- */
const SAVE_KEY = "neontag_save_v1";
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { }
  return { name: randomName(), crowns: 0, matches: 0, tags: 0, wins: 0, history: [] };
}
function saveSave() {
  localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  // best-effort cloud backup, so crowns/stats survive clearing browser data
  fetch(`${FIREBASE_DB_URL}/players_backup/${getDeviceId()}.json`, { method: "PUT", body: JSON.stringify(save) }).catch(() => { });
}
function getDeviceId() {
  let id = localStorage.getItem("neontag_device_id");
  if (!id) { id = "d" + Math.random().toString(36).slice(2, 12); localStorage.setItem("neontag_device_id", id); }
  return id;
}
let save = loadSave();

/* ---------------- DOM refs ---------------- */
const $ = id => document.getElementById(id);
const menuScreen = $("menu-screen"), gameScreen = $("game-screen");
const instructionsScreen = $("instructions-screen"), progressScreen = $("progress-screen");

/* ---------- menu wiring ---------- */
$("player-name").value = save.name;
$("player-name").addEventListener("change", e => { save.name = e.target.value.trim() || randomName(); saveSave(); });
$("randomize-name").addEventListener("click", () => { save.name = randomName(); $("player-name").value = save.name; saveSave(); });

function refreshStatsStrip() {
  $("stat-crowns").textContent = save.crowns;
  $("stat-matches").textContent = save.matches;
  $("stat-tags").textContent = save.tags;
}
refreshStatsStrip();

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.remove("hidden");
  });
});

$("instructions-btn").addEventListener("click", () => instructionsScreen.classList.remove("hidden"));
$("close-instructions").addEventListener("click", () => instructionsScreen.classList.add("hidden"));

$("progress-btn").addEventListener("click", () => {
  $("p-crowns").textContent = save.crowns;
  $("p-matches").textContent = save.matches;
  $("p-tags").textContent = save.tags;
  const rate = save.matches ? Math.round(100 * save.wins / save.matches) : 0;
  $("p-winrate").textContent = rate + "%";
  const hist = $("p-history"); hist.innerHTML = "";
  if (!save.history.length) { hist.innerHTML = '<div class="hint">No matches yet — go play!</div>'; }
  save.history.slice().reverse().slice(0, 20).forEach(h => {
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `<span class="${h.win ? 'win' : ''}">${h.win ? '👑 ' : ''}${h.place ? '#' + h.place : ''} ${h.mode}</span><span>${h.date}</span>`;
    hist.appendChild(row);
  });
  progressScreen.classList.remove("hidden");
});
$("close-progress").addEventListener("click", () => progressScreen.classList.add("hidden"));

$("bot-count").addEventListener("input", e => $("bot-count-val").textContent = e.target.value);

/* ============================================================
   NETWORKING — Firebase Realtime Database, room-based, real-time.
   No server code to write or run: rooms/<code>/players holds live
   player state (each client overwrites only its own key), and
   rooms/<code>/events is an append-only feed for one-off actions
   (tags, power cores, hearts, match start/end). Both are streamed
   with EventSource (Server-Sent Events), which the Realtime
   Database supports natively over plain HTTPS — no SDK, no API
   key required, as long as the security rules below are applied.
   ============================================================ */
const FIREBASE_DB_URL = "https://lasertag-569fa-default-rtdb.firebaseio.com";
function firebaseFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

const Firebase = {
  put(path, data) { return firebaseFetch(`${FIREBASE_DB_URL}/${path}.json`, { method: "PUT", body: JSON.stringify(data) }).catch(() => { }); },
  patch(path, data) { return firebaseFetch(`${FIREBASE_DB_URL}/${path}.json`, { method: "PATCH", body: JSON.stringify(data) }).catch(() => { }); },
  post(path, data) { return firebaseFetch(`${FIREBASE_DB_URL}/${path}.json`, { method: "POST", body: JSON.stringify(data) }).then(r => r.json()).catch(() => { }); },
  get(path) { return firebaseFetch(`${FIREBASE_DB_URL}/${path}.json`).then(r => r.json()).catch(() => null); },
  remove(path) { return firebaseFetch(`${FIREBASE_DB_URL}/${path}.json`, { method: "DELETE" }).catch(() => { }); },
  listen(path, onEvent) {
    const es = new EventSource(`${FIREBASE_DB_URL}/${path}.json`);
    const handle = type => e => {
      try { const { path, data } = JSON.parse(e.data); onEvent(type, path, data); } catch (err) { }
    };
    es.addEventListener("put", handle("put"));
    es.addEventListener("patch", handle("patch"));
    es.onerror = () => { }; // EventSource auto-reconnects; ignore transient errors
    return es;
  }
};

const Net = {
  isHost: false, myId: null, roomCode: null, sessionStart: 0,
  playersEs: null, eventsEs: null, lobbyEs: null, knownPlayerIds: null, visibility: "public",
  peerDevices: null, // sessionId -> deviceId, so bans survive a reload/rejoin
  onMessage: null, // callback(fromId, data)
  onPeerJoin: null, onPeerLeave: null,

  // Host creation used to fire 3 Firebase writes back-to-back (each a full
  // round trip), which is why "creating room" felt slow. They touch
  // independent paths, so fire them together instead.
  initHost(options, cb) {
    if (typeof options === "function") { cb = options; options = {}; }
    this.isHost = true;
    this.myId = "p" + Math.random().toString(36).slice(2, 10);
    this.roomCode = genRoomCode();
    this.sessionStart = Date.now();
    this.visibility = options.visibility || "public";
    this.knownPlayerIds = new Set();
    this.peerDevices = {};
    const deviceId = getDeviceId();
    const meta = { hostId: this.myId, createdAt: this.sessionStart, started: false, public: this.visibility === "public", name: save.name, players: 1 };
    Promise.all([
      Firebase.put(`rooms/${this.roomCode}/meta`, meta),
      Firebase.put(`lobbies/${this.roomCode}`, { ...meta, private: this.visibility === "private", code: this.roomCode }),
      Firebase.put(`rooms/${this.roomCode}/players/${this.myId}`, { name: save.name, x: 0, y: 1.6, z: 0, ry: 0, hp: 6, alive: true, hasMega: false, device: deviceId })
    ]).then(() => { this._startListening(); cb(this.roomCode); });
  },

  // Same idea: the meta check and the ban check don't depend on each other,
  // so fetch both at once instead of one-after-another.
  initClient(roomCode, myName, cb, errCb) {
    this.isHost = false;
    this.myId = "p" + Math.random().toString(36).slice(2, 10);
    this.roomCode = roomCode;
    this.sessionStart = Date.now();
    this.knownPlayerIds = new Set();
    this.peerDevices = {};
    const deviceId = getDeviceId();
    Promise.all([
      Firebase.get(`rooms/${roomCode}/meta`),
      Firebase.get(`rooms/${roomCode}/bans/${deviceId}`)
    ]).then(([meta, banned]) => {
      if (!meta || meta.started) { errCb && errCb(new Error("Room is unavailable")); return; }
      if (banned) { errCb && errCb(new Error("You are banned")); return; }
      this._startListening();
      // lobby presence write so the host sees this player in the room list
      Firebase.put(`rooms/${roomCode}/players/${this.myId}`, { name: myName, x: 0, y: 1.6, z: 0, ry: 0, hp: 6, alive: true, hasMega: false, device: deviceId })
        .then(() => {
          const nextCount = (meta.players || 1) + 1;
          Firebase.patch(`rooms/${roomCode}/meta`, { players: nextCount });
          Firebase.patch(`lobbies/${roomCode}`, { players: nextCount });
          cb(this.myId);
        });
    }).catch(e => errCb && errCb(e));
  },

  _startListening() {
    const room = this.roomCode;
    this.playersEs = Firebase.listen(`rooms/${room}/players`, (type, path, data) => {
      if (path === "/") {
        if (!data) return;
        for (const id in data) {
          if (id === this.myId) continue;
          if (data[id].device) this.peerDevices[id] = data[id].device;
          const isNew = !this.knownPlayerIds.has(id);
          this.knownPlayerIds.add(id);
          if (isNew && this.onPeerJoin) this.onPeerJoin(id, data[id].name);
          if (this.onMessage) this.onMessage(id, { t: "state", ...data[id] });
        }
      } else {
        const id = path.slice(1);
        if (id === this.myId) return;
        if (data === null) {
          if (this.knownPlayerIds.has(id)) { this.knownPlayerIds.delete(id); if (this.onPeerLeave) this.onPeerLeave(id); }
          delete this.peerDevices[id];
          return;
        }
        if (data.device) this.peerDevices[id] = data.device;
        const isNew = !this.knownPlayerIds.has(id);
        this.knownPlayerIds.add(id);
        if (isNew && this.onPeerJoin) this.onPeerJoin(id, data.name);
        if (this.onMessage) this.onMessage(id, { t: "state", ...data });
      }
    });
    this.eventsEs = Firebase.listen(`rooms/${room}/events`, (type, path, data) => {
      if (path === "/") {
        if (!data) return;
        Object.values(data).forEach(ev => this._handleEvent(ev));
      } else {
        if (data) this._handleEvent(data);
      }
    });
  },
  _handleEvent(ev) {
    if (!ev || ev._from === this.myId) return;
    if (ev._to && ev._to !== this.myId) return;
    if (ev.t === "kicked" || ev.t === "banned") { this.onMessage && this.onMessage(ev._from, ev); return; }
    if (this.onMessage) this.onMessage(ev._from, ev);
  },

  // "state"/"botstate" go to the live players map (overwritten, not appended).
  // Everything else is a one-off event appended to the events feed.
  broadcast(data) {
    if (!this.roomCode) return;
    if (data.t === "state") {
      Firebase.put(`rooms/${this.roomCode}/players/${this.myId}`, data);
    } else if (data.t === "botstate") {
      Firebase.put(`rooms/${this.roomCode}/players/${data.id}`, data);
    } else {
      Firebase.post(`rooms/${this.roomCode}/events`, { ...data, _from: this.myId, _ts: Date.now() });
    }
  },
  sendTo(id, data) {
    if (!this.roomCode) return;
    Firebase.post(`rooms/${this.roomCode}/events`, { ...data, _from: this.myId, _to: id, _ts: Date.now() });
  },

  leaveRoom() {
    if (this.playersEs) { this.playersEs.close(); this.playersEs = null; }
    if (this.eventsEs) { this.eventsEs.close(); this.eventsEs = null; }
    if (this.lobbyEs) { this.lobbyEs.close(); this.lobbyEs = null; }
    if (this.roomCode && this.myId) Firebase.remove(`rooms/${this.roomCode}/players/${this.myId}`);
    if (this.isHost && this.roomCode) {
      Firebase.remove(`rooms/${this.roomCode}`); Firebase.remove(`lobbies/${this.roomCode}`);
    } else if (this.roomCode) {
      // best-effort: keep the public lobby browser's player count accurate
      const room = this.roomCode;
      Firebase.get(`rooms/${room}/meta`).then(meta => {
        if (!meta) return;
        const nextCount = Math.max(1, (meta.players || 2) - 1);
        Firebase.patch(`rooms/${room}/meta`, { players: nextCount });
        Firebase.patch(`lobbies/${room}`, { players: nextCount });
      });
    }
    this.roomCode = null; this.isHost = false; this.peerDevices = {};
  },
  setLobbyVisibility(visibility) {
    this.visibility = visibility;
    if (!this.roomCode || !this.isHost) return;
    const publicLobby = visibility === "public";
    Firebase.patch(`rooms/${this.roomCode}/meta`, { public: publicLobby });
    Firebase.patch(`lobbies/${this.roomCode}`, { public: publicLobby, private: !publicLobby });
  },
  moderate(id, action) {
    if (!this.roomCode || !this.isHost || id === this.myId) return;
    if (action === "banned") {
      // ban by device, not session id — a kicked/banned player gets a fresh
      // random session id on reload, so banning the live id alone would let
      // them just rejoin. Fall back to the id itself if we never heard a
      // device id from them (e.g. banned before their first state update).
      const device = (this.peerDevices && this.peerDevices[id]) || id;
      Firebase.put(`rooms/${this.roomCode}/bans/${device}`, true);
    }
    this.sendTo(id, { t: action });
    if (action === "banned") setTimeout(refreshBanList, 0);
  }
};
function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ============================================================
   GAME STATE
   ============================================================ */
let three = {}; // scene, camera, renderer
let game = null; // active Game instance

class RemotePlayer {
  constructor(id, name) {
    this.id = id; this.name = name; this.hp = 6; this.alive = true; this.hasMega = false; this.score = 0;
    this.x = 0; this.y = 1.6; this.z = 0; this.ry = 0;
    this.mesh = makePlayerMesh(name);
  }
  applyState(s) {
    this.x = s.x; this.y = s.y; this.z = s.z; this.ry = s.ry; this.hp = s.hp; this.alive = s.alive; this.hasMega = s.hasMega; this.score = s.score || 0;
    this.mesh.position.set(this.x, this.y - 0.9, this.z);
    this.mesh.rotation.y = this.ry;
    this.mesh.visible = this.alive;
    const bar = this.mesh.userData.hpFill;
    if (bar) bar.scale.x = Math.max(0.001, this.hp / 10);
  }
}

function makePlayerMesh(name) {
  const group = new THREE.Group();
  const bodyColor = new THREE.Color().setHSL(Math.random(), 0.7, 0.55);
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 0.78, 5, 10),
    new THREE.MeshStandardMaterial({ color: bodyColor, emissive: bodyColor, emissiveIntensity: 0.22, roughness: 0.35, metalness: 0.25 })
  );
  body.position.y = 0.9;
  group.add(body);
  const armor = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.48, 0.34), new THREE.MeshStandardMaterial({ color: 0x152333, emissive: bodyColor, emissiveIntensity: 0.18, metalness: 0.55, roughness: 0.3 }));
  armor.position.set(0, 1.02, 0.08); group.add(armor);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.13, 0.31), new THREE.MeshBasicMaterial({ color: 0x43f6e4 }));
  visor.position.set(0, 1.47, -0.17); group.add(visor);
  const shoulderGeo = new THREE.SphereGeometry(0.16, 8, 6);
  const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x203446, emissive: bodyColor, emissiveIntensity: 0.3 });
  [-1, 1].forEach(side => { const shoulder = new THREE.Mesh(shoulderGeo, shoulderMat); shoulder.position.set(side * 0.39, 1.08, 0); group.add(shoulder); });
  const limbMat = new THREE.MeshStandardMaterial({ color: 0x263342, emissive: bodyColor, emissiveIntensity: 0.12, metalness: 0.35, roughness: 0.4 });
  const armGeo = new THREE.CapsuleGeometry(0.085, 0.38, 3, 6);
  const legGeo = new THREE.CapsuleGeometry(0.105, 0.48, 3, 6);
  const leftArm = new THREE.Mesh(armGeo, limbMat); leftArm.position.set(-0.38, 0.78, 0); group.add(leftArm);
  const rightArm = new THREE.Mesh(armGeo, limbMat); rightArm.position.set(0.38, 0.78, 0); group.add(rightArm);
  const leftLeg = new THREE.Mesh(legGeo, limbMat); leftLeg.position.set(-0.16, 0.35, 0); group.add(leftLeg);
  const rightLeg = new THREE.Mesh(legGeo, limbMat); rightLeg.position.set(0.16, 0.35, 0); group.add(rightLeg);
  group.userData.animation = { leftArm, rightArm, leftLeg, rightLeg, phase: Math.random() * Math.PI * 2 };

  // name tag via sprite
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(8,10,20,0.6)"; ctx.fillRect(0, 0, 256, 64);
  ctx.font = "bold 34px Rajdhani, sans-serif"; ctx.fillStyle = "#00f0ff"; ctx.textAlign = "center";
  ctx.fillText(name.slice(0, 16), 128, 42);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(2, 0.5, 1);
  sprite.position.y = 2.15;
  group.add(sprite);

  // hp bar above head
  const barBg = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.08), new THREE.MeshBasicMaterial({ color: 0x222233 }));
  barBg.position.y = 1.85; group.add(barBg);
  const barFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.08), new THREE.MeshBasicMaterial({ color: 0xff2e88 }));
  barFill.position.y = 1.85; barFill.position.z = 0.001; group.add(barFill);
  group.userData.hpFill = barFill;

  return group;
}

/* ============================================================
   ARENA GENERATION
   ============================================================ */
function generateArena(seed) {
  const rand = mulberry32(seed);
  const size = 40; // half-extent
  const cell = 4;
  const cells = Math.floor((size * 2) / cell);
  const layout = { walls: [], hearts: [], cores: [], ramps: [], bunkers: [], size };

  for (let ix = 0; ix < cells; ix++) {
    for (let iz = 0; iz < cells; iz++) {
      const x = -size + ix * cell + cell / 2;
      const z = -size + iz * cell + cell / 2;
      const distCenter = Math.hypot(x, z);
      if (distCenter < 7) continue; // keep spawn-ish center clearer
      if (rand() < 0.22) {
        const h = 2 + rand() * 3;
        const w = cell * (0.5 + rand() * 0.4);
        layout.walls.push({ x, z, w, h, d: w, ry: rand() < 0.3 ? Math.PI / 4 : 0 });
      }
    }
  }
  // border walls
  const b = size;
  layout.walls.push({ x: 0, z: -b, w: b * 2, h: 6, d: 1, ry: 0 });
  layout.walls.push({ x: 0, z: b, w: b * 2, h: 6, d: 1, ry: 0 });
  layout.walls.push({ x: -b, z: 0, w: 1, h: 6, d: b * 2, ry: 0 });
  layout.walls.push({ x: b, z: 0, w: 1, h: 6, d: b * 2, ry: 0 });

  // ramps (blue, angled boxes leaning against tall walls)
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const r = 20 + rand() * 10;
    layout.ramps.push({ x: Math.cos(ang) * r, z: Math.sin(ang) * r, ry: ang + Math.PI / 2 });
  }

  // bunkers (3-sided cover)
  for (let i = 0; i < 8; i++) {
    layout.bunkers.push({ x: (rand() - 0.5) * size * 1.6, z: (rand() - 0.5) * size * 1.6, ry: rand() * Math.PI * 2 });
  }

  // hearts
  for (let i = 0; i < 14; i++) {
    layout.hearts.push({ id: "h" + i, x: (rand() - 0.5) * size * 1.7, z: (rand() - 0.5) * size * 1.7, active: true });
  }
  // power cores
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const r = 12 + rand() * 14;
    layout.cores.push({ id: "c" + i, x: Math.cos(ang) * r, z: Math.sin(ang) * r, active: true });
  }
  return layout;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

/* ============================================================
   MAIN GAME CLASS
   ============================================================ */
class Game {
  constructor(opts) {
    this.mode = opts.mode; // "solo" | "host" | "client"
    this.gameMode = opts.gameMode || "battle"; // "score" | "battle"
    this.modeLabel = this.gameMode === "score" ? "KILL RUN" : "BATTLE ROYALE";
    this.myName = save.name;
    this.myId = opts.myId || "local";
    this.botCount = opts.botCount || 0;
    this.seed = opts.seed || Math.floor(Math.random() * 1e9);
    this.layout = generateArena(this.seed);
    this.matchLen = 150; // 2:30
    this.timeLeft = this.matchLen;
    this.started = false;
    this.ended = false;
    this.remotePlayers = {}; // id -> RemotePlayer (includes bots on non-host? no: only host simulates bots)
    this.bots = {}; // id -> bot state, host only
    this.hearts = {}; this.cores = {};
    this.zoneRadius = this.layout.size * 1.6;
    this.killfeedEl = $("killfeed");
    this.lastSyncSent = 0;
    this.lastTimerSent = 0;
    this.lastBotSync = 0;
    this.lastAliveCount = -1;
    this.lastScore = -1;
    this.score = 0;
    this.deaths = 0;
    this.spectating = false;
    this.spectatorTarget = null;
    this.spectatorEndsAt = 0;
    this.deathMenuShown = false;
    this.paused = false;
    this.activeCore = null; // {id, progress, deadline}
    this.setupScene();
    this.setupLocalPlayer();
    this.setupControls();
    this.setupPauseMenu();
    this.setupPickupsAndCores();

    if (this.mode === "host") this.spawnBots(this.botCount);
    if (this.mode === "solo") this.spawnBots(this.botCount);

    Net.onMessage = (from, data) => this.handleNetMessage(from, data);
    Net.onPeerLeave = (id) => this.removeRemote(id);

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  /* ---------------- scene ---------------- */
  setupScene() {
    const canvas = $("game-canvas");
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: devicePixelRatio < 1.5 });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setSize(innerWidth, innerHeight);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060d);
    scene.fog = new THREE.FogExp2(0x05060d, 0.012);
    const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
    three = { renderer, scene, camera };

    scene.add(new THREE.HemisphereLight(0x8899ff, 0x0a0a12, 0.7));
    const dl = new THREE.DirectionalLight(0x9fd8ff, 0.5);
    dl.position.set(30, 50, 10); scene.add(dl);

    // floor
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x0d1226, roughness: 0.9 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(this.layout.size * 2.4, this.layout.size * 2.4), floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    // grid glow lines
    const grid = new THREE.GridHelper(this.layout.size * 2.4, 48, 0x00f0ff, 0x1a2440);
    grid.material.opacity = 0.35; grid.material.transparent = true;
    scene.add(grid);

    // walls
    this.wallMeshes = [];
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1c2444, emissive: 0x2a1650, emissiveIntensity: 0.4, roughness: 0.6 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x00f0ff });
    this.layout.walls.forEach(w => {
      const geo = new THREE.BoxGeometry(w.w, w.h, w.d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(w.x, w.h / 2, w.z);
      mesh.rotation.y = w.ry;
      scene.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      mesh.add(edges);
      this.wallMeshes.push(mesh);
      mesh.userData.aabbSrc = w;
    });

    // ramps
    const rampMat = new THREE.MeshStandardMaterial({ color: 0x123a6b, emissive: 0x1560c9, emissiveIntensity: 0.5 });
    this.layout.ramps.forEach(r => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 0.6, 6), rampMat);
      mesh.position.set(r.x, 1.4, r.z);
      mesh.rotation.set(0.5, r.ry, 0);
      scene.add(mesh);
      this.wallMeshes.push(mesh);
    });

    // bunkers (3 walls, no roof)
    const bunkerMat = new THREE.MeshStandardMaterial({ color: 0x2a1440, emissive: 0x6b1fa0, emissiveIntensity: 0.35 });
    this.layout.bunkers.forEach(bk => {
      const grp = new THREE.Group();
      grp.position.set(bk.x, 0, bk.z); grp.rotation.y = bk.ry;
      const side = new THREE.BoxGeometry(0.3, 2, 3);
      const back = new THREE.BoxGeometry(3, 2, 0.3);
      const l = new THREE.Mesh(side, bunkerMat); l.position.set(-1.5, 1, 0); grp.add(l);
      const r = new THREE.Mesh(side, bunkerMat); r.position.set(1.5, 1, 0); grp.add(r);
      const bWall = new THREE.Mesh(back, bunkerMat); bWall.position.set(0, 1, -1.5); grp.add(bWall);
      scene.add(grp);
      this.wallMeshes.push(l, r, bWall);
    });

    // shrinking zone wall (visual ring)
    const zoneGeo = new THREE.RingGeometry(0.97, 1, 64);
    const zoneMat = new THREE.MeshBasicMaterial({ color: 0xff2e88, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
    this.zoneRing = new THREE.Mesh(zoneGeo, zoneMat);
    this.zoneRing.rotation.x = -Math.PI / 2; this.zoneRing.position.y = 0.05;
    this.zoneRing.scale.setScalar(this.zoneRadius);
    this.zoneRing.visible = this.gameMode === "battle";
    scene.add(this.zoneRing);

    this.resizeHandler = () => {
      three.camera.aspect = innerWidth / innerHeight; three.camera.updateProjectionMatrix();
      three.renderer.setSize(innerWidth, innerHeight);
    };
    addEventListener("resize", this.resizeHandler);
  }

  setupPickupsAndCores() {
    const heartGeo = new THREE.SphereGeometry(0.35, 12, 12);
    const heartMat = new THREE.MeshStandardMaterial({ color: 0xff3b5c, emissive: 0xff3b5c, emissiveIntensity: 1 });
    this.layout.hearts.forEach(h => {
      const mesh = new THREE.Mesh(heartGeo, heartMat);
      mesh.position.set(h.x, 1, h.z);
      three.scene.add(mesh);
      this.hearts[h.id] = { mesh, active: true, x: h.x, z: h.z };
    });
    const coreGeo = new THREE.OctahedronGeometry(0.6, 0);
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x7b2ff7, emissive: 0x7b2ff7, emissiveIntensity: 1.2 });
    this.layout.cores.forEach(c => {
      const mesh = new THREE.Mesh(coreGeo, coreMat);
      mesh.position.set(c.x, 1.8, c.z);
      three.scene.add(mesh);
      const light = new THREE.PointLight(0x7b2ff7, 1.2, 6);
      mesh.add(light);
      this.cores[c.id] = { mesh, active: true, x: c.x, z: c.z };
    });
  }

  /* ---------------- local player ---------------- */
  setupLocalPlayer() {
    this.player = {
      x: 0, y: 1.6, z: this.layout.size * 0.7, vy: 0, ry: 0, rx: 0,
      hp: 6, alive: true, hasMega: false, ammo: 5, maxAmmo: 5, reloading: false,
      onGround: true, jumpVel: 0, speed: 5.2, moveVelocity: { x: 0, z: 0 },
      nextShotAt: 0, reloadDoneAt: 0
    };
    const spawn = this.findSafeSpawn(0);
    this.player.x = spawn.x; this.player.z = spawn.z;
    this.player.y = this.getGroundHeight(this.player.x, this.player.z) + 1.6;
    three.camera.position.set(this.player.x, this.player.y, this.player.z);

    // layered first-person blaster attached to the camera
    const gunGrp = new THREE.Group();
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x172331, emissive: 0x43f6e4, emissiveIntensity: 0.35, metalness: 0.7, roughness: 0.25 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xffca63, emissive: 0xff8d4d, emissiveIntensity: 0.8, metalness: 0.45 });
    const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.58), gunMat);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.28, 0.16), gunMat); grip.position.set(0, -0.16, 0.1); grip.rotation.x = -0.2;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.42, 10), accentMat); barrel.rotation.x = Math.PI / 2; barrel.position.z = -0.46;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.42), accentMat); rail.position.set(0, 0.11, -0.08);
    gunGrp.add(gunBody, grip, barrel, rail);
    this.gunMuzzle = new THREE.Object3D();
    this.gunMuzzle.position.set(0, 0, -0.7);
    gunGrp.add(this.gunMuzzle);
    gunGrp.position.set(0.25, -0.25, -0.5);
    three.camera.add(gunGrp);
    three.scene.add(three.camera);
    this.gunGrp = gunGrp;

    this.laserBeams = [];
    this.updateHeartsHUD();
    this.updateAmmoHUD();
  }

  updateHeartsHUD() {
    const row = $("hearts-row"); row.innerHTML = "";
    const total = this.player.hp > 10 ? 10 : 10;
    for (let i = 0; i < 10; i++) {
      const div = document.createElement("div");
      div.className = "heart-icon " + (i < this.player.hp ? "heart-full" : "heart-empty");
      div.textContent = "❤️"; div.style.fontSize = "20px"; div.style.lineHeight = "20px";
      row.appendChild(div);
    }
  }
  updateAmmoHUD() {
    const row = $("ammo-row"); row.innerHTML = "";
    for (let i = 0; i < this.player.maxAmmo; i++) {
      const div = document.createElement("div");
      div.style.fontSize = "18px";
      div.textContent = this.player.hasMega ? "🟨" : "🔷";
      div.style.opacity = i < this.player.ammo ? 1 : 0.2;
      row.appendChild(div);
    }
  }

  /* ---------------- controls ---------------- */
  setupControls() {
    this.keys = {};
    this.controlCleanups = [];
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this.controlCleanups.push(() => target.removeEventListener(type, handler, options));
    };
    this.isTouch = matchMedia("(pointer: coarse)").matches;
    if (!this.isTouch) {
      listen($("game-canvas"), "click", () => {
        if (document.pointerLockElement !== $("game-canvas")) $("game-canvas").requestPointerLock();
        else this.shoot();
      });
      listen(document, "mousemove", e => {
        if (document.pointerLockElement === $("game-canvas")) {
          this.player.ry -= e.movementX * 0.0022;
          this.player.rx -= e.movementY * 0.0022;
          this.player.rx = Math.max(-1.2, Math.min(1.2, this.player.rx));
        }
      });
      listen(document, "keydown", e => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        this.keys[e.code] = true;
        if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
        if (e.code === "KeyR") this.reload();
        if (e.code === "KeyE") this.tryOpenNearestCore();
        if (e.code === "Escape") { e.preventDefault(); this.togglePause(); }
      });
      listen(document, "keyup", e => this.keys[e.code] = false);
      listen(window, "blur", () => {
        this.keys = {};
        this.player.moveVelocity.x = 0;
        this.player.moveVelocity.z = 0;
      });
    } else {
      $("mobile-controls").classList.remove("hidden");
      this.setupTouchControls(listen);
    }
  }

  togglePause(force) {
    // Blocked any time you're dead/spectating (any mode) or the death menu
    // is up — Escape used to only get blocked in Battle Royale, so dying in
    // Kill Run and hitting Escape would pop the pause menu on top of (or
    // instead of) the death menu. The pause menu has no respawn option,
    // only RESTART MATCH / MAIN MENU, which is what made it feel like dying
    // "forced" a restart.
    if (this.ended || this.spectating || this.deathMenuShown) return;
    this.paused = force === undefined ? !this.paused : force;
    gameScreen.classList.toggle("paused", this.paused);
    $("pause-menu").classList.toggle("hidden", !this.paused);
    if (this.paused) {
      this.keys = {};
      this.player.moveVelocity.x = 0; this.player.moveVelocity.z = 0;
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }

  setupPauseMenu() {
    $("resume-match").onclick = () => this.togglePause(false);
    $("pause-restart").onclick = () => {
      const mode = this.mode, bots = this.botCount, gameMode = this.gameMode;
      this.dispose(); returnToMenu();
      if (mode === "solo") startMatch("solo", { botCount: bots, gameMode });
    };
    $("pause-menu-btn").onclick = () => { this.dispose(); returnToMenu(); };
    $("pause-settings").onclick = () => instructionsScreen.classList.remove("hidden");
  }

  setupTouchControls(listen) {
    const zone = $("joystick-zone"), knob = $("joystick-knob");
    let jTouchId = null, jStart = { x: 0, y: 0 };
    this.touchMove = { x: 0, y: 0 };
    listen(zone, "touchstart", e => {
      const t = e.changedTouches[0]; jTouchId = t.identifier;
      const rect = zone.getBoundingClientRect(); jStart = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    listen(zone, "touchmove", e => {
      for (const t of e.changedTouches) {
        if (t.identifier === jTouchId) {
          let dx = t.clientX - jStart.x, dy = t.clientY - jStart.y;
          const max = 45; const d = Math.hypot(dx, dy);
          if (d > max) { dx = dx / d * max; dy = dy / d * max; }
          knob.style.left = (37 + dx) + "px"; knob.style.top = (37 + dy) + "px";
          this.touchMove = { x: dx / max, y: dy / max };
        }
      }
      e.preventDefault();
    }, { passive: false });
    listen(zone, "touchend", () => { jTouchId = null; this.touchMove = { x: 0, y: 0 }; knob.style.left = "37px"; knob.style.top = "37px"; });

    const look = $("look-zone");
    let lTouchId = null, lastX = 0, lastY = 0;
    listen(look, "touchstart", e => {
      const t = e.changedTouches[0]; lTouchId = t.identifier; lastX = t.clientX; lastY = t.clientY;
    });
    listen(look, "touchmove", e => {
      for (const t of e.changedTouches) {
        if (t.identifier === lTouchId) {
          const dx = t.clientX - lastX, dy = t.clientY - lastY;
          lastX = t.clientX; lastY = t.clientY;
          this.player.ry -= dx * 0.004;
          this.player.rx -= dy * 0.004;
          this.player.rx = Math.max(-1.2, Math.min(1.2, this.player.rx));
          if (this.activeCore) this.checkCoreTapAim();
        }
      }
      e.preventDefault();
    }, { passive: false });
    listen(look, "touchend", () => { lTouchId = null; });

    listen($("mobile-tag"), "touchstart", e => { e.preventDefault(); this.shoot(); });
    listen($("mobile-jump"), "touchstart", e => { e.preventDefault(); this.tryJump(); });
  }

  tryJump() {
    if (this.player.onGround) { this.player.jumpVel = 6.2; this.player.onGround = false; }
  }

  reload() {
    if (this.player.reloading || this.player.ammo >= this.player.maxAmmo || !this.player.alive) return;
    this.player.reloading = true;
    this.player.reloadDoneAt = performance.now() + 850;
  }

  /* ---------------- shooting ---------------- */
  shoot() {
    if (!this.player.alive || this.ended) return;
    const now = performance.now();
    if (this.player.reloading || now < this.player.nextShotAt) return;
    if (this.player.ammo <= 0) return;
    this.player.nextShotAt = now + (this.player.hasMega ? 130 : 190);
    this.player.ammo--;
    if (this.player.ammo === 0) this.reload();
    this.updateAmmoHUD();

    const raycaster = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    this.gunMuzzle.getWorldPosition(origin);
    const direction = new THREE.Vector3();
    three.camera.getWorldDirection(direction);
    raycaster.set(origin, direction);
    const wallHit = raycaster.intersectObjects(this.wallMeshes, true)[0];
    const maxDistance = wallHit ? wallHit.distance : 80;
    this.fireLaserVisual(origin, direction, maxDistance);

    // check hits against remote players
    let closestId = null, closestDist = Infinity;
    for (const id in this.remotePlayers) {
      const rp = this.remotePlayers[id];
      if (!rp.alive) continue;
      const target = new THREE.Vector3(rp.x, rp.y - 0.4, rp.z);
      const dist = raycaster.ray.distanceToPoint(target);
      const shotDistance = origin.distanceTo(target);
      if (dist < 0.9 && shotDistance < maxDistance && shotDistance < closestDist) { closestDist = shotDistance; closestId = id; }
    }
    if (closestId) {
      this.dealDamage(closestId, 1);
    }
  }

  fireLaserVisual(start, dir, distance) {
    const end = start.clone().add(dir.clone().multiplyScalar(distance));
    const color = this.player.hasMega ? 0xffd23f : 0x00f0ff;
    const points = [start, end];
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const glowGeo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
    const glowMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22, linewidth: 4 });
    const line = new THREE.Line(geo, mat);
    const glow = new THREE.Line(glowGeo, glowMat);
    const boltMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 });
    const bolt = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), boltMat);
    bolt.position.copy(start);
    three.scene.add(glow, line, bolt);
    const flash = $("muzzle-flash");
    flash.classList.remove("firing");
    void flash.offsetWidth;
    flash.classList.add("firing");
    const started = performance.now();
    const animateBeam = now => {
      const progress = Math.min(1, (now - started) / 220);
      mat.opacity = 1 - progress;
      glowMat.opacity = 0.22 * (1 - progress);
      bolt.position.lerpVectors(start, end, Math.min(1, progress * 1.2));
      boltMat.opacity = 1 - progress;
      if (progress < 1 && !this.disposed) requestAnimationFrame(animateBeam);
      else {
        three.scene.remove(line, glow, bolt);
        geo.dispose(); glowGeo.dispose(); mat.dispose(); glowMat.dispose(); bolt.geometry.dispose(); boltMat.dispose();
      }
    };
    requestAnimationFrame(animateBeam);
  }

  dealDamage(targetId, amount) {
    // send tag event; authoritative resolution happens wherever the target's "home" is —
    // for simplicity every client resolves its own hp locally from tag events addressed to it,
    // and the host relays so everyone stays roughly in sync.
    const msg = { t: "tag", from: this.myId, fromName: this.myName, to: targetId, amount };
    if (targetId.startsWith("bot_")) {
      if (this.mode !== "client") this.applyTagToBot(targetId, this.myId, this.myName, amount);
      if (this.mode === "host") Net.broadcast(msg);
    } else {
      Net.broadcast(msg);
      if (this.mode === "host") this.handleNetMessage(this.myId, msg); // host applies immediately too
    }
    save.tags++; saveSave(); refreshStatsStrip();
  }

  applyTagToBot(botId, fromId, fromName, amount) {
    const b = this.bots[botId]; if (!b || !b.alive) return;
    b.hp -= amount;
    if (b.hp <= 0) {
      b.hp = 0; b.alive = false;
      if (fromId === this.myId) this.addScore(1);
      else if (this.bots[fromId]) this.bots[fromId].score = (this.bots[fromId].score || 0) + 1;
      this.addKillfeed(`${fromName} eliminated ${b.name}`);
      b.respawnAt = this.gameMode === "score" ? performance.now() + 1800 : 0;
    }
    const rp = this.remotePlayers[botId];
    if (rp) rp.applyState({ x: b.x, y: 1.6, z: b.z, ry: b.ry, hp: b.hp, alive: b.alive, hasMega: false });
    if (this.mode === "host") Net.broadcast({ t: "botstate", id: botId, x: b.x, y: 1.6, z: b.z, ry: b.ry, hp: b.hp, alive: b.alive, score: b.score || 0, name: b.name });
    if (this.gameMode === "battle") this.checkWinCondition();
  }

  /* ---------------- power cores ---------------- */
  tryOpenNearestCore() {
    if (this.activeCore) { this.resolveCoreClick(); return; }
    for (const id in this.cores) {
      const c = this.cores[id];
      if (!c.active) continue;
      const d = Math.hypot(this.player.x - c.x, this.player.z - c.z);
      if (d < 3.2) { this.openCore(id); return; }
    }
  }
  openCore(id) {
    this.activeCore = { id, t0: performance.now(), duration: 2600, target: 0.35 + Math.random() * 0.4 };
    $("power-core-prompt").classList.remove("hidden");
    const targetArc = document.getElementById("core-ring-target");
    const off = 314 * (1 - this.activeCore.target);
    targetArc.style.strokeDasharray = `18 ${314 - 18}`;
    targetArc.style.transform = `rotate(${this.activeCore.target * 360}deg)`;
    targetArc.style.transformOrigin = "60px 60px";
  }
  resolveCoreClick() {
    const ac = this.activeCore; if (!ac) return;
    const elapsed = (performance.now() - ac.t0) / ac.duration;
    const progress = Math.min(1, elapsed);
    const hit = Math.abs(progress - ac.target) < 0.09;
    this.closeCore();
    if (hit) {
      Net.broadcast({ t: "core", id: ac.id, by: this.myId, byName: this.myName });
      if (this.mode === "host") this.handleNetMessage(this.myId, { t: "core", id: ac.id, by: this.myId, byName: this.myName });
      else this.grantCoreReward(true); // optimistic local reward on client while host confirms
    } else {
    }
  }
  closeCore() {
    this.activeCore = null;
    $("power-core-prompt").classList.add("hidden");
  }
  checkCoreTapAim() { /* mobile: tap already handled by shoot() while activeCore set */ }

  grantCoreReward(isMega) {
    if (Math.random() < 0.35 || isMega === true && false) { } // placeholder no-op to keep structure simple
    const giveMega = Math.random() < 0.3;
    if (giveMega) { this.player.hasMega = true; this.player.maxAmmo = 6; this.player.ammo = Math.min(6, this.player.ammo + 1); }
    else { this.player.hp = Math.min(10, this.player.hp + 1); }
    this.updateHeartsHUD(); this.updateAmmoHUD();
  }

  /* ---------------- hearts pickups ---------------- */
  checkHeartPickup() {
    for (const id in this.hearts) {
      const h = this.hearts[id];
      if (!h.active) continue;
      const d = Math.hypot(this.player.x - h.x, this.player.z - h.z);
      if (d < 1.1 && this.player.hp < 10) {
        h.active = false; h.mesh.visible = false;
        this.player.hp = Math.min(10, this.player.hp + 2);
        this.updateHeartsHUD();
        Net.broadcast({ t: "heart", id });
        setTimeout(() => { h.active = true; h.mesh.visible = true; }, 15000);
      }
    }
  }

  /* ---------------- bots ---------------- */
  spawnBots(n) {
    for (let i = 0; i < n; i++) {
      const id = "bot_" + i;
      const spawn = this.findSafeSpawn(3, id);
      const bot = {
        id, name: randomName().slice(0, 12), x: spawn.x, z: spawn.z, ry: Math.random() * Math.PI * 2,
        hp: 6, alive: true, target: null, wanderAngle: Math.random() * Math.PI * 2, cooldown: 0, shotCooldown: Math.random()
      };
      this.bots[id] = bot;
      const rp = new RemotePlayer(id, bot.name);
      three.scene.add(rp.mesh);
      this.remotePlayers[id] = rp;
    }
  }
  updateBots(dt) {
    if (this.mode === "client") return; // only host/solo simulate bots
    const syncBots = this.mode === "host" && performance.now() - this.lastBotSync > 120;
    if (syncBots) this.lastBotSync = performance.now();
    for (const id in this.bots) {
      const b = this.bots[id];
      if (!b.alive) {
        if (this.gameMode === "score" && b.respawnAt && performance.now() >= b.respawnAt) this.respawnBot(b);
        continue;
      }
      const target = this.findBotTarget(b);
      b.target = target ? target.id : null;
      let mvx = Math.cos(b.wanderAngle), mvz = Math.sin(b.wanderAngle);
      const distCenter = Math.hypot(b.x, b.z);
      let targetDistance = Infinity;
      if (target) {
        const dx = target.x - b.x, dz = target.z - b.z;
        targetDistance = Math.hypot(dx, dz);
        const inv = targetDistance || 1;
        const towardX = dx / inv, towardZ = dz / inv;
        const strafeX = -towardZ, strafeZ = towardX;
        const strafe = Math.sin(performance.now() * 0.001 + b.id.length) * 0.65;
        const approach = targetDistance > 9 ? 1 : targetDistance < 5 ? -0.7 : 0;
        mvx = towardX * approach + strafeX * strafe;
        mvz = towardZ * approach + strafeZ * strafe;
      } else {
        b.wanderAngle += (Math.random() - 0.5) * 0.6 * dt;
        mvx = Math.cos(b.wanderAngle); mvz = Math.sin(b.wanderAngle);
      }
      if (this.gameMode === "battle" && distCenter > this.zoneRadius * 0.85) { mvx = -b.x / Math.max(1, distCenter); mvz = -b.z / Math.max(1, distCenter); }
      const moveLength = Math.hypot(mvx, mvz) || 1;
      mvx /= moveLength; mvz /= moveLength;
      const speed = target ? 3.1 : 2.2;
      let nx = b.x + mvx * speed * dt, nz = b.z + mvz * speed * dt;
      if (!this.collidesWalls(nx, nz)) { b.x = nx; b.z = nz; }
      b.ry = Math.atan2(mvx, mvz);

      b.shotCooldown -= dt;
      if (target && targetDistance < 22 && b.shotCooldown <= 0 && this.botHasLineOfSight(b, target)) {
        b.shotCooldown = 1.2 + Math.random() * 0.9;
        if (Math.random() < 0.48) this.botShoot(b, target);
      }
      const rp = this.remotePlayers[id];
      rp.applyState({ x: b.x, y: 1.6, z: b.z, ry: b.ry, hp: b.hp, alive: b.alive, hasMega: false });
      if (syncBots) Net.broadcast({ t: "botstate", id, x: b.x, y: 1.6, z: b.z, ry: b.ry, hp: b.hp, alive: b.alive, hasMega: false, score: b.score || 0, name: b.name });
    }
  }

  findBotTarget(bot) {
    const candidates = [];
    if (this.player.alive) candidates.push({ id: this.myId, x: this.player.x, z: this.player.z });
    for (const id in this.remotePlayers) {
      const rp = this.remotePlayers[id];
      if (rp.alive && id !== bot.id) candidates.push({ id, x: rp.x, z: rp.z });
    }
    candidates.sort((a, b) => Math.hypot(a.x - bot.x, a.z - bot.z) - Math.hypot(b.x - bot.x, b.z - bot.z));
    return candidates[0] || null;
  }

  botHasLineOfSight(bot, target) {
    const origin = new THREE.Vector3(bot.x, 1.15, bot.z);
    const end = new THREE.Vector3(target.x, 1.15, target.z);
    const direction = end.clone().sub(origin);
    const distance = direction.length();
    direction.normalize();
    const hit = new THREE.Raycaster(origin, direction).intersectObjects(this.wallMeshes, true)[0];
    return !hit || hit.distance >= distance - 0.35;
  }

  botShoot(bot, target) {
    if (target.id === this.myId) {
      this.applyTagToLocal(1, bot.name, bot.id);
      return;
    }
    const message = { t: "tag", from: bot.id, fromName: bot.name, to: target.id, amount: 1 };
    if (target.id.startsWith("bot_")) {
      if (this.mode === "host" || this.mode === "solo") this.applyTagToBot(target.id, bot.id, bot.name, 1);
      if (this.mode === "host") Net.broadcast(message);
    } else {
      this.handleNetMessage(bot.id, message);
    }
  }

  applyTagToLocal(amount, fromName, fromId) {
    if (!this.player.alive) return;
    this.player.hp -= amount;
    this.updateHeartsHUD();
    if (this.player.hp <= 0) {
      this.player.hp = 0; this.player.alive = false;
      this.addKillfeed(`${fromName} eliminated you`);
      this.deaths++;
      if (fromId && fromId !== this.myId && this.gameMode === "score") {
        const attacker = this.remotePlayers[fromId];
        if (attacker) attacker.score = (attacker.score || 0) + 1;
      }
      this.enterSpectator(fromId, fromName);
      if (this.gameMode === "battle") this.checkWinCondition();
    }
  }

  enterSpectator(killerId, killerName) {
    this.spectating = true;
    gameScreen.classList.add("spectating");
    // Release the mouse the instant you die — otherwise the pointer stays
    // locked to the canvas and the death menu's buttons (RESPAWN, WATCH
    // MATCH, etc.) can't actually be clicked, which is what pushed people
    // toward Escape (see togglePause) as the only way to do anything.
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.gunGrp) this.gunGrp.visible = false;
    this.spectatorTarget = killerId && this.remotePlayers[killerId] ? killerId : null;
    if (!this.spectatorTarget) {
      let nearestId = null, nearestDistance = Infinity;
      for (const id in this.remotePlayers) {
        const candidate = this.remotePlayers[id];
        if (!candidate.alive) continue;
        const distance = Math.hypot(candidate.x - this.player.x, candidate.z - this.player.z);
        if (distance < nearestDistance) { nearestDistance = distance; nearestId = id; }
      }
      this.spectatorTarget = nearestId;
    }
    this.spectatorYaw = this.spectatorTarget && this.remotePlayers[this.spectatorTarget]
      ? this.remotePlayers[this.spectatorTarget].ry : this.player.ry;
    this.spectatorEndsAt = performance.now() + 2000;
    $("death-title").textContent = this.gameMode === "battle" ? "You were eliminated" : "You were tagged";
    $("death-subtitle").textContent = killerName ? `Following ${killerName}...` : "Following the action...";
    $("death-menu").classList.add("hidden");
  }

  showDeathMenu() {
    if (this.deathMenuShown || this.gameMode === "battle") return;
    this.deathMenuShown = true;
    $("death-menu").classList.remove("hidden");
    $("death-subtitle").textContent = "Choose what to do next";
    $("death-respawn").onclick = () => {
      this.spectating = false;
      this.deathMenuShown = false;
      gameScreen.classList.remove("spectating");
      $("death-menu").classList.add("hidden");
      if (this.gunGrp) this.gunGrp.visible = true;
      this.respawnLocal();
    };
    $("death-watch").onclick = () => {
      this.deathMenuShown = true;
      $("death-menu").classList.add("hidden");
      this.spectatorEndsAt = Number.POSITIVE_INFINITY;
      $("death-subtitle").textContent = "Watching the match...";
    };
    $("death-restart").onclick = () => {
      const mode = this.mode, bots = this.botCount, gameMode = this.gameMode;
      this.dispose(); returnToMenu();
      if (mode === "solo") startMatch("solo", { botCount: bots, gameMode });
    };
    $("death-menu-btn").onclick = () => { this.dispose(); returnToMenu(); };
    $("death-settings").onclick = () => instructionsScreen.classList.remove("hidden");
  }

  respawnBot(bot) {
    const spawn = this.findSafeSpawn(4, bot.id);
    bot.x = spawn.x; bot.z = spawn.z;
    bot.hp = 6; bot.alive = true; bot.respawnAt = 0;
    const rp = this.remotePlayers[bot.id];
    if (rp) rp.applyState({ x: bot.x, y: 1.6, z: bot.z, ry: bot.ry, hp: bot.hp, alive: true, hasMega: false });
    if (this.mode === "host") Net.broadcast({ t: "botstate", id: bot.id, x: bot.x, y: 1.6, z: bot.z, ry: bot.ry, hp: bot.hp, alive: true, score: bot.score || 0, name: bot.name });
  }

  respawnLocal() {
    const spawn = this.findSafeSpawn(4);
    this.player.x = spawn.x; this.player.z = spawn.z;
    this.player.y = this.getGroundHeight(this.player.x, this.player.z) + 1.6;
    this.player.hp = 6; this.player.alive = true; this.player.respawnAt = 0;
    this.updateHeartsHUD();
  }

  findSafeSpawn(minDistance = 0, ignoredBotId = null) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = this.layout.size * (0.28 + Math.random() * 0.48);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (this.collidesWalls(x, z)) continue;
      if (minDistance && Math.hypot(x - this.player.x, z - this.player.z) < minDistance) continue;
      let occupied = false;
      for (const id in this.bots) {
        if (id !== ignoredBotId && Math.hypot(x - this.bots[id].x, z - this.bots[id].z) < minDistance) { occupied = true; break; }
      }
      if (!occupied) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  /* ---------------- networking messages ---------------- */
  handleNetMessage(from, data) {
    switch (data.t) {
      case "state":
        this.ensureRemote(from, data.name).applyState(data);
        break;
      case "tag":
        if (data.to === this.myId) { this.applyTagToLocal(data.amount, data.fromName, data.from); if (this.mode === "host") Net.broadcast(data); }
        else if (this.mode === "host" && data.to.startsWith("bot_")) { this.applyTagToBot(data.to, data.from, data.fromName, data.amount); Net.broadcast(data); }
        else if (this.mode === "host" && !data.to.startsWith("bot_")) { Net.broadcast(data); }
        break;
      case "core":
        {
          const c = this.cores[data.id]; if (c && c.active) {
            c.active = false; c.mesh.visible = false;
            if (data.by === this.myId) this.grantCoreReward();
            if (this.mode === "host") Net.broadcast(data);
            setTimeout(() => { if (c) { c.active = true; c.mesh.visible = true; } }, 20000);
          }
        }
        break;
      case "heart":
        { const h = this.hearts[data.id]; if (h) { h.active = false; h.mesh.visible = false; setTimeout(() => { h.active = true; h.mesh.visible = true; }, 15000); } }
        break;
      case "botstate":
        this.ensureRemote(data.id, data.name).applyState(data);
        break;
      case "timer":
        this.timeLeft = data.left;
        this.zoneRadius = data.zone;
        this.zoneRing.scale.setScalar(this.zoneRadius);
        $("match-timer").textContent = formatTime(Math.max(0, this.timeLeft));
        break;
      case "matchend":
        this.onMatchEndMessage(data);
        break;
      case "join":
        this.ensureRemote(from, data.name);
        if (this.mode === "host") {
          Net.sendTo(from, { t: "welcome", seed: this.seed, botCount: Object.keys(this.bots).length });
        }
        break;
      case "start":
        startCountdownAndPlay(data.gameMode);
        break;
    }
  }
  ensureRemote(id, name) {
    if (!this.remotePlayers[id]) {
      const rp = new RemotePlayer(id, name || "Player");
      three.scene.add(rp.mesh);
      this.remotePlayers[id] = rp;
    }
    return this.remotePlayers[id];
  }
  removeRemote(id) {
    const rp = this.remotePlayers[id];
    if (rp) { three.scene.remove(rp.mesh); delete this.remotePlayers[id]; }
  }
  addKillfeed(text) {
    const el = document.createElement("div");
    el.className = "kill-row"; el.textContent = text;
    this.killfeedEl.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  /* ---------------- collision ---------------- */
  collidesWalls(x, z) {
    for (const w of this.layout.walls) {
      const cos = Math.cos(-w.ry), sin = Math.sin(-w.ry);
      const dx = x - w.x, dz = z - w.z;
      const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
      if (Math.abs(lx) < w.w / 2 + 0.4 && Math.abs(lz) < w.d / 2 + 0.4) return true;
    }
    for (const bunker of this.layout.bunkers) {
      const cos = Math.cos(-bunker.ry), sin = Math.sin(-bunker.ry);
      const dx = x - bunker.x, dz = z - bunker.z;
      const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
      const nearSide = Math.abs(lz) < 1.5 + 0.4 && (Math.abs(lx - 1.5) < 0.15 + 0.4 || Math.abs(lx + 1.5) < 0.15 + 0.4);
      const nearBack = Math.abs(lx) < 1.5 + 0.4 && Math.abs(lz + 1.5) < 0.15 + 0.4;
      if (nearSide || nearBack) return true;
    }
    return this.layout.size * 1.19 < Math.hypot(x, z);
  }

  getGroundHeight(x, z) {
    let height = 0;
    for (const ramp of this.layout.ramps) {
      const cos = Math.cos(-ramp.ry), sin = Math.sin(-ramp.ry);
      const dx = x - ramp.x, dz = z - ramp.z;
      const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
      if (Math.abs(lx) <= 2 && Math.abs(lz) <= 3) {
        height = Math.max(height, 1.4 - Math.sin(0.5) * lz + 0.12);
      }
    }
    return height;
  }

  /* ---------------- main loop ---------------- */
  animate(t) {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._lastT || now)) / 1000);
    this._lastT = now;

    if (this.player.reloading && now >= this.player.reloadDoneAt) {
      this.player.reloading = false;
      this.player.ammo = this.player.maxAmmo;
      this.updateAmmoHUD();
    }

    if (this.paused) {
      three.renderer.render(three.scene, three.camera);
      return;
    }

    this.updateLocalMovement(dt);
    this.updateBots(dt);
    this.animateRemotePlayers(now);
    this.checkHeartPickup();
    if (this.activeCore) {
      const ac = this.activeCore;
      const progress = Math.min(1, (now - ac.t0) / ac.duration);
      document.getElementById("core-ring-shrink").style.strokeDashoffset = 314 * progress;
      if (progress >= 1) this.closeCore();
    }

    if (this.mode !== "client" || true) { /* clients still tick own timer visually */ }
    if ((this.mode === "host" || this.mode === "solo") && this.started && !this.ended) {
      this.timeLeft -= dt;
      if (this.gameMode === "battle") this.zoneRadius = Math.max(6, this.layout.size * 1.6 * (this.timeLeft / this.matchLen));
      this.zoneRing.visible = this.gameMode === "battle";
      this.zoneRing.scale.setScalar(this.zoneRadius);
      if (this.gameMode === "battle" && Math.hypot(this.player.x, this.player.z) > this.zoneRadius && this.player.alive) {
        this.player.hp -= dt * 1.2;
        if (this.player.hp <= 0) {
          this.player.hp = 0; this.player.alive = false; this.addKillfeed("The zone eliminated you");
          this.deaths++;
          this.enterSpectator(null, "the zone");
          this.checkWinCondition();
        }
        this.updateHeartsHUD();
      }
      if (this.timeLeft <= 0) this.endMatch(false);
      $("match-timer").textContent = formatTime(Math.max(0, this.timeLeft));
      if (this.mode === "host" && now - this.lastTimerSent > 500) {
        this.lastTimerSent = now;
        Net.broadcast({ t: "timer", left: this.timeLeft, zone: this.zoneRadius });
      }
    }
    if (this.score !== this.lastScore) {
      this.lastScore = this.score;
      $("score-count").querySelector("strong").textContent = this.score;
    }
    const aliveCount = this.countAlive();
    if (aliveCount !== this.lastAliveCount) {
      this.lastAliveCount = aliveCount;
      $("alive-num").textContent = aliveCount;
    }

    // send own state
    if (now - this.lastSyncSent > 120) {
      this.lastSyncSent = now;
      Net.broadcast({ t: "state", name: this.myName, device: getDeviceId(), x: this.player.x, y: this.player.y, z: this.player.z, ry: this.player.ry, hp: this.player.hp, alive: this.player.alive, hasMega: this.player.hasMega, score: this.score });
    }

    if (this.spectating) {
      if (!this.spectatorTarget || !this.remotePlayers[this.spectatorTarget]?.alive) {
        const next = Object.keys(this.remotePlayers).find(id => this.remotePlayers[id].alive);
        if (next) {
          this.spectatorTarget = next;
          this.spectatorYaw = this.remotePlayers[next].ry;
        }
      }
      if (this.spectatorTarget && this.remotePlayers[this.spectatorTarget]) {
        const target = this.remotePlayers[this.spectatorTarget];
        const targetEye = new THREE.Vector3(target.x, target.y, target.z);
        three.camera.position.lerp(targetEye, Math.min(1, dt * 8));
        let yawDelta = target.ry - this.spectatorYaw;
        yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));
        this.spectatorYaw += yawDelta * Math.min(1, dt * 2.2);
        three.camera.rotation.set(0, this.spectatorYaw, 0, "YXZ");
      }
      if (now >= this.spectatorEndsAt) this.showDeathMenu();
    } else {
      three.camera.position.set(this.player.x, this.player.y, this.player.z);
      three.camera.rotation.set(this.player.rx, this.player.ry, 0, "YXZ");
    }

    three.renderer.render(three.scene, three.camera);
  }

  countAlive() {
    let n = this.player.alive ? 1 : 0;
    for (const id in this.remotePlayers) if (this.remotePlayers[id].alive) n++;
    return n;
  }

  animateRemotePlayers(now) {
    for (const id in this.remotePlayers) {
      const mesh = this.remotePlayers[id].mesh;
      const animation = mesh.userData.animation;
      if (!animation || !mesh.visible) continue;
      const stride = Math.sin(now * 0.009 + animation.phase) * 0.16;
      animation.leftArm.rotation.z = stride;
      animation.rightArm.rotation.z = -stride;
      animation.leftLeg.rotation.x = stride;
      animation.rightLeg.rotation.x = -stride;
      mesh.position.y = this.remotePlayers[id].y - 0.9 + Math.sin(now * 0.012 + animation.phase) * 0.015;
    }
  }

  addScore(points) {
    if (this.gameMode !== "score") return;
    this.score += points;
  }

  updateLocalMovement(dt) {
    if (!this.player.alive) {
      this.player.moveVelocity.x = 0;
      this.player.moveVelocity.z = 0;
      return;
    }
    let mx = 0, mz = 0;
    if (this.isTouch) {
      mx = this.touchMove.x; mz = this.touchMove.y;
    } else {
      if (this.keys["KeyW"] || this.keys["ArrowUp"]) mz -= 1;
      if (this.keys["KeyS"] || this.keys["ArrowDown"]) mz += 1;
      if (this.keys["KeyA"] || this.keys["ArrowLeft"]) mx -= 1;
      if (this.keys["KeyD"] || this.keys["ArrowRight"]) mx += 1;
      if (this.keys["Space"]) this.tryJump();
    }
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    // Three.js looks down local -Z. Build horizontal camera-relative axes so
    // W always moves toward the direction the player is looking.
    const sin = Math.sin(this.player.ry), cos = Math.cos(this.player.ry);
    const rightX = cos, rightZ = -sin;
    const forwardX = -sin, forwardZ = -cos;
    const desiredX = (mx * rightX - mz * forwardX) * this.player.speed;
    const desiredZ = (mx * rightZ - mz * forwardZ) * this.player.speed;
    const response = len > 0.05 ? 1 - Math.exp(-18 * dt) : 1 - Math.exp(-24 * dt);
    this.player.moveVelocity.x += (desiredX - this.player.moveVelocity.x) * response;
    this.player.moveVelocity.z += (desiredZ - this.player.moveVelocity.z) * response;
    const nx = this.player.x + this.player.moveVelocity.x * dt;
    const nz = this.player.z + this.player.moveVelocity.z * dt;
    if (!this.collidesWalls(nx, this.player.z)) this.player.x = nx;
    else this.player.moveVelocity.x = 0;
    if (!this.collidesWalls(this.player.x, nz)) this.player.z = nz;
    else this.player.moveVelocity.z = 0;
    // gravity/jump
    this.player.jumpVel -= 16 * dt;
    this.player.y += this.player.jumpVel * dt;
    const groundY = this.getGroundHeight(this.player.x, this.player.z) + 1.6;
    if (this.player.jumpVel <= 0 && this.player.y <= groundY) { this.player.y = groundY; this.player.jumpVel = 0; this.player.onGround = true; }
  }

  checkWinCondition() {
    if (this.mode === "client" || this.gameMode !== "battle") return;
    if (this.ended) return;
    const aliveIds = [];
    if (this.player.alive) aliveIds.push(this.myId);
    for (const id in this.remotePlayers) if (this.remotePlayers[id].alive) aliveIds.push(id);
    if (aliveIds.length <= 1) this.endMatch(true, aliveIds[0]);
  }

  endMatch(byElimination, winnerId) {
    if (this.ended) return;
    this.ended = true;
    let winnerName = "Nobody";
    if (this.gameMode === "score") {
      let best = { id: this.myId, name: this.myName, score: this.score };
      for (const id in this.remotePlayers) {
        const rp = this.remotePlayers[id];
        if (rp.score > best.score) best = { id, name: rp.name, score: rp.score };
      }
      winnerId = best.id; winnerName = best.name;
    } else if (byElimination && winnerId) {
      winnerName = winnerId === this.myId ? this.myName : (this.remotePlayers[winnerId] ? this.remotePlayers[winnerId].name : "Bot");
    } else {
      // time up: highest hp wins
      let best = { id: this.myId, name: this.myName, hp: this.player.hp, alive: this.player.alive };
      for (const id in this.remotePlayers) {
        const rp = this.remotePlayers[id];
        if (rp.alive && rp.hp > best.hp) best = { id, name: rp.name, hp: rp.hp, alive: true };
      }
      winnerId = best.id; winnerName = best.name;
    }
    if (this.mode === "host") Net.broadcast({ t: "matchend", winnerId, winnerName });
    this.onMatchEndMessage({ winnerId, winnerName });
  }

  onMatchEndMessage(data) {
    if (this.matchEndShown) return;
    this.matchEndShown = true;
    const iWon = data.winnerId === this.myId;
    const banner = $("banner");
    banner.classList.remove("hidden");
    const result = this.gameMode === "score" ? `${iWon ? "👑 YOU WIN!" : data.winnerName + " WINS"}<br><small>${iWon ? this.score : "FINAL"} KILLS</small>` : (iWon ? "👑 YOU WIN!" : data.winnerName + " WINS");
    banner.innerHTML = `<div class="title">${result}</div><div class="sub">${this.modeLabel} COMPLETE</div><button id="rematch-btn" class="primary-btn">${this.mode === "solo" ? "REMATCH" : "RETURN TO MENU"}</button>`;
    gameScreen.classList.add("match-ended");
    $("rematch-btn").addEventListener("click", () => {
      const rematchMode = this.mode;
      const rematchBots = this.botCount;
      const rematchGameMode = this.gameMode;
      this.dispose();
      returnToMenu();
      if (rematchMode === "solo") startMatch("solo", { botCount: rematchBots, gameMode: rematchGameMode });
    }, { once: true });
    save.matches++;
    if (iWon) { save.crowns++; save.wins++; }
    save.history.push({ win: iWon, mode: this.gameMode, date: new Date().toLocaleDateString() });
    saveSave(); refreshStatsStrip();
    document.exitPointerLock && document.exitPointerLock();
  }

  dispose() {
    this.disposed = true;
    gameScreen.classList.remove("spectating");
    gameScreen.classList.remove("paused");
    if (this.controlCleanups) this.controlCleanups.splice(0).forEach(cleanup => cleanup());
    if (this.resizeHandler) removeEventListener("resize", this.resizeHandler);
    three.scene && three.scene.traverse(object => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => {
          if (material.map) material.map.dispose();
          material.dispose();
        });
      }
    });
    if (three.renderer) { three.renderer.dispose(); }
  }
}

function formatTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ":" + (sec < 10 ? "0" : "") + sec;
}

/* ============================================================
   FLOW CONTROL — menu buttons -> starting matches
   ============================================================ */
let pendingRoomCode = null;
let lobbyDiscovery = null;
let lobbyCache = {}; // code -> full lobby record, so partial patches don't wipe out fields

function setLoading(id, loading) { $(id).classList.toggle("hidden", !loading); }
function renderLobbyMember(id, name) {
  const existing = document.querySelector(`[data-member-id="${id}"]`);
  if (existing) return;
  const row = document.createElement("div");
  row.className = "member-row"; row.dataset.memberId = id;
  const label = document.createElement("span"); label.textContent = name || "Player"; row.appendChild(label);
  if (Net.isHost && id !== Net.myId) {
    const actions = document.createElement("span"); actions.className = "member-actions";
    ["kicked", "banned"].forEach(action => { const button = document.createElement("button"); button.textContent = action.toUpperCase(); button.onclick = () => Net.moderate(id, action); actions.appendChild(button); });
    row.appendChild(actions);
  }
  $("lobby-list").appendChild(row);
  $("join-lobby-players").appendChild(row.cloneNode(true));
}
function removeLobbyMember(id) { document.querySelectorAll(`[data-member-id="${id}"]`).forEach(row => row.remove()); }
function startLobbyDiscovery() {
  if (lobbyDiscovery) return;
  lobbyDiscovery = Firebase.listen("lobbies", (type, path, data) => {
    if (path === "/") {
      lobbyCache = {};
      $("public-lobbies").replaceChildren();
      if (data) Object.entries(data).forEach(([code, val]) => {
        lobbyCache[code] = { ...val, code };
        renderPublicLobby(lobbyCache[code]);
      });
      return;
    }
    const code = path.slice(1);
    if (data === null) {
      delete lobbyCache[code];
      $("public-lobbies").querySelector(`[data-lobby-code="${code}"]`)?.remove();
      return;
    }
    // merge the patch onto whatever we already know about this lobby, so a
    // partial write (e.g. just {public, private}) doesn't blow away fields
    // like code/name/players and spawn a duplicate "undefined" card.
    lobbyCache[code] = { ...(lobbyCache[code] || {}), ...data, code };
    renderPublicLobby(lobbyCache[code]);
  });
}
function renderPublicLobby(lobby) {
  if (!lobby || !lobby.code) return;
  const list = $("public-lobbies");
  // never list/offer-join your own lobby
  if (Net.isHost && lobby.hostId === Net.myId) {
    list.querySelector(`[data-lobby-code="${lobby.code}"]`)?.remove();
    return;
  }
  if (lobby.started) {
    list.querySelector(`[data-lobby-code="${lobby.code}"]`)?.remove();
    return;
  }
  let card = list.querySelector(`[data-lobby-code="${lobby.code}"]`);
  if (!card) { card = document.createElement("div"); card.className = "lobby-card"; card.dataset.lobbyCode = lobby.code; list.appendChild(card); }

  // rebuilt every render from the current privacy flag, so a public lobby
  // that just went private can never keep a stale "auto-join" handler.
  const isPrivate = !!lobby.private;
  card.innerHTML = `<div><strong>${isPrivate ? "🔒 " : ""}${lobby.name || "Open Lobby"}</strong><small>${lobby.players || 1} player${lobby.players === 1 ? "" : "s"}</small></div>`;
  const join = document.createElement("button");
  join.className = "primary-btn";
  join.textContent = isPrivate ? "ENTER CODE" : "JOIN";
  join.onclick = () => {
    if (isPrivate) {
      $("join-code").value = "";
      $("join-code").focus();
      $("join-status").textContent = "Enter the host's private 5-character code.";
    } else {
      $("join-code").value = lobby.code;
      $("join-status").textContent = "Joining lobby...";
      $("join-btn").click();
    }
  };
  card.appendChild(join);
}
function refreshBanList() {
  if (!Net.isHost || !Net.roomCode) return;
  Firebase.get(`rooms/${Net.roomCode}/bans`).then(bans => {
    const list = $("banned-list"); list.replaceChildren();
    if (!bans) return;
    Object.keys(bans).forEach(id => {
      const row = document.createElement("div"); row.className = "member-row";
      row.innerHTML = `<span>Banned player ${id.slice(-5)}</span>`;
      const button = document.createElement("button"); button.className = "text-btn"; button.textContent = "UNBAN";
      button.onclick = () => Firebase.remove(`rooms/${Net.roomCode}/bans/${id}`).then(refreshBanList);
      row.appendChild(button); list.appendChild(row);
    });
  });
}

document.querySelector('[data-tab="join"]').addEventListener("click", startLobbyDiscovery);

$("host-btn").addEventListener("click", () => {
  $("host-btn").disabled = true;
  setLoading("host-loading", true);
  const visibility = $("lobby-visibility").value;
  Net.onPeerJoin = (peerId, name) => renderLobbyMember(peerId, name);
  Net.onPeerLeave = peerId => removeLobbyMember(peerId);
  Net.initHost({ visibility }, code => {
    setLoading("host-loading", false);
    $("host-hint").textContent = "Lobby ready. Share the code or wait for players.";
    $("host-code").textContent = code;
    $("host-code-wrap").classList.remove("hidden");
    $("host-btn").classList.add("hidden");
    $("lobby-list").replaceChildren();
    renderLobbyMember(Net.myId, save.name);
    refreshBanList();
  });
});
function addLobbyChip(name) {
  const chip = document.createElement("div");
  chip.className = "lobby-chip"; chip.textContent = name;
  $("lobby-list").appendChild(chip);
}
$("start-match-btn").addEventListener("click", () => {
  const seed = Math.floor(Math.random() * 1e9);
  const gameMode = $("game-mode").value;
  window._hostSeed = seed;
  Firebase.patch(`rooms/${Net.roomCode}/meta`, { started: true });
  Firebase.remove(`lobbies/${Net.roomCode}`);
  Net.broadcast({ t: "start", seed, gameMode });
  startCountdownAndPlay(gameMode);
});

$("join-btn").addEventListener("click", () => {
  const code = $("join-code").value.trim().toUpperCase();
  if (!code) return;
  $("join-status").textContent = "Connecting…";
  setLoading("join-loading", true);
  Net.onPeerJoin = (peerId, name) => renderLobbyMember(peerId, name);
  Net.onPeerLeave = peerId => removeLobbyMember(peerId);
  Net.initClient(code, save.name, id => {
    setLoading("join-loading", false);
    $("join-status").textContent = "Connected! Waiting for host to start…";
    renderLobbyMember(Net.myId, save.name);
    // active before the Game object exists, so we can hear the host's "start" signal
    Net.onMessage = (from, data) => {
      if (data.t === "start") { window._joinSeed = data.seed; window._joinMode = data.gameMode; startCountdownAndPlay(data.gameMode); }
      if (data.t === "kicked" || data.t === "banned") { $("join-status").textContent = data.t === "banned" ? "You are banned from this lobby." : "You were removed from this lobby."; returnToMenu(); }
    };
  }, err => {
    setLoading("join-loading", false);
    $("join-status").textContent = "Couldn't connect — check the code.";
  });
});

$("lobby-visibility").addEventListener("change", e => Net.setLobbyVisibility(e.target.value));
$("hide-room-code").addEventListener("click", e => {
  const hidden = e.currentTarget.dataset.hidden === "true";
  e.currentTarget.dataset.hidden = String(!hidden);
  e.currentTarget.textContent = hidden ? "HIDE" : "SHOW";
  $("host-code").style.visibility = hidden ? "visible" : "hidden";
});
$("leave-room-btn").addEventListener("click", () => { if (game) game.dispose(); returnToMenu(); });

$("solo-btn").addEventListener("click", () => {
  startMatch("solo", { botCount: parseInt($("bot-count").value, 10), gameMode: $("game-mode").value });
});

function startCountdownAndPlay(gameMode = $("game-mode").value) {
  if (Net.isHost) startMatch("host", { botCount: 0, gameMode });
  else startMatch("client", { gameMode });
}

function startMatch(mode, opts) {
  menuScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  gameScreen.classList.remove("match-ended");
  gameScreen.classList.remove("spectating");
  gameScreen.classList.remove("paused");
  $("pause-menu").classList.add("hidden");
  $("banner").classList.add("hidden");
  $("killfeed").innerHTML = "";
  const seed = mode === "client" ? (window._joinSeed || Math.floor(Math.random() * 1e9))
    : mode === "host" ? (window._hostSeed || Math.floor(Math.random() * 1e9))
      : Math.floor(Math.random() * 1e9);
  game = new Game({ mode, myId: Net.myId || "solo-" + Math.random().toString(36).slice(2), seed, botCount: opts.botCount || 0, gameMode: opts.gameMode || "battle" });
  game.started = true;
  if (mode !== "client") game.timeLeft = game.matchLen;
  $("arena-code-badge").querySelector("strong").textContent = `${game.modeLabel} / ${Net.isHost ? "ROOM " + $("host-code").textContent : (mode === "client" ? "ONLINE" : "SOLO")}`;
}

function returnToMenu() {
  gameScreen.classList.remove("match-ended");
  gameScreen.classList.remove("spectating");
  $("death-menu").classList.add("hidden");
  gameScreen.classList.add("hidden");
  menuScreen.classList.remove("hidden");
  $("host-code-wrap").classList.add("hidden");
  $("host-btn").classList.remove("hidden");
  $("lobby-list").innerHTML = "";
  $("join-lobby-players").innerHTML = "";
  $("banned-list").innerHTML = "";
  $("host-btn").disabled = false;
  $("join-status").textContent = "";
  Net.leaveRoom();
  refreshStatsStrip();
}

function leaveMatch() {
  if (game) { game.dispose(); }
  returnToMenu();
}

addEventListener("beforeunload", () => { Net.leaveRoom(); });
