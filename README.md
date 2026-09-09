# NEON TAG

A browser-based 3D laser tag battle royale, inspired by Hooda's Laser Tag — but instead of
multiplication walls, you've got **Power Cores**: click the shrinking ring at the right instant
for a bonus heart or the golden Mega Wand.

Play with friends over a peer-to-peer connection (no server needed — works right on GitHub Pages),
or practice solo against bots.

## How it works

- **3D arena**: Three.js, neon walls, ramps, and 3-sided bunkers, with a safe zone that shrinks
  as the match clock runs down.
- **Controls**: WASD/Arrows + mouse look, click to tag, Space to jump, R to recharge, Esc twice to leave.
  On phone/tablet: left-thumb joystick, drag right side to look, TAG/JUMP buttons.
- **Hearts**: start with 6, max 10, tags cost 1, red orbs heal 2.
- **Power Cores**: walk up to a glowing purple core, then click when the shrinking ring lines up
  with the gold target arc. Win a bonus heart, or sometimes the Mega Wand (6 shots instead of 5).
- **Multiplayer**: real-time, backed by a [Firebase Realtime Database](https://firebase.google.com/docs/database).
  One friend hits **Host**, gets a room code, everyone else hits **Join** and types the code in.
  Player positions and one-off actions (tags, power cores, hearts) stream to everyone in the room
  instantly. This uses the database's plain HTTPS REST + Server-Sent Events API directly — no
  backend code of yours to write or host, so it works straight from GitHub Pages. It's built for a
  small group (2–10 friends), not a true 60-player match — that needs a dedicated game server.
- **Bots**: fill empty slots in Solo mode, or can be added by the host later if you want livelier
  matches (currently Solo only — see "Ideas to extend" below).
- **Saved data**: crowns, matches played, tags, and match history are saved in your browser's
  `localStorage` (same as Hooda's "crowns saved on your device"), and also backed up to the same
  Firebase database so they survive clearing your browser data.

## Set up your Firebase database (one-time)

The game is already pointed at a Realtime Database (`FIREBASE_DB_URL` near the top of `game.js`).
For it to actually work, open your [Firebase console](https://console.firebase.google.com) →
your `lasertag-569fa` project → **Realtime Database → Rules**, and paste this:

```json
{
  "rules": {
    "rooms": { ".read": true, ".write": true },
    "players_backup": { ".read": true, ".write": true },
    ".read": false,
    ".write": false
  }
}
```

This opens up just the `rooms` and `players_backup` paths for reading/writing with no login
required (everything else stays locked), which is what lets the static GitHub Pages site talk to
the database directly. There's no login system here, so anyone with your database URL could in
principle read or write to those two paths — fine for a casual game with friends and nothing
sensitive stored, but worth knowing.

> **About the service-account key you shared earlier:** that JSON file is a full-admin credential
> for server-side use only — it should never be pasted into chat or committed to a repo. Since it
> was shared in this conversation, please regenerate/revoke it from **Project Settings → Service
> Accounts** in the Firebase console. It isn't used anywhere in this project — the rules above are
> all the "backend setup" this game needs.

## Run it locally

Just open `index.html` in a browser — no build step. For multiplayer to work reliably, serve it
over `http://localhost` rather than `file://` (browsers restrict some APIs on `file://`):

```
cd laser-tag
python3 -m http.server 8000
# then open http://localhost:8000
```

## Publish it on GitHub Pages (so your friends can play)

You already made the repo at `https://github.com/aadomy21/laser-tag`. From your computer:

```bash
git clone https://github.com/aadomy21/laser-tag.git
cd laser-tag
# copy index.html, style.css, game.js, README.md into this folder
git add .
git commit -m "Add Neon Tag laser battle game"
git push
```

Then in the repo on GitHub: **Settings → Pages → Source: `main` branch, `/ (root)`** → Save.
After a minute or two your game will be live at:

```
https://aadomy21.github.io/laser-tag/
```

Send that link to friends. Whoever hosts a room shares the room code shown after clicking **Host**.

## Ideas to extend

- Add bots into hosted multiplayer matches too (right now bots are Solo-only).
- Add more arenas / a map picker, like the original's North/East/South/West/Australia/Europe menu.
- Build a real "All Players" global leaderboard from the `players_backup` data.
- Add sound effects and a proper gun/arm model.
- Smooth remote-player movement with interpolation instead of snapping to the latest network update.

## Known limitations

- This is built for small friend groups on a decent connection, not dozens of simultaneous players.
- Hit detection and health sync are kept simple (each client resolves and broadcasts its own tags)
  for a casual friends game — it is not cheat-proof, and the open database rules mean it's not
  meant to store anything sensitive.
- Firebase's free tier has generous but real limits on simultaneous connections and bandwidth —
  plenty for playing with friends, but worth knowing if this ever gets shared much more widely.
