import asyncio
import json
import logging
import os
import secrets
import string
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

load_dotenv()  # reads .env from cwd at startup

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# TURN / ICE server credentials (loaded from .env — never hardcoded)
# ---------------------------------------------------------------------------
_TURN_USERNAME: str | None = os.getenv("TURN_USERNAME")
_TURN_CREDENTIAL: str | None = os.getenv("TURN_CREDENTIAL")
_FRONTEND_ORIGIN: str | None = os.getenv("FRONTEND_ORIGIN", "").rstrip("/") or None
_LOCAL_DEV_ORIGIN = "http://localhost:5173"
_ALLOWED_ORIGINS = [_LOCAL_DEV_ORIGIN]
if _FRONTEND_ORIGIN and _FRONTEND_ORIGIN not in _ALLOWED_ORIGINS:
    _ALLOWED_ORIGINS.append(_FRONTEND_ORIGIN)

# ---------------------------------------------------------------------------
# Room Code Store & In-Memory Management
# ---------------------------------------------------------------------------
# Uppercase letters and digits, excluding ambiguous characters like 0, O, 1, I
ROOM_CODE_ALPHABET: str = "".join(
    c for c in string.ascii_uppercase + string.digits if c not in {"0", "O", "1", "I"}
)


class RoomStore:
    """Manages active room codes, timestamped expiration, and participant tracking."""

    def __init__(self) -> None:
        # { code: { "code": str, "created_at": float, "last_activity": float, "peers_ever_joined": set[str] } }
        self._rooms: dict[str, dict[str, Any]] = {}

    def create_room(self) -> str:
        now = time.time()
        for _ in range(100):
            code = "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(6))
            if code not in self._rooms:
                self._rooms[code] = {
                    "code": code,
                    "created_at": now,
                    "last_activity": now,
                    "peers_ever_joined": set(),
                }
                logger.info("Created room code: %s", code)
                return code
        raise RuntimeError("Failed to generate a unique room code")

    def exists(self, code: str) -> bool:
        c = code.strip().upper()
        room = self._rooms.get(c)
        if not room:
            return False
        # 1 hour of inactivity expiration
        if time.time() - room["last_activity"] > 3600:
            self._rooms.pop(c, None)
            logger.info("Room '%s' expired due to inactivity (>1 hour)", c)
            return False
        return True

    def record_join(self, code: str, client_id: str) -> None:
        c = code.strip().upper()
        now = time.time()
        if c in self._rooms:
            self._rooms[c]["last_activity"] = now
            self._rooms[c]["peers_ever_joined"].add(client_id)

    def record_activity(self, code: str) -> None:
        c = code.strip().upper()
        if c in self._rooms:
            self._rooms[c]["last_activity"] = time.time()

    def handle_disconnect(self, code: str, remaining_peers: int) -> None:
        c = code.strip().upper()
        room = self._rooms.get(c)
        if not room:
            return
        # Delete code if both peers have disconnected (at least 2 joined and 0 now remaining)
        if len(room["peers_ever_joined"]) >= 2 and remaining_peers == 0:
            logger.info("Both peers disconnected from room '%s'; removing code", c)
            self._rooms.pop(c, None)

    def cleanup_expired(self) -> int:
        now = time.time()
        expired = [
            c for c, data in self._rooms.items()
            if now - data["last_activity"] > 3600
        ]
        for c in expired:
            logger.info("Background cleanup: removing expired room '%s'", c)
            self._rooms.pop(c, None)
        return len(expired)


room_store = RoomStore()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Periodic background cleanup task for expired rooms (every 60s)
    async def cleanup_loop():
        while True:
            try:
                await asyncio.sleep(60)
                room_store.cleanup_expired()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Error in room cleanup task: %s", exc)

    cleanup_task = asyncio.create_task(cleanup_loop())
    yield
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="WebSocket Chat Rooms", lifespan=lifespan)

# Only the deployed frontend may make cross-origin API and WebSocket requests.
# Local Vite development is always allowed. Set FRONTEND_ORIGIN to the exact
# Vercel URL (without a trailing slash) for production.
logger.info("CORS allowed origins: %s", _ALLOWED_ORIGINS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Connection Manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    """Manages active WebSocket connections grouped by room_id."""

    def __init__(self) -> None:
        # { room_id: { client_id: WebSocket } }
        self._rooms: dict[str, dict[str, WebSocket]] = defaultdict(dict)

    # ------------------------------------------------------------------
    # Lifecycle helpers
    # ------------------------------------------------------------------

    async def connect(self, room_id: str, client_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._rooms[room_id][client_id] = ws
        logger.info("Client '%s' joined room '%s'  (room size: %d)",
                    client_id, room_id, len(self._rooms[room_id]))

    def disconnect(self, room_id: str, client_id: str) -> None:
        room = self._rooms.get(room_id, {})
        room.pop(client_id, None)
        if not room:                        # clean up empty room
            self._rooms.pop(room_id, None)
        logger.info("Client '%s' left room '%s'", client_id, room_id)

    # ------------------------------------------------------------------
    # Messaging helpers
    # ------------------------------------------------------------------

    async def broadcast(
        self,
        room_id: str,
        sender_id: str,
        message: dict[str, Any],
    ) -> None:
        """Send *message* to every client in *room_id* except the sender."""
        room = self._rooms.get(room_id, {})
        dead: list[str] = []

        for cid, ws in room.items():
            if cid == sender_id:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                logger.warning("Could not send to '%s'; scheduling removal.", cid)
                dead.append(cid)

        for cid in dead:
            self.disconnect(room_id, cid)

    # ------------------------------------------------------------------
    # Utility
    # ------------------------------------------------------------------

    def room_members(self, room_id: str) -> list[str]:
        return list(self._rooms.get(room_id, {}).keys())

    def active_rooms(self) -> list[str]:
        return list(self._rooms.keys())


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# REST / diagnostic endpoints
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse, summary="Minimal test client")
async def index() -> str:
    """Returns a bare-bones HTML page for quick manual testing."""
    return """
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>WS Test</title></head>
<body>
<h2>WebSocket room tester</h2>
<label>Room ID: <input id="room" value="lobby"/></label><br>
<label>Client ID: <input id="client" value="alice"/></label><br>
<button onclick="connect()">Connect</button>
<button onclick="disconnect()">Disconnect</button>
<br><br>
<label>Message (JSON): <input id="msg" value='{"text":"hello"}' size="40"/></label>
<button onclick="send()">Send</button>
<pre id="log" style="border:1px solid #ccc;padding:8px;height:200px;overflow:auto"></pre>
<script>
let ws;
function log(msg){ const el=document.getElementById('log'); el.textContent+=msg+'\n'; el.scrollTop=el.scrollHeight; }
function connect(){
  const room=document.getElementById('room').value;
  const client=document.getElementById('client').value;
  ws=new WebSocket('ws://'+location.host+'/ws/'+room+'/'+client);
  ws.onmessage=e=>log('IN  '+e.data);
  ws.onopen=()=>log('Connected');
  ws.onclose=()=>log('Disconnected');
  ws.onerror=e=>log('Error: '+e);
}
function disconnect(){ ws && ws.close(); }
function send(){
  if(!ws||ws.readyState!==WebSocket.OPEN){log('Not connected');return;}
  const raw=document.getElementById('msg').value;
  ws.send(raw); log('OUT '+raw);
}
</script>
</body>
</html>
"""


@app.get("/rooms", summary="List active rooms and their members")
async def list_rooms() -> dict[str, Any]:
    rooms = {r: manager.room_members(r) for r in manager.active_rooms()}
    return {"active_rooms": rooms}


@app.get("/health", summary="Health check for Render and Fly")
async def health() -> dict[str, str]:
    """Lightweight liveness probe that does not expose application state."""
    return {"status": "ok"}


@app.get("/ice-servers", summary="Return ICE server configuration for WebRTC")
async def ice_servers() -> list[dict[str, Any]]:
    """
    Returns the full ICE server list the frontend should pass to
    ``RTCPeerConnection``.  STUN is tried first; if it fails under
    symmetric / carrier-grade NAT the TURN entries allow relay fallback.

    TURN credentials are read from environment variables so they are
    never committed to source control.
    """
    if not _TURN_USERNAME or not _TURN_CREDENTIAL:
        logger.error("TURN credentials are not configured")
        raise HTTPException(status_code=503, detail="TURN credentials are not configured")

    credentials = {"username": _TURN_USERNAME, "credential": _TURN_CREDENTIAL}
    return [
        # Google STUN (fast, no credentials needed)
        {"urls": "stun:stun.l.google.com:19302"},
        # OpenRelay TURN: expose both transports on each supported port.
        {"urls": "turn:openrelay.metered.ca:80?transport=udp", **credentials},
        {"urls": "turn:openrelay.metered.ca:80?transport=tcp", **credentials},
        {"urls": "turn:openrelay.metered.ca:443?transport=udp", **credentials},
        {"urls": "turn:openrelay.metered.ca:443?transport=tcp", **credentials},
        {"urls": "turn:openrelay.metered.ca:3478?transport=udp", **credentials},
        {"urls": "turn:openrelay.metered.ca:3478?transport=tcp", **credentials},
    ]


@app.post("/create-room", summary="Generate a unique 6-character room code")
async def create_room() -> dict[str, str]:
    """
    Generates a unique 6-character alphanumeric room code (excluding ambiguous
    characters), stores it with a creation timestamp, and returns it.
    """
    code = room_store.create_room()
    return {"code": code, "room_code": code}


@app.get("/room/{code}/exists", summary="Validate if a room code exists and is not expired")
async def check_room_exists(code: str) -> dict[str, Any]:
    """
    Validates whether the specified room code exists in memory and is active.
    """
    valid = room_store.exists(code)
    return {"exists": valid, "code": code.upper()}


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws/{room_id}/{client_id}")
async def websocket_endpoint(ws: WebSocket, room_id: str, client_id: str) -> None:
    """
    WebSocket endpoint for a specific room.

    * Rejects connection if room code does not exist or has expired.
    * Accepts any JSON message from a connected client.
    * Enriches the payload with sender and room metadata.
    * Broadcasts the enriched message to all other clients in the same room.
    """
    room_code = room_id.strip().upper()
    if not room_store.exists(room_code):
        logger.warning("Rejected WebSocket connection: room '%s' does not exist or has expired", room_code)
        await ws.close(code=4004, reason="Room does not exist or has expired")
        return

    room_store.record_join(room_code, client_id)
    await manager.connect(room_code, client_id, ws)

    # Notify others that a new participant joined
    await manager.broadcast(
        room_code,
        sender_id=client_id,
        message={"event": "join", "sender": client_id, "room": room_code},
    )

    try:
        while True:
            raw = await ws.receive_text()
            room_store.record_activity(room_code)

            try:
                payload: dict[str, Any] = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"error": "Invalid JSON", "raw": raw})
                continue

            # Stamp the message with routing metadata
            payload.setdefault("sender", client_id)
            payload.setdefault("room", room_code)

            logger.info("Room '%s' | '%s' -> broadcast: %s", room_code, client_id, payload)
            await manager.broadcast(room_code, sender_id=client_id, message=payload)

    except WebSocketDisconnect:
        manager.disconnect(room_code, client_id)
        remaining = len(manager.room_members(room_code))
        room_store.handle_disconnect(room_code, remaining)
        await manager.broadcast(
            room_code,
            sender_id=client_id,
            message={"event": "leave", "sender": client_id, "room": room_code},
        )

