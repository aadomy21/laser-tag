/* ============================================================
   NEON TAG — a laser-tag battle royale in the browser
   Three.js for 3D, PeerJS (WebRTC) for peer-to-peer multiplayer.
   Host is authoritative for hearts / power cores / bots / timer.
   ============================================================ */

/* ---------------- Persistent local data ---------------- */
const SAVE_KEY = "neontag_save_v1";
function loadSave(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return { name: randomName(), crowns:0, matches:0, tags:0, wins:0, history:[] };
}
function saveSave(){
  localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  // best-effort cloud backup, so crowns/stats survive clearing browser data
  fetch(`${FIREBASE_DB_URL}/players_backup/${getDeviceId()}.json`, {method:"PUT", body:JSON.stringify(save)}).catch(()=>{});
}
function getDeviceId(){
  let id = localStorage.getItem("neontag_device_id");
  if(!id){ id = "d"+Math.random().toString(36).slice(2,12); localStorage.setItem("neontag_device_id", id); }
  return id;
}
let save = loadSave();

const WORDS_A = ["Turbo","Neon","Cosmic","Rapid","Shadow","Blazing","Frosty","Rogue","Silent","Cyber","Solar","Lunar","Wild","Electric","Sneaky","Mighty","Jumpy","Glowing","Rocket","Pixel"];
const WORDS_B = ["Fox","Falcon","Otter","Comet","Panda","Wolf","Tiger","Hawk","Ninja","Robot","Dragon","Phoenix","Shark","Yeti","Viper","Badger","Raccoon","Cheetah","Griffin","Koala"];
const WORDS_C = ["Blaster","Dash","Spark","Bolt","Glide","Storm","Flash","Zoom","Beam","Strike","Nova","Drift","Ranger","Pulse","Rush"];
function randomName(){
  const r = a => a[Math.floor(Math.random()*a.length)];
  return `${r(WORDS_A)}${r(WORDS_B)}${r(WORDS_C)}`;
}

/* ---------------- DOM refs ---------------- */
const $ = id => document.getElementById(id);
const menuScreen = $("menu-screen"), gameScreen = $("game-screen");
const instructionsScreen = $("instructions-screen"), progressScreen = $("progress-screen");

/* ---------- menu wiring ---------- */
$("player-name").value = save.name;
$("player-name").addEventListener("change", e=>{ save.name = e.target.value.trim() || randomName(); saveSave(); });
$("randomize-name").addEventListener("click", ()=>{ save.name = randomName(); $("player-name").value = save.name; saveSave(); });

function refreshStatsStrip(){
  $("stat-crowns").textContent = save.crowns;
  $("stat-matches").textContent = save.matches;
  $("stat-tags").textContent = save.tags;
}
refreshStatsStrip();

document.querySelectorAll(".tab-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p=>p.classList.add("hidden"));
    btn.classList.add("active");
    $("tab-"+btn.dataset.tab).classList.remove("hidden");
  });
});

$("instructions-btn").addEventListener("click", ()=> instructionsScreen.classList.remove("hidden"));
$("close-instructions").addEventListener("click", ()=> instructionsScreen.classList.add("hidden"));

$("progress-btn").addEventListener("click", ()=>{
  $("p-crowns").textContent = save.crowns;
  $("p-matches").textContent = save.matches;
  $("p-tags").textContent = save.tags;
  const rate = save.matches ? Math.round(100*save.wins/save.matches) : 0;
  $("p-winrate").textContent = rate+"%";
  const hist = $("p-history"); hist.innerHTML = "";
  if(!save.history.length){ hist.innerHTML = '<div class="hint">No matches yet — go play!</div>'; }
  save.history.slice().reverse().slice(0,20).forEach(h=>{
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `<span class="${h.win?'win':''}">${h.win?'👑 ':''}${h.place ? '#'+h.place : ''} ${h.mode}</span><span>${h.date}</span>`;
    hist.appendChild(row);
  });
  progressScreen.classList.remove("hidden");
});
$("close-progress").addEventListener("click", ()=> progressScreen.classList.add("hidden"));

$("bot-count").addEventListener("input", e=> $("bot-count-val").textContent = e.target.value);

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

const Firebase = {
  put(path, data){ return fetch(`${FIREBASE_DB_URL}/${path}.json`, {method:"PUT", body:JSON.stringify(data)}).catch(()=>{}); },
  patch(path, data){ return fetch(`${FIREBASE_DB_URL}/${path}.json`, {method:"PATCH", body:JSON.stringify(data)}).catch(()=>{}); },
  post(path, data){ return fetch(`${FIREBASE_DB_URL}/${path}.json`, {method:"POST", body:JSON.stringify(data)}).then(r=>r.json()).catch(()=>{}); },
  get(path){ return fetch(`${FIREBASE_DB_URL}/${path}.json`).then(r=>r.json()).catch(()=>null); },
  remove(path){ return fetch(`${FIREBASE_DB_URL}/${path}.json`, {method:"DELETE"}).catch(()=>{}); },
  listen(path, onEvent){
    const es = new EventSource(`${FIREBASE_DB_URL}/${path}.json`);
    const handle = type => e=>{
      try{ const {path, data} = JSON.parse(e.data); onEvent(type, path, data); }catch(err){}
    };
    es.addEventListener("put", handle("put"));
    es.addEventListener("patch", handle("patch"));
    es.onerror = ()=>{}; // EventSource auto-reconnects; ignore transient errors
    return es;
  }
};

const Net = {
  isHost:false, myId:null, roomCode:null, sessionStart:0,
  playersEs:null, eventsEs:null, knownPlayerIds:null,
  onMessage:null, // callback(fromId, data)
  onPeerJoin:null, onPeerLeave:null,

  initHost(cb){
    this.isHost = true;
    this.myId = "p"+Math.random().toString(36).slice(2,10);
    this.roomCode = genRoomCode();
    this.sessionStart = Date.now();
    this.knownPlayerIds = new Set();
    Firebase.put(`rooms/${this.roomCode}/meta`, {hostId:this.myId, createdAt:this.sessionStart, started:false})
      .then(()=>{ this._startListening(); cb(this.roomCode); });
  },

  initClient(roomCode, myName, cb, errCb){
    this.isHost = false;
    this.myId = "p"+Math.random().toString(36).slice(2,10);
    this.roomCode = roomCode;
    this.sessionStart = Date.now();
    this.knownPlayerIds = new Set();
    Firebase.get(`rooms/${roomCode}/meta`).then(meta=>{
      if(!meta){ errCb && errCb(new Error("Room not found")); return; }
      this._startListening();
      // lobby presence write so the host sees this player in the room list
      Firebase.put(`rooms/${roomCode}/players/${this.myId}`, {name:myName, x:0,y:1.6,z:0,ry:0,hp:6,alive:true,hasMega:false})
        .then(()=> cb(this.myId));
    }).catch(e=> errCb && errCb(e));
  },

  _startListening(){
    const room = this.roomCode;
    this.playersEs = Firebase.listen(`rooms/${room}/players`, (type, path, data)=>{
      if(path === "/"){
        if(!data) return;
        for(const id in data){
          if(id===this.myId) continue;
          const isNew = !this.knownPlayerIds.has(id);
          this.knownPlayerIds.add(id);
          if(isNew && this.onPeerJoin) this.onPeerJoin(id, data[id].name);
          if(this.onMessage) this.onMessage(id, {t:"state", ...data[id]});
        }
      } else {
        const id = path.slice(1);
        if(id===this.myId) return;
        if(data===null){
          if(this.knownPlayerIds.has(id)){ this.knownPlayerIds.delete(id); if(this.onPeerLeave) this.onPeerLeave(id); }
          return;
        }
        const isNew = !this.knownPlayerIds.has(id);
        this.knownPlayerIds.add(id);
        if(isNew && this.onPeerJoin) this.onPeerJoin(id, data.name);
        if(this.onMessage) this.onMessage(id, {t:"state", ...data});
      }
    });
    this.eventsEs = Firebase.listen(`rooms/${room}/events`, (type, path, data)=>{
      if(path === "/"){
        if(!data) return;
        Object.values(data).forEach(ev=> this._handleEvent(ev));
      } else {
        if(data) this._handleEvent(data);
      }
    });
  },
  _handleEvent(ev){
    if(!ev || ev._from===this.myId) return;
    if(ev._to && ev._to!==this.myId) return;
    if(this.onMessage) this.onMessage(ev._from, ev);
  },

  // "state"/"botstate" go to the live players map (overwritten, not appended).
  // Everything else is a one-off event appended to the events feed.
  broadcast(data){
    if(!this.roomCode) return;
    if(data.t==="state"){
      Firebase.put(`rooms/${this.roomCode}/players/${this.myId}`, data);
    } else if(data.t==="botstate"){
      Firebase.put(`rooms/${this.roomCode}/players/${data.id}`, data);
    } else {
      Firebase.post(`rooms/${this.roomCode}/events`, {...data, _from:this.myId, _ts:Date.now()});
    }
  },
  sendTo(id, data){
    if(!this.roomCode) return;
    Firebase.post(`rooms/${this.roomCode}/events`, {...data, _from:this.myId, _to:id, _ts:Date.now()});
  },

  leaveRoom(){
    if(this.playersEs){ this.playersEs.close(); this.playersEs=null; }
    if(this.eventsEs){ this.eventsEs.close(); this.eventsEs=null; }
    if(this.roomCode && this.myId) Firebase.remove(`rooms/${this.roomCode}/players/${this.myId}`);
    if(this.isHost && this.roomCode) Firebase.remove(`rooms/${this.roomCode}`);
    this.roomCode = null; this.isHost = false;
  }
};
function genRoomCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for(let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

/* ============================================================
   GAME STATE
   ============================================================ */
let three = {}; // scene, camera, renderer
let game = null; // active Game instance

class RemotePlayer{
  constructor(id,name){
    this.id=id; this.name=name; this.hp=6; this.alive=true; this.hasMega=false;
    this.x=0;this.y=1.6;this.z=0;this.ry=0;
    this.mesh = makePlayerMesh(name);
  }
  applyState(s){
    this.x=s.x; this.y=s.y; this.z=s.z; this.ry=s.ry; this.hp=s.hp; this.alive=s.alive; this.hasMega=s.hasMega;
    this.mesh.position.set(this.x, this.y-0.9, this.z);
    this.mesh.rotation.y = this.ry;
    this.mesh.visible = this.alive;
    const bar = this.mesh.userData.hpFill;
    if(bar) bar.scale.x = Math.max(0.001, this.hp/10);
  }
}

function makePlayerMesh(name){
  const group = new THREE.Group();
  const bodyColor = new THREE.Color().setHSL(Math.random(),0.7,0.55);
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 0.9, 4, 8),
    new THREE.MeshStandardMaterial({color:bodyColor, emissive:bodyColor, emissiveIntensity:0.3})
  );
  body.position.y = 0.9;
  group.add(body);

  // name tag via sprite
  const canvas = document.createElement("canvas");
  canvas.width=256; canvas.height=64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle="rgba(8,10,20,0.6)"; ctx.fillRect(0,0,256,64);
  ctx.font="bold 34px Rajdhani, sans-serif"; ctx.fillStyle="#00f0ff"; ctx.textAlign="center";
  ctx.fillText(name.slice(0,16), 128, 42);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, depthTest:false}));
  sprite.scale.set(2,0.5,1);
  sprite.position.y = 2.15;
  group.add(sprite);

  // hp bar above head
  const barBg = new THREE.Mesh(new THREE.PlaneGeometry(1,0.08), new THREE.MeshBasicMaterial({color:0x222233}));
  barBg.position.y = 1.85; group.add(barBg);
  const barFill = new THREE.Mesh(new THREE.PlaneGeometry(1,0.08), new THREE.MeshBasicMaterial({color:0xff2e88}));
  barFill.position.y = 1.85; barFill.position.z = 0.001; group.add(barFill);
  group.userData.hpFill = barFill;

  return group;
}

/* ============================================================
   ARENA GENERATION
   ============================================================ */
function generateArena(seed){
  const rand = mulberry32(seed);
  const size = 40; // half-extent
  const cell = 4;
  const cells = Math.floor((size*2)/cell);
  const layout = { walls:[], hearts:[], cores:[], ramps:[], bunkers:[], size };

  for(let ix=0; ix<cells; ix++){
    for(let iz=0; iz<cells; iz++){
      const x = -size + ix*cell + cell/2;
      const z = -size + iz*cell + cell/2;
      const distCenter = Math.hypot(x,z);
      if(distCenter < 7) continue; // keep spawn-ish center clearer
      if(rand() < 0.22){
        const h = 2 + rand()*3;
        const w = cell*(0.5+rand()*0.4);
        layout.walls.push({x,z,w,h,d:w, ry: rand()<0.3 ? Math.PI/4 : 0});
      }
    }
  }
  // border walls
  const b = size;
  layout.walls.push({x:0,z:-b,w:b*2,h:6,d:1,ry:0});
  layout.walls.push({x:0,z:b,w:b*2,h:6,d:1,ry:0});
  layout.walls.push({x:-b,z:0,w:1,h:6,d:b*2,ry:0});
  layout.walls.push({x:b,z:0,w:1,h:6,d:b*2,ry:0});

  // ramps (blue, angled boxes leaning against tall walls)
  for(let i=0;i<6;i++){
    const ang = (i/6)*Math.PI*2;
    const r = 20+rand()*10;
    layout.ramps.push({x:Math.cos(ang)*r, z:Math.sin(ang)*r, ry:ang+Math.PI/2});
  }

  // bunkers (3-sided cover)
  for(let i=0;i<8;i++){
    layout.bunkers.push({x:(rand()-0.5)*size*1.6, z:(rand()-0.5)*size*1.6, ry:rand()*Math.PI*2});
  }

  // hearts
  for(let i=0;i<14;i++){
    layout.hearts.push({id:"h"+i, x:(rand()-0.5)*size*1.7, z:(rand()-0.5)*size*1.7, active:true});
  }
  // power cores
  for(let i=0;i<6;i++){
    const ang=(i/6)*Math.PI*2;
    const r = 12+rand()*14;
    layout.cores.push({id:"c"+i, x:Math.cos(ang)*r, z:Math.sin(ang)*r, active:true});
  }
  return layout;
}
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

/* ============================================================
   MAIN GAME CLASS
   ============================================================ */
class Game{
  constructor(opts){
    this.mode = opts.mode; // "solo" | "host" | "client"
    this.myName = save.name;
    this.myId = opts.myId || "local";
    this.botCount = opts.botCount || 0;
    this.seed = opts.seed || Math.floor(Math.random()*1e9);
    this.layout = generateArena(this.seed);
    this.matchLen = 150; // 2:30
    this.timeLeft = this.matchLen;
    this.started = false;
    this.ended = false;
    this.remotePlayers = {}; // id -> RemotePlayer (includes bots on non-host? no: only host simulates bots)
    this.bots = {}; // id -> bot state, host only
    this.hearts = {}; this.cores = {};
    this.zoneRadius = this.layout.size*1.6;
    this.killfeedEl = $("killfeed");
    this.lastSyncSent = 0;
    this.activeCore = null; // {id, progress, deadline}
    this.setupScene();
    this.setupLocalPlayer();
    this.setupControls();
    this.setupPickupsAndCores();

    if(this.mode==="host") this.spawnBots(this.botCount);
    if(this.mode==="solo") this.spawnBots(this.botCount);

    Net.onMessage = (from, data)=> this.handleNetMessage(from, data);
    Net.onPeerLeave = (id)=> this.removeRemote(id);

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  /* ---------------- scene ---------------- */
  setupScene(){
    const canvas = $("game-canvas");
    const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    renderer.setSize(innerWidth, innerHeight);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060d);
    scene.fog = new THREE.FogExp2(0x05060d, 0.012);
    const camera = new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.1, 500);
    three = {renderer, scene, camera};

    scene.add(new THREE.HemisphereLight(0x8899ff, 0x0a0a12, 0.7));
    const dl = new THREE.DirectionalLight(0x9fd8ff, 0.5);
    dl.position.set(30,50,10); scene.add(dl);

    // floor
    const floorMat = new THREE.MeshStandardMaterial({color:0x0d1226, roughness:0.9});
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(this.layout.size*2.4, this.layout.size*2.4), floorMat);
    floor.rotation.x = -Math.PI/2;
    scene.add(floor);
    // grid glow lines
    const grid = new THREE.GridHelper(this.layout.size*2.4, 48, 0x00f0ff, 0x1a2440);
    grid.material.opacity = 0.35; grid.material.transparent = true;
    scene.add(grid);

    // walls
    this.wallMeshes = [];
    const wallMat = new THREE.MeshStandardMaterial({color:0x1c2444, emissive:0x2a1650, emissiveIntensity:0.4, roughness:0.6});
    const edgeMat = new THREE.LineBasicMaterial({color:0x00f0ff});
    this.layout.walls.forEach(w=>{
      const geo = new THREE.BoxGeometry(w.w, w.h, w.d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(w.x, w.h/2, w.z);
      mesh.rotation.y = w.ry;
      scene.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      mesh.add(edges);
      this.wallMeshes.push(mesh);
      mesh.userData.aabbSrc = w;
    });

    // ramps
    const rampMat = new THREE.MeshStandardMaterial({color:0x123a6b, emissive:0x1560c9, emissiveIntensity:0.5});
    this.layout.ramps.forEach(r=>{
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(4,0.6,6), rampMat);
      mesh.position.set(r.x, 1.4, r.z);
      mesh.rotation.set(0.5, r.ry, 0);
      scene.add(mesh);
    });

    // bunkers (3 walls, no roof)
    const bunkerMat = new THREE.MeshStandardMaterial({color:0x2a1440, emissive:0x6b1fa0, emissiveIntensity:0.35});
    this.layout.bunkers.forEach(bk=>{
      const grp = new THREE.Group();
      grp.position.set(bk.x, 0, bk.z); grp.rotation.y = bk.ry;
      const side = new THREE.BoxGeometry(0.3,2,3);
      const back = new THREE.BoxGeometry(3,2,0.3);
      const l = new THREE.Mesh(side, bunkerMat); l.position.set(-1.5,1,0); grp.add(l);
      const r = new THREE.Mesh(side, bunkerMat); r.position.set(1.5,1,0); grp.add(r);
      const bWall = new THREE.Mesh(back, bunkerMat); bWall.position.set(0,1,-1.5); grp.add(bWall);
      scene.add(grp);
      this.wallMeshes.push(l); l.position.set(bk.x-1.5*Math.cos(bk.ry), 1, bk.z-1.5*-Math.sin(bk.ry));
    });

    // shrinking zone wall (visual ring)
    const zoneGeo = new THREE.RingGeometry(this.zoneRadius-0.3, this.zoneRadius, 64);
    const zoneMat = new THREE.MeshBasicMaterial({color:0xff2e88, side:THREE.DoubleSide, transparent:true, opacity:0.6});
    this.zoneRing = new THREE.Mesh(zoneGeo, zoneMat);
    this.zoneRing.rotation.x = -Math.PI/2; this.zoneRing.position.y = 0.05;
    scene.add(this.zoneRing);

    addEventListener("resize", ()=>{
      three.camera.aspect = innerWidth/innerHeight; three.camera.updateProjectionMatrix();
      three.renderer.setSize(innerWidth, innerHeight);
    });
  }

  setupPickupsAndCores(){
    const heartGeo = new THREE.SphereGeometry(0.35,12,12);
    const heartMat = new THREE.MeshStandardMaterial({color:0xff3b5c, emissive:0xff3b5c, emissiveIntensity:1});
    this.layout.hearts.forEach(h=>{
      const mesh = new THREE.Mesh(heartGeo, heartMat);
      mesh.position.set(h.x, 1, h.z);
      three.scene.add(mesh);
      this.hearts[h.id] = {mesh, active:true, x:h.x, z:h.z};
    });
    const coreGeo = new THREE.OctahedronGeometry(0.6,0);
    const coreMat = new THREE.MeshStandardMaterial({color:0x7b2ff7, emissive:0x7b2ff7, emissiveIntensity:1.2});
    this.layout.cores.forEach(c=>{
      const mesh = new THREE.Mesh(coreGeo, coreMat);
      mesh.position.set(c.x, 1.8, c.z);
      three.scene.add(mesh);
      const light = new THREE.PointLight(0x7b2ff7, 1.2, 6);
      mesh.add(light);
      this.cores[c.id] = {mesh, active:true, x:c.x, z:c.z};
    });
  }

  /* ---------------- local player ---------------- */
  setupLocalPlayer(){
    this.player = {
      x:0, y:1.6, z: this.layout.size*0.7, vy:0, ry:0, rx:0,
      hp:6, alive:true, hasMega:false, ammo:5, maxAmmo:5, reloading:false,
      onGround:true, jumpVel:0, speed:5.2
    };
    // random spawn around ring
    const ang = Math.random()*Math.PI*2;
    const r = this.layout.size*0.6;
    this.player.x = Math.cos(ang)*r; this.player.z = Math.sin(ang)*r;
    three.camera.position.set(this.player.x, this.player.y, this.player.z);

    // simple gun model attached to camera
    const gunGrp = new THREE.Group();
    const gunMat = new THREE.MeshStandardMaterial({color:0x222233, emissive:0x00f0ff, emissiveIntensity:0.4});
    const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.12,0.5), gunMat);
    gunGrp.add(gunBody);
    gunGrp.position.set(0.25,-0.25,-0.5);
    three.camera.add(gunGrp);
    three.scene.add(three.camera);
    this.gunGrp = gunGrp;

    this.laserBeams = [];
    this.updateHeartsHUD();
    this.updateAmmoHUD();
  }

  updateHeartsHUD(){
    const row = $("hearts-row"); row.innerHTML="";
    const total = this.player.hp>10?10:10;
    for(let i=0;i<10;i++){
      const div = document.createElement("div");
      div.className = "heart-icon " + (i<this.player.hp ? "heart-full":"heart-empty");
      div.textContent = "❤️"; div.style.fontSize="20px"; div.style.lineHeight="20px";
      row.appendChild(div);
    }
  }
  updateAmmoHUD(){
    const row = $("ammo-row"); row.innerHTML="";
    for(let i=0;i<this.player.maxAmmo;i++){
      const div = document.createElement("div");
      div.style.fontSize="18px";
      div.textContent = this.player.hasMega ? "🟨" : "🔷";
      div.style.opacity = i<this.player.ammo ? 1 : 0.2;
      row.appendChild(div);
    }
  }

  /* ---------------- controls ---------------- */
  setupControls(){
    this.keys = {};
    this.isTouch = matchMedia("(pointer: coarse)").matches;
    if(!this.isTouch){
      $("game-canvas").addEventListener("click", ()=>{
        if(document.pointerLockElement !== $("game-canvas")) $("game-canvas").requestPointerLock();
        else this.shoot();
      });
      document.addEventListener("mousemove", e=>{
        if(document.pointerLockElement === $("game-canvas")){
          this.player.ry -= e.movementX*0.0022;
          this.player.rx -= e.movementY*0.0022;
          this.player.rx = Math.max(-1.2, Math.min(1.2, this.player.rx));
        }
      });
      let escCount=0, escTimer=null;
      document.addEventListener("keydown", e=>{
        this.keys[e.code]=true;
        if(e.code==="KeyR") this.reload();
        if(e.code==="Escape"){
          escCount++;
          clearTimeout(escTimer);
          escTimer = setTimeout(()=>escCount=0, 800);
          if(escCount>=2) leaveMatch();
        }
      });
      document.addEventListener("keyup", e=> this.keys[e.code]=false);
    } else {
      $("mobile-controls").classList.remove("hidden");
      this.setupTouchControls();
    }
  }

  setupTouchControls(){
    const zone = $("joystick-zone"), knob = $("joystick-knob");
    let jTouchId=null, jStart={x:0,y:0};
    this.touchMove = {x:0,y:0};
    zone.addEventListener("touchstart", e=>{
      const t=e.changedTouches[0]; jTouchId=t.identifier;
      const rect = zone.getBoundingClientRect(); jStart={x:rect.left+rect.width/2, y:rect.top+rect.height/2};
    });
    zone.addEventListener("touchmove", e=>{
      for(const t of e.changedTouches){
        if(t.identifier===jTouchId){
          let dx=t.clientX-jStart.x, dy=t.clientY-jStart.y;
          const max=45; const d=Math.hypot(dx,dy);
          if(d>max){dx=dx/d*max; dy=dy/d*max;}
          knob.style.left=(37+dx)+"px"; knob.style.top=(37+dy)+"px";
          this.touchMove = {x:dx/max, y:dy/max};
        }
      }
      e.preventDefault();
    }, {passive:false});
    zone.addEventListener("touchend", ()=>{ jTouchId=null; this.touchMove={x:0,y:0}; knob.style.left="37px"; knob.style.top="37px"; });

    const look = $("look-zone");
    let lTouchId=null, lastX=0,lastY=0;
    look.addEventListener("touchstart", e=>{
      const t=e.changedTouches[0]; lTouchId=t.identifier; lastX=t.clientX; lastY=t.clientY;
    });
    look.addEventListener("touchmove", e=>{
      for(const t of e.changedTouches){
        if(t.identifier===lTouchId){
          const dx=t.clientX-lastX, dy=t.clientY-lastY;
          lastX=t.clientX; lastY=t.clientY;
          this.player.ry -= dx*0.004;
          this.player.rx -= dy*0.004;
          this.player.rx = Math.max(-1.2, Math.min(1.2, this.player.rx));
          if(this.activeCore) this.checkCoreTapAim();
        }
      }
      e.preventDefault();
    }, {passive:false});
    look.addEventListener("touchend", ()=>{ lTouchId=null; });

    $("mobile-tag").addEventListener("touchstart", e=>{ e.preventDefault(); this.shoot(); });
    $("mobile-jump").addEventListener("touchstart", e=>{ e.preventDefault(); this.tryJump(); });
  }

  tryJump(){
    if(this.player.onGround){ this.player.jumpVel = 6.2; this.player.onGround=false; }
  }

  reload(){
    this.player.ammo = this.player.maxAmmo;
    this.updateAmmoHUD();
  }

  /* ---------------- shooting ---------------- */
  shoot(){
    if(!this.player.alive || this.ended) return;
    if(this.activeCore){ this.resolveCoreClick(); return; }
    if(this.player.ammo<=0) return;
    this.player.ammo--; this.updateAmmoHUD();

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({x:0,y:0}, three.camera);
    this.fireLaserVisual();

    // check hits against remote players
    let closestId=null, closestDist=Infinity;
    for(const id in this.remotePlayers){
      const rp = this.remotePlayers[id];
      if(!rp.alive) continue;
      const target = new THREE.Vector3(rp.x, rp.y-0.4, rp.z);
      const dist = raycaster.ray.distanceToPoint(target);
      const camDist = three.camera.position.distanceTo(target);
      if(dist < 0.9 && camDist < 60 && camDist<closestDist){ closestDist=camDist; closestId=id; }
    }
    if(closestId){
      this.dealDamage(closestId, 1);
    }
  }

  fireLaserVisual(){
    const dir = new THREE.Vector3(); three.camera.getWorldDirection(dir);
    const start = three.camera.position.clone().add(dir.clone().multiplyScalar(0.6));
    const end = start.clone().add(dir.clone().multiplyScalar(80));
    const geo = new THREE.BufferGeometry().setFromPoints([start,end]);
    const mat = new THREE.LineBasicMaterial({color: this.player.hasMega?0xffd23f:0x00f0ff, transparent:true, opacity:0.9});
    const line = new THREE.Line(geo, mat);
    three.scene.add(line);
    setTimeout(()=>{ three.scene.remove(line); geo.dispose(); mat.dispose(); }, 90);
  }

  dealDamage(targetId, amount){
    // send tag event; authoritative resolution happens wherever the target's "home" is —
    // for simplicity every client resolves its own hp locally from tag events addressed to it,
    // and the host relays so everyone stays roughly in sync.
    const msg = {t:"tag", from:this.myId, fromName:this.myName, to:targetId, amount};
    if(targetId.startsWith("bot_")){
      if(this.mode!=="client") this.applyTagToBot(targetId, this.myId, this.myName, amount);
      if(this.mode==="host") Net.broadcast(msg);
    } else {
      Net.broadcast(msg);
      if(this.mode==="host") this.handleNetMessage(this.myId, msg); // host applies immediately too
    }
    save.tags++; saveSave(); refreshStatsStrip();
  }

  applyTagToBot(botId, fromId, fromName, amount){
    const b = this.bots[botId]; if(!b || !b.alive) return;
    b.hp -= amount;
    this.addKillfeed(`${fromName} tagged ${b.name}`);
    if(b.hp<=0){ b.hp=0; b.alive=false; b.respawnAt = performance.now()+99999; this.addKillfeed(`${b.name} is out!`); this.checkWinCondition(); }
    const rp = this.remotePlayers[botId];
    if(rp) rp.applyState({x:b.x,y:1.6,z:b.z,ry:b.ry,hp:b.hp,alive:b.alive,hasMega:false});
    if(this.mode==="host") Net.broadcast({t:"botstate", id:botId, x:b.x,y:1.6,z:b.z,ry:b.ry,hp:b.hp,alive:b.alive,name:b.name});
  }

  /* ---------------- power cores ---------------- */
  checkNearestCore(){
    if(this.activeCore) return;
    for(const id in this.cores){
      const c = this.cores[id];
      if(!c.active) continue;
      const d = Math.hypot(this.player.x-c.x, this.player.z-c.z);
      if(d < 3.2){ this.openCore(id); return; }
    }
  }
  openCore(id){
    this.activeCore = {id, t0:performance.now(), duration:2600, target: 0.35+Math.random()*0.4};
    $("power-core-prompt").classList.remove("hidden");
    const targetArc = document.getElementById("core-ring-target");
    const off = 314*(1-this.activeCore.target);
    targetArc.style.strokeDasharray = `18 ${314-18}`;
    targetArc.style.transform = `rotate(${this.activeCore.target*360}deg)`;
    targetArc.style.transformOrigin = "60px 60px";
  }
  resolveCoreClick(){
    const ac = this.activeCore; if(!ac) return;
    const elapsed = (performance.now()-ac.t0)/ac.duration;
    const progress = Math.min(1, elapsed);
    const hit = Math.abs(progress - ac.target) < 0.09;
    this.closeCore();
    if(hit){
      Net.broadcast({t:"core", id:ac.id, by:this.myId, byName:this.myName});
      if(this.mode==="host") this.handleNetMessage(this.myId, {t:"core", id:ac.id, by:this.myId, byName:this.myName});
      else this.grantCoreReward(true); // optimistic local reward on client while host confirms
    } else {
      this.addKillfeed("Missed the core!");
    }
  }
  closeCore(){
    this.activeCore=null;
    $("power-core-prompt").classList.add("hidden");
  }
  checkCoreTapAim(){ /* mobile: tap already handled by shoot() while activeCore set */ }

  grantCoreReward(isMega){
    if(Math.random()<0.35 || isMega===true && false){} // placeholder no-op to keep structure simple
    const giveMega = Math.random()<0.3;
    if(giveMega){ this.player.hasMega=true; this.player.maxAmmo=6; this.player.ammo=Math.min(6,this.player.ammo+1); this.addKillfeed("You earned the MEGA WAND! ✨"); }
    else { this.player.hp = Math.min(10, this.player.hp+1); this.addKillfeed("Power Core: +1 heart!"); }
    this.updateHeartsHUD(); this.updateAmmoHUD();
  }

  /* ---------------- hearts pickups ---------------- */
  checkHeartPickup(){
    for(const id in this.hearts){
      const h = this.hearts[id];
      if(!h.active) continue;
      const d = Math.hypot(this.player.x-h.x, this.player.z-h.z);
      if(d < 1.1 && this.player.hp<10){
        h.active=false; h.mesh.visible=false;
        this.player.hp = Math.min(10, this.player.hp+2);
        this.updateHeartsHUD();
        Net.broadcast({t:"heart", id});
        setTimeout(()=>{ h.active=true; h.mesh.visible=true; }, 15000);
      }
    }
  }

  /* ---------------- bots ---------------- */
  spawnBots(n){
    for(let i=0;i<n;i++){
      const id = "bot_"+i;
      const ang = Math.random()*Math.PI*2, r=this.layout.size*0.5*Math.random();
      const bot = {
        id, name: randomName().slice(0,12), x:Math.cos(ang)*r, z:Math.sin(ang)*r, ry:Math.random()*Math.PI*2,
        hp:6, alive:true, target:null, wanderAngle:Math.random()*Math.PI*2, cooldown:0
      };
      this.bots[id]=bot;
      const rp = new RemotePlayer(id, bot.name);
      three.scene.add(rp.mesh);
      this.remotePlayers[id]=rp;
    }
  }
  updateBots(dt){
    if(this.mode==="client") return; // only host/solo simulate bots
    for(const id in this.bots){
      const b = this.bots[id];
      if(!b.alive) continue;
      // simple wander + occasional shove toward center as zone shrinks
      b.wanderAngle += (Math.random()-0.5)*0.6*dt;
      let mvx = Math.cos(b.wanderAngle), mvz = Math.sin(b.wanderAngle);
      const distCenter = Math.hypot(b.x,b.z);
      if(distCenter > this.zoneRadius*0.85){ mvx = -b.x/distCenter; mvz = -b.z/distCenter; }
      const speed = 2.6;
      let nx = b.x + mvx*speed*dt, nz = b.z + mvz*speed*dt;
      if(!this.collidesWalls(nx,nz)){ b.x=nx; b.z=nz; }
      b.ry = Math.atan2(mvx,mvz);

      // occasionally "tag" nearby player (simplified, no real raycast for bots)
      b.cooldown -= dt;
      if(b.cooldown<=0){
        const dPlayer = Math.hypot(this.player.x-b.x, this.player.z-b.z);
        if(dPlayer < 14 && this.player.alive && Math.random()<0.5){
          b.cooldown = 1.6+Math.random();
          if(Math.random()<0.55){
            this.applyTagToLocal(1, b.name);
          }
        } else {
          b.cooldown = 0.6;
        }
      }
      const rp = this.remotePlayers[id];
      rp.applyState({x:b.x,y:1.6,z:b.z,ry:b.ry,hp:b.hp,alive:b.alive,hasMega:false});
    }
  }

  applyTagToLocal(amount, fromName){
    if(!this.player.alive) return;
    this.player.hp -= amount;
    this.addKillfeed(`${fromName} tagged you!`);
    this.updateHeartsHUD();
    if(this.player.hp<=0){
      this.player.hp=0; this.player.alive=false;
      this.addKillfeed("You're out!");
      this.checkWinCondition();
    }
  }

  /* ---------------- networking messages ---------------- */
  handleNetMessage(from, data){
    switch(data.t){
      case "state":
        this.ensureRemote(from, data.name).applyState(data);
        break;
      case "tag":
        if(data.to===this.myId){ this.applyTagToLocal(data.amount, data.fromName); if(this.mode==="host") Net.broadcast(data); }
        else if(this.mode==="host" && !data.to.startsWith("bot_")){ Net.broadcast(data); }
        break;
      case "core":
        { const c=this.cores[data.id]; if(c && c.active){ c.active=false; c.mesh.visible=false;
          this.addKillfeed(`${data.byName} claimed a Power Core!`);
          if(data.by===this.myId) this.grantCoreReward();
          if(this.mode==="host") Net.broadcast(data);
          setTimeout(()=>{ if(c){c.active=true; c.mesh.visible=true;} }, 20000);
        } }
        break;
      case "heart":
        { const h=this.hearts[data.id]; if(h){ h.active=false; h.mesh.visible=false; setTimeout(()=>{h.active=true;h.mesh.visible=true;},15000);} }
        break;
      case "botstate":
        this.ensureRemote(data.id, data.name).applyState(data);
        break;
      case "matchend":
        this.onMatchEndMessage(data);
        break;
      case "join":
        this.ensureRemote(from, data.name);
        if(this.mode==="host"){
          Net.sendTo(from, {t:"welcome", seed:this.seed, botCount:Object.keys(this.bots).length});
        }
        break;
      case "start":
        startCountdownAndPlay();
        break;
    }
  }
  ensureRemote(id, name){
    if(!this.remotePlayers[id]){
      const rp = new RemotePlayer(id, name||"Player");
      three.scene.add(rp.mesh);
      this.remotePlayers[id]=rp;
    }
    return this.remotePlayers[id];
  }
  removeRemote(id){
    const rp = this.remotePlayers[id];
    if(rp){ three.scene.remove(rp.mesh); delete this.remotePlayers[id]; }
  }
  addKillfeed(text){
    const el = document.createElement("div");
    el.className="kill-row"; el.textContent = text;
    this.killfeedEl.appendChild(el);
    setTimeout(()=> el.remove(), 4000);
  }

  /* ---------------- collision ---------------- */
  collidesWalls(x,z){
    for(const w of this.layout.walls){
      const cos=Math.cos(-w.ry), sin=Math.sin(-w.ry);
      const dx=x-w.x, dz=z-w.z;
      const lx = dx*cos - dz*sin, lz = dx*sin + dz*cos;
      if(Math.abs(lx) < w.w/2+0.4 && Math.abs(lz) < w.d/2+0.4) return true;
    }
    return this.layout.size*1.19 < Math.hypot(x,z);
  }

  /* ---------------- main loop ---------------- */
  animate(t){
    if(this.disposed) return;
    requestAnimationFrame(this.animate);
    const now = performance.now();
    const dt = Math.min(0.05, (now-(this._lastT||now))/1000);
    this._lastT = now;

    this.updateLocalMovement(dt);
    this.updateBots(dt);
    this.checkHeartPickup();
    this.checkNearestCore();
    if(this.activeCore){
      const ac=this.activeCore;
      const progress = Math.min(1,(now-ac.t0)/ac.duration);
      document.getElementById("core-ring-shrink").style.strokeDashoffset = 314*progress;
      if(progress>=1) this.closeCore();
    }

    if(this.mode!=="client" || true){ /* clients still tick own timer visually */ }
    if((this.mode==="host"||this.mode==="solo") && this.started && !this.ended){
      this.timeLeft -= dt;
      this.zoneRadius = Math.max(6, this.layout.size*1.6 * (this.timeLeft/this.matchLen));
      this.zoneRing.geometry.dispose();
      this.zoneRing.geometry = new THREE.RingGeometry(Math.max(0,this.zoneRadius-0.3), this.zoneRadius, 64);
      if(Math.hypot(this.player.x,this.player.z) > this.zoneRadius && this.player.alive){
        this.player.hp -= dt*1.2;
        if(this.player.hp<=0){ this.player.hp=0; this.player.alive=false; this.addKillfeed("The zone got you!"); this.checkWinCondition(); }
        this.updateHeartsHUD();
      }
      if(this.timeLeft<=0) this.endMatch(false);
      $("match-timer").textContent = formatTime(Math.max(0,this.timeLeft));
      if(this.mode==="host") Net.broadcast({t:"timer", left:this.timeLeft, zone:this.zoneRadius});
    }
    $("alive-num").textContent = this.countAlive();

    // send own state
    if(now-this.lastSyncSent>66){
      this.lastSyncSent = now;
      Net.broadcast({t:"state", name:this.myName, x:this.player.x,y:this.player.y,z:this.player.z,ry:this.player.ry,hp:this.player.hp,alive:this.player.alive,hasMega:this.player.hasMega});
    }

    three.camera.position.set(this.player.x, this.player.y, this.player.z);
    three.camera.rotation.set(this.player.rx, this.player.ry, 0, "YXZ");

    three.renderer.render(three.scene, three.camera);
  }

  countAlive(){
    let n = this.player.alive?1:0;
    for(const id in this.remotePlayers) if(this.remotePlayers[id].alive) n++;
    return n;
  }

  updateLocalMovement(dt){
    if(!this.player.alive) return;
    let mx=0, mz=0;
    if(this.isTouch){
      mx = this.touchMove.x; mz = this.touchMove.y;
    } else {
      if(this.keys["KeyW"]||this.keys["ArrowUp"]) mz-=1;
      if(this.keys["KeyS"]||this.keys["ArrowDown"]) mz+=1;
      if(this.keys["KeyA"]||this.keys["ArrowLeft"]) mx-=1;
      if(this.keys["KeyD"]||this.keys["ArrowRight"]) mx+=1;
      if(this.keys["Space"]) this.tryJump();
    }
    const len = Math.hypot(mx,mz);
    if(len>0.05){
      mx/=len; mz/=len;
      const sin=Math.sin(this.player.ry), cos=Math.cos(this.player.ry);
      const wx = mx*cos - mz*sin, wz = mx*sin + mz*cos;
      const speed = this.player.speed;
      const nx = this.player.x + wx*speed*dt, nz = this.player.z + wz*speed*dt;
      if(!this.collidesWalls(nx, this.player.z)) this.player.x = nx;
      if(!this.collidesWalls(this.player.x, nz)) this.player.z = nz;
    }
    // gravity/jump
    this.player.jumpVel -= 16*dt;
    this.player.y += this.player.jumpVel*dt;
    if(this.player.y<=1.6){ this.player.y=1.6; this.player.jumpVel=0; this.player.onGround=true; }
  }

  checkWinCondition(){
    if(this.mode==="client") return;
    if(this.ended) return;
    const aliveIds = [];
    if(this.player.alive) aliveIds.push(this.myId);
    for(const id in this.remotePlayers) if(this.remotePlayers[id].alive) aliveIds.push(id);
    if(aliveIds.length<=1) this.endMatch(true, aliveIds[0]);
  }

  endMatch(byElimination, winnerId){
    if(this.ended) return;
    this.ended = true;
    let winnerName = "Nobody";
    if(byElimination && winnerId){
      winnerName = winnerId===this.myId ? this.myName : (this.remotePlayers[winnerId] ? this.remotePlayers[winnerId].name : "Bot");
    } else {
      // time up: highest hp wins
      let best = {id:this.myId, name:this.myName, hp:this.player.hp, alive:this.player.alive};
      for(const id in this.remotePlayers){
        const rp=this.remotePlayers[id];
        if(rp.alive && rp.hp>best.hp) best={id,name:rp.name,hp:rp.hp,alive:true};
      }
      winnerId = best.id; winnerName = best.name;
    }
    if(this.mode==="host") Net.broadcast({t:"matchend", winnerId, winnerName});
    this.onMatchEndMessage({winnerId, winnerName});
  }

  onMatchEndMessage(data){
    if(this.matchEndShown) return;
    this.matchEndShown = true;
    const iWon = data.winnerId===this.myId;
    const banner = $("banner");
    banner.classList.remove("hidden");
    banner.innerHTML = `<div class="title">${iWon?"👑 YOU WIN!":data.winnerName+" WINS"}</div><div class="sub">returning to menu…</div>`;
    save.matches++;
    if(iWon){ save.crowns++; save.wins++; }
    save.history.push({win:iWon, mode:this.mode, date:new Date().toLocaleDateString()});
    saveSave(); refreshStatsStrip();
    document.exitPointerLock && document.exitPointerLock();
    setTimeout(()=>{ this.dispose(); returnToMenu(); }, 3200);
  }

  dispose(){
    this.disposed = true;
    if(three.renderer){ three.renderer.dispose(); }
  }
}

function formatTime(s){
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return m+":"+(sec<10?"0":"")+sec;
}

/* ============================================================
   FLOW CONTROL — menu buttons -> starting matches
   ============================================================ */
let pendingRoomCode = null;

$("host-btn").addEventListener("click", ()=>{
  $("host-btn").disabled = true;
  Net.onPeerJoin = (peerId, name)=> addLobbyChip(name||"Player");
  Net.initHost(code=>{
    $("host-code").textContent = code;
    $("host-code-wrap").classList.remove("hidden");
  });
});
function addLobbyChip(name){
  const chip = document.createElement("div");
  chip.className="lobby-chip"; chip.textContent = name;
  $("lobby-list").appendChild(chip);
}
$("start-match-btn").addEventListener("click", ()=>{
  const seed = Math.floor(Math.random()*1e9);
  window._hostSeed = seed;
  Net.broadcast({t:"start", seed});
  startCountdownAndPlay();
});

$("join-btn").addEventListener("click", ()=>{
  const code = $("join-code").value.trim().toUpperCase();
  if(!code) return;
  $("join-status").textContent = "Connecting…";
  Net.initClient(code, save.name, id=>{
    $("join-status").textContent = "Connected! Waiting for host to start…";
    // active before the Game object exists, so we can hear the host's "start" signal
    Net.onMessage = (from, data)=>{ if(data.t==="start"){ window._joinSeed = data.seed; startCountdownAndPlay(); } };
  }, err=>{
    $("join-status").textContent = "Couldn't connect — check the code.";
  });
});

$("solo-btn").addEventListener("click", ()=>{
  startMatch("solo", { botCount: parseInt($("bot-count").value,10) });
});

function startCountdownAndPlay(){
  if(Net.isHost) startMatch("host", { botCount: 0 });
  else startMatch("client", {});
}

function startMatch(mode, opts){
  menuScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  $("banner").classList.add("hidden");
  $("killfeed").innerHTML="";
  const seed = mode==="client" ? (window._joinSeed||Math.floor(Math.random()*1e9))
             : mode==="host" ? (window._hostSeed||Math.floor(Math.random()*1e9))
             : Math.floor(Math.random()*1e9);
  game = new Game({mode, myId: Net.myId || "solo-"+Math.random().toString(36).slice(2), seed, botCount: opts.botCount||0});
  game.started = true;
  if(mode!=="client") game.timeLeft = game.matchLen;
  $("arena-code-badge").textContent = Net.isHost ? ("ROOM "+($("host-code").textContent)) : (mode==="client" ? "JOINED MATCH" : "SOLO PRACTICE");
}

function returnToMenu(){
  gameScreen.classList.add("hidden");
  menuScreen.classList.remove("hidden");
  $("host-code-wrap").classList.add("hidden");
  $("lobby-list").innerHTML = "";
  $("host-btn").disabled = false;
  $("join-status").textContent = "";
  Net.leaveRoom();
  refreshStatsStrip();
}

function leaveMatch(){
  if(game){ game.dispose(); }
  returnToMenu();
}

addEventListener("beforeunload", ()=>{ Net.leaveRoom(); });
