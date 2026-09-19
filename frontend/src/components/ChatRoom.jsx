/**
 * ChatRoom
 * --------
 * 1-on-1 video chat room with WebRTC peer-to-peer video/audio and
 * WebSocket-based text chat + signaling.
 *
 * URL:  /room/:roomId
 *
 * Boot sequence:
 *   1. GET /ice-servers  →  ICE config fetched from backend on mount.
 *   2. User enters display name.
 *   3. Local camera + mic acquired.
 *   4. WebSocket connects.
 *   5. "join" event received  →  existing peer creates SDP offer.
 *   6. Handshake completes  →  ontrack fires  →  remote video renders.
 *
 * ICE state overlays:
 *   checking (> 4 s)  →  "Connecting via relay…"
 *   failed            →  "Connection failed - try again" + retry button
 *   disconnected      →  "Reconnecting…"
 *   connected relay   →  "Connected via relay" badge
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import useWebSocket, { WS_STATUS } from "../hooks/useWebSocket.js";
import useWebRTC, { RTC_STATUS, ICE_STATE, NETWORK_QUALITY } from "../hooks/useWebRTC.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}
function getClientId() {
  const key = "videochat_client_id";
  let id = sessionStorage.getItem(key);
  if (!id) { id = generateId(); sessionStorage.setItem(key, id); }
  return id;
}
function getDisplayName() { return sessionStorage.getItem("videochat_display_name") ?? ""; }
function saveDisplayName(n) { sessionStorage.setItem("videochat_display_name", n); }

const SIGNALING_TYPES = new Set(["offer", "answer", "ice-candidate"]);

// ─── sub-components ─────────────────────────────────────────────────────────

function MessageBubble({ msg, isOwn }) {
  if (msg.event) {
    return (
      <p className="my-2 text-center text-[11px] text-gray-400 italic">
        {msg.sender} {msg.event === "join" ? "joined" : "left"} the room
      </p>
    );
  }
  return (
    <div className={`flex ${isOwn ? "justify-end" : "justify-start"} mb-2`}>
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
          isOwn
            ? "rounded-br-sm bg-blue-500 text-white"
            : "rounded-bl-sm bg-white text-gray-800"
        }`}
      >
        {!isOwn && (
          <p className="mb-0.5 text-[10px] font-semibold text-blue-500">
            {msg.sender}
          </p>
        )}
        <p className="break-words">{msg.text}</p>
        <p className={`mt-0.5 text-right text-[10px] ${isOwn ? "text-blue-200" : "text-gray-400"}`}>
          {msg.timestamp}
        </p>
      </div>
    </div>
  );
}

function MediaButton({ on, onIcon, offIcon, onClick, label }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-11 w-11 items-center justify-center rounded-full text-lg shadow-lg transition ${
        on ? "bg-gray-700/80 hover:bg-gray-600" : "bg-red-500 hover:bg-red-600"
      }`}
      aria-label={label}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}

/** Overlay shown while waiting for the remote peer to join / ICE to negotiate. */
function WaitingOverlay({ iceState, slowConnecting }) {
  let icon   = "⏳";
  let title  = "Waiting for the other participant…";
  let detail = "Share the room ID to invite them.";
  let spin   = false;

  if (iceState === ICE_STATE.CHECKING) {
    icon   = "🔄";
    title  = slowConnecting ? "Connecting via relay…" : "Connecting…";
    detail = slowConnecting
      ? "STUN failed — routing through TURN relay server."
      : "Negotiating the best connection path.";
    spin   = true;
  } else if (iceState === ICE_STATE.DISCONNECTED) {
    icon   = "📡";
    title  = "Connection interrupted";
    detail = "Attempting to reconnect automatically…";
    spin   = true;
  }

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/80 gap-3">
      <span className={`text-3xl ${spin ? "animate-spin" : ""}`}>{icon}</span>
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="text-xs text-gray-400 text-center px-6">{detail}</p>
    </div>
  );
}

/** Overlay shown when ICE ultimately fails — shows retry button. */
function FailureOverlay({ onRetry }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gray-900/90 gap-4">
      <span className="text-4xl">❌</span>
      <p className="text-sm font-bold text-white">Connection failed - try again</p>
      <p className="text-xs text-gray-400 text-center px-8">
        Could not establish a peer-to-peer connection. This can happen
        behind strict firewalls or carrier-grade NAT.
      </p>
      <button
        onClick={onRetry}
        className="mt-1 rounded-xl bg-blue-500 px-6 py-2 text-sm font-semibold text-white shadow hover:bg-blue-600 active:scale-95 transition"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Small signal-strength pill showing network quality based on getStats data.
 * good → 3 green bars, fair → 2 amber bars, poor → 1 red bar, unknown → hidden.
 */
function NetworkQualityBadge({ quality, stats }) {
  if (quality === "unknown") return null;

  const levels = {
    good: { bars: 3, color: "bg-green-400",  label: "Good"  },
    fair: { bars: 2, color: "bg-amber-400",  label: "Fair"  },
    poor: { bars: 1, color: "bg-red-500",    label: "Poor"  },
  };
  const { bars, color, label } = levels[quality] ?? levels.poor;

  return (
    <div
      className="flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1.5 text-xs text-white backdrop-blur-sm"
      title={`Signal: ${label} — loss ${stats.lossPercent}% · RTT ${stats.rttMs}ms`}
    >
      {/* 3-bar signal icon */}
      <span className="flex items-end gap-[2px] h-3">
        {[1, 2, 3].map((b) => (
          <span
            key={b}
            className={`inline-block w-1 rounded-sm transition-all ${b <= bars ? color : "bg-white/20"}`}
            style={{ height: `${b * 4}px` }}
          />
        ))}
      </span>
      <span className="font-medium">{label}</span>
    </div>
  );
}

// ── Derive API base URL from VITE_WS_URL (wss → https, ws → http) ─────
const apiBase = (() => {
  const wsBase =
    import.meta.env.VITE_WS_URL ||
    (window.location.protocol === "https:"
      ? `wss://${window.location.hostname}`
      : `ws://${window.location.hostname}:8000`);
  return wsBase.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
})();

// ─── main component ─────────────────────────────────────────────────────────

export default function ChatRoom() {
  const { code, roomId: paramRoomId } = useParams();
  const roomId = (code || paramRoomId || "").toUpperCase();
  const navigate = useNavigate();

  // ── Room existence validation ──────────────────────────────────────────
  const [roomValid, setRoomValid] = useState(null); // null = checking, true = valid, false = expired/missing
  const [copiedLink, setCopiedLink] = useState(false);

  // ── Identity ──────────────────────────────────────────────────────────
  const clientIdRef  = useRef(getClientId());
  const [displayName,   setDisplayName]   = useState(getDisplayName);
  const [nameInput,     setNameInput]     = useState("");
  const [nameConfirmed, setNameConfirmed] = useState(!!getDisplayName());

  // ── ICE server config (fetched from backend /ice-servers) ─────────────
  const [iceServers,       setIceServers]       = useState(null);  // null = loading
  const [iceServerError,   setIceServerError]   = useState(null);

  // ── Media readiness gate ──────────────────────────────────────────────
  const [mediaReady, setMediaReady] = useState(false);
  const [mediaError, setMediaError] = useState(null);

  // ── Chat state ────────────────────────────────────────────────────────
  const [messages, setMessages] = useState([]);
  const [draft,    setDraft]    = useState("");
  const bottomRef = useRef(null);
  
  const [isChatOpen, setIsChatOpen] = useState(false);
  const isChatOpenRef = useRef(isChatOpen);
  useEffect(() => { isChatOpenRef.current = isChatOpen; }, [isChatOpen]);
  
  const [unreadCount, setUnreadCount] = useState(0);
  
  // ── UI state ────────────────────────────────────────────────────────
  const [showChrome, setShowChrome] = useState(true);
  const [pipPos, setPipPos] = useState({ x: 0, y: 0 }); // relative transform

  // ── Video element refs ────────────────────────────────────────────────
  const localVideoRef  = useRef(null);
  const remoteVideoRef = useRef(null);

  // ── ICE "slow connecting" heuristic ───────────────────────────────────
  // If ICE is still in "checking" after 4 s, STUN likely failed and the
  // browser is falling back to TURN relay.
  const [slowConnecting, setSlowConnecting] = useState(false);

  // ── Ref bridge: break circular WS ↔ WebRTC dependency ─────────────────
  const handleSignalRef    = useRef(null);
  const createOfferRef     = useRef(null);
  const closePCRef         = useRef(null);
  const retryConnectionRef = useRef(null);

  // ── Stable chat message appender ──────────────────────────────────────
  const appendMessage = useCallback((data, own = false) => {
    setMessages((prev) => [
      ...prev,
      {
        id:        generateId(),
        sender:    data.sender ?? "unknown",
        text:      data.text  ?? null,
        event:     data.event ?? null,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        own,
      },
    ]);
  }, []);

  // ── WebSocket message router ───────────────────────────────────────────
  const handleMessage = useCallback(
    (data) => {
      // 1) WebRTC signaling (offer / answer / ice-candidate)
      if (SIGNALING_TYPES.has(data.type)) {
        handleSignalRef.current?.(data);
        return;
      }
      // 2) Peer sent a retry signal → close our broken PC and wait for new offer
      if (data.type === "retry") {
        closePCRef.current?.();
        return;
      }
      // 3) Peer joined → system message + we create the offer (we are the offerer)
      if (data.event === "join") {
        appendMessage(data);
        createOfferRef.current?.();
        return;
      }
      // 4) Peer left → system message + tear down the peer connection
      if (data.event === "leave") {
        appendMessage(data);
        closePCRef.current?.();
        return;
      }
      // 5) Regular text chat message
      appendMessage(data);
      if (!isChatOpenRef.current && !data.event) {
        setUnreadCount((c) => c + 1);
      }
    },
    [appendMessage]
  );

  // ── Step 0: Validate room exists on mount ────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function checkRoom() {
      if (!roomId) {
        if (!cancelled) setRoomValid(false);
        return;
      }
      for (const url of [
        `${apiBase}/room/${encodeURIComponent(roomId)}/exists`,
        `/room/${encodeURIComponent(roomId)}/exists`,
      ]) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) setRoomValid(data.exists === true);
            return;
          }
        } catch (e) {}
      }
      if (!cancelled) setRoomValid(false);
    }

    checkRoom();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // ── WebSocket URL (only after room valid + name + media + ice servers ready) ──
  const wsUrl =
    roomValid === true && nameConfirmed && mediaReady && iceServers !== null
      ? `${apiBase.replace(/^https?:/, (p) => (p === "https:" ? "wss:" : "ws:"))}/ws/${roomId}/${clientIdRef.current}`
      : null;

  const { status: wsStatus, sendMessage } = useWebSocket(wsUrl, handleMessage);

  // ── WebRTC (ice servers passed in) ────────────────────────────────────
  const {
    localStream,
    remoteStream,
    rtcStatus,
    iceConnectionState,
    isRelaying,
    micOn,
    cameraOn,
    networkQuality,
    networkStats,
    startLocalMedia,
    createOffer,
    handleSignal,
    closePeerConnection,
    retryConnection,
    toggleMic,
    toggleCamera,
  } = useWebRTC(sendMessage, iceServers);

  // Wire stable refs so handleMessage always reaches the latest WebRTC fns.
  useEffect(() => { handleSignalRef.current    = handleSignal;       }, [handleSignal]);
  useEffect(() => { createOfferRef.current     = createOffer;        }, [createOffer]);
  useEffect(() => { closePCRef.current         = closePeerConnection;}, [closePeerConnection]);
  useEffect(() => { retryConnectionRef.current = retryConnection;    }, [retryConnection]);

  // ── Step 1: Fetch ICE servers on mount, before any PeerConnection exists ─
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    fetch(`${apiBase}/ice-servers`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((servers) => {
        clearTimeout(timeout);
        if (!cancelled) setIceServers(servers);
      })
      .catch((err) => {
        clearTimeout(timeout);
        if (!cancelled) {
          const message = err.name === "AbortError"
            ? "Timed out after 3 seconds"
            : err.message;
          console.warn("[ice-servers] Falling back to STUN only:", message);
          // Non-fatal: fall back to Google STUN
          setIceServers([{ urls: "stun:stun.l.google.com:19302" }]);
          setIceServerError(message);
        }
      });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [nameConfirmed, apiBase]);

  // ── Step 2: Acquire local media once name is confirmed ────────────────
  useEffect(() => {
    if (!nameConfirmed) return;
    let cancelled = false;
    startLocalMedia()
      .then(() => { if (!cancelled) setMediaReady(true); })
      .catch((err) => { if (!cancelled) setMediaError(err.message); });
    return () => { cancelled = true; };
  }, [nameConfirmed, startLocalMedia]);

  // ── Bind streams to <video> elements ──────────────────────────────────
  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream ?? null;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream ?? null;
  }, [remoteStream]);

  // ── Auto-scroll chat ──────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Slow-connecting heuristic: set flag after 4 s in "checking" state ─
  useEffect(() => {
    if (iceConnectionState !== ICE_STATE.CHECKING) {
      setSlowConnecting(false);
      return;
    }
    const t = setTimeout(() => setSlowConnecting(true), 4000);
    return () => clearTimeout(t);
  }, [iceConnectionState]);

  // ── Auto-hide chrome timer ────────────────────────────────────────────
  useEffect(() => {
    let timeout;
    function resetTimer() {
      setShowChrome(true);
      clearTimeout(timeout);
      timeout = setTimeout(() => setShowChrome(false), 4000);
    }
    
    // Initial start
    resetTimer();
    
    // Attach to window so any interaction keeps chrome alive
    window.addEventListener("pointermove", resetTimer);
    window.addEventListener("touchstart", resetTimer);
    window.addEventListener("keydown", resetTimer);
    
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("pointermove", resetTimer);
      window.removeEventListener("touchstart", resetTimer);
      window.removeEventListener("keydown", resetTimer);
    };
  }, []);

  // ── Send chat message ─────────────────────────────────────────────────
  function handleSend(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || wsStatus !== WS_STATUS.OPEN) return;
    const payload = { type: "chat", text, sender: displayName || clientIdRef.current };
    sendMessage(payload);
    appendMessage(payload, true);
    setDraft("");
  }

  // ════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════

  // ── 0. Room validation in progress ────────────────────────────────────
  if (roomValid === null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-900 text-white">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-400 border-t-transparent" />
        <p className="text-sm text-gray-400">Validating room code…</p>
      </div>
    );
  }

  // ── 0b. Room invalid or expired ───────────────────────────────────────
  if (roomValid === false) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100 p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-lg border border-gray-100">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-red-500 text-2xl">
            ⚠️
          </div>
          <h1 className="text-lg font-bold text-gray-900">Room Not Found</h1>
          <p className="mt-2 text-xs text-gray-500 leading-relaxed">
            Room <span className="font-mono font-bold text-gray-800">{roomId}</span> does not exist, or has expired after 1 hour of inactivity or peer disconnection.
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="mt-5 w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white shadow transition hover:bg-blue-700 active:scale-95"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  // ── 1. Name entry ─────────────────────────────────────────────────────
  if (!nameConfirmed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100 p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg">
          <h1 className="mb-1 text-center text-xl font-bold text-gray-800">Join Room</h1>
          <p className="mb-4 text-center text-sm text-gray-500">
            Room: <span className="font-mono font-semibold text-blue-600">{roomId}</span>
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = nameInput.trim() || `user-${generateId()}`;
              saveDisplayName(name);
              setDisplayName(name);
              setNameConfirmed(true);
            }}
          >
            <input
              autoFocus
              type="text"
              placeholder="Your display name (optional)"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            />
            <button
              type="submit"
              className="w-full rounded-lg bg-blue-500 py-2 text-sm font-semibold text-white transition hover:bg-blue-600 active:scale-95"
            >
              Enter Room
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── 2. Loading screen (ICE servers + camera in parallel) ──────────────
  if (!mediaReady || iceServers === null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-900 text-white">
        {mediaError ? (
          <>
            <p className="text-5xl">📷</p>
            <p className="max-w-xs text-center text-sm text-red-400">{mediaError}</p>
            <button
              onClick={() => {
                setMediaError(null);
                startLocalMedia()
                  .then(() => setMediaReady(true))
                  .catch((err) => setMediaError(err.message));
              }}
              className="rounded-lg bg-blue-500 px-5 py-2 text-sm font-medium hover:bg-blue-600"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-400 border-t-transparent" />
            <p className="text-sm text-gray-400">
              {iceServers === null ? "Loading connection config…" : "Requesting camera & microphone…"}
            </p>
            {iceServerError && (
              <p className="text-xs text-yellow-400">
                ⚠ TURN server unavailable — using STUN only
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  // ── 3. Main UI ────────────────────────────────────────────────────────
  const iceFailed       = iceConnectionState === ICE_STATE.FAILED;
  const iceChecking     = iceConnectionState === ICE_STATE.CHECKING;
  const iceDisconnected = iceConnectionState === ICE_STATE.DISCONNECTED;
  const showWaiting     = !remoteStream && !iceFailed;
  const showWaitingIce  = iceChecking || iceDisconnected;

  return (
    <div className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-black text-white selection:bg-blue-500/30">
      
      {/* ── Background: Remote Video ── */}
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        className="absolute inset-0 h-full w-full object-cover z-0"
      />

      {/* ICE failure overlay — highest z priority */}
      {iceFailed && <FailureOverlay onRetry={() => retryConnectionRef.current?.()} />}

      {/* Waiting / connecting overlays */}
      {showWaiting && (
        <WaitingOverlay iceState={iceConnectionState} slowConnecting={slowConnecting} />
      )}

      {/* ── Top Chrome: Room Pill ── */}
      <div 
        className={`absolute left-0 right-0 top-safe mt-6 z-30 flex justify-center p-4 transition-opacity duration-500 ${showChrome || isChatOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        <button
          onClick={() => {
            navigator.clipboard.writeText(roomId);
            setCopiedLink(true);
            setTimeout(() => setCopiedLink(false), 2000);
          }}
          className="flex items-center gap-2 rounded-full bg-black/40 px-4 py-2 text-sm font-semibold backdrop-blur-md transition active:scale-95"
        >
          <span className="opacity-70">Room:</span>
          <span className="font-mono text-blue-300">{roomId}</span>
          <span className="ml-1 text-xs">{copiedLink ? "✓" : "📋"}</span>
        </button>
      </div>

      {/* ── Status badges (top-left) ── */}
      <div className={`absolute left-4 top-24 z-30 flex flex-col gap-2 transition-opacity duration-500 ${showChrome ? "opacity-100" : "opacity-0"}`}>
        {isRelaying && (
          <div className="flex items-center gap-2 rounded-full bg-amber-500/80 px-3 py-1.5 text-xs font-semibold backdrop-blur-sm">
            <span className="inline-block h-2 w-2 rounded-full bg-white" />
            Via relay
          </div>
        )}
        {rtcStatus === RTC_STATUS.CONNECTED && !isRelaying && (
          <div className="flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs text-green-400 backdrop-blur-sm">
            <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
            Connected
          </div>
        )}
        <NetworkQualityBadge quality={networkQuality} stats={networkStats} />
      </div>

      {/* ── Draggable Local Video PiP ── */}
      <div
        className="absolute right-4 top-24 z-40 h-40 w-28 cursor-grab overflow-hidden rounded-2xl border border-white/20 shadow-2xl active:cursor-grabbing sm:h-48 sm:w-32 transition-transform duration-75"
        style={{ transform: `translate(${pipPos.x}px, ${pipPos.y}px)` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.dataset.dragging = "true";
          e.currentTarget.dataset.startX = e.clientX - pipPos.x;
          e.currentTarget.dataset.startY = e.clientY - pipPos.y;
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.dataset.dragging !== "true") return;
          const x = e.clientX - parseFloat(e.currentTarget.dataset.startX);
          const y = e.clientY - parseFloat(e.currentTarget.dataset.startY);
          setPipPos({ x, y });
        }}
        onPointerUp={(e) => {
          e.currentTarget.dataset.dragging = "false";
          e.currentTarget.releasePointerCapture(e.pointerId);
          const rect = e.currentTarget.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const ww = window.innerWidth;
          const wh = window.innerHeight;
          
          const isLeft = cx < ww / 2;
          const isBottom = cy > wh / 2;
          
          let targetX = 0;
          let targetY = 0;
          if (isLeft) targetX = -(ww - rect.width - 32); 
          if (isBottom) targetY = wh - rect.height - 180;
          
          setPipPos({ x: targetX, y: targetY });
        }}
      >
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          className="h-full w-full object-cover bg-gray-900"
        />
      </div>

      {/* ── Bottom Action Bar ── */}
      <div
        className={`absolute bottom-8 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-full bg-black/40 px-6 py-3 backdrop-blur-xl transition-all duration-500 sm:gap-6 ${
          showChrome && !isChatOpen ? "translate-y-0 opacity-100" : "translate-y-24 opacity-0 pointer-events-none"
        }`}
      >
        <MediaButton on={micOn} onIcon="🎙️" offIcon="🔇" onClick={toggleMic} label="Mic" />
        <MediaButton on={cameraOn} onIcon="📹" offIcon="📷" onClick={toggleCamera} label="Camera" />
        
        {/* Chat Toggle Button */}
        <button
          onClick={() => {
            setIsChatOpen(true);
            setUnreadCount(0);
          }}
          className="relative flex h-11 w-11 items-center justify-center rounded-full bg-gray-700/80 text-xl shadow-lg transition hover:bg-gray-600"
        >
          💬
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white shadow">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>

        <button
          onClick={() => navigate("/")}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-red-600 text-xl shadow-lg transition hover:bg-red-700 active:scale-95"
        >
          📞
        </button>
      </div>

      {/* ── Swipe-up Chat Drawer ── */}
      <div
        className={`fixed inset-0 z-50 flex flex-col justify-end transition-opacity duration-300 ${
          isChatOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {/* Backdrop overlay */}
        <div 
          className="absolute inset-0 bg-black/40 backdrop-blur-sm" 
          onClick={() => setIsChatOpen(false)} 
        />
        
        {/* Bottom Sheet */}
        <div
          className={`relative flex h-[75vh] w-full max-w-md mx-auto flex-col rounded-t-3xl bg-gray-900 shadow-2xl transition-transform duration-300 ${
            isChatOpen ? "translate-y-0" : "translate-y-full"
          }`}
        >
          {/* Drag Handle / Header */}
          <div 
            className="flex w-full cursor-pointer flex-col items-center p-4"
            onClick={() => setIsChatOpen(false)}
          >
            <div className="h-1.5 w-12 rounded-full bg-gray-600" />
            <span className="mt-3 text-xs font-bold uppercase tracking-wider text-gray-400">Chat</span>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 pb-2">
            {messages.length === 0 && (
              <p className="mt-8 text-center text-xs text-gray-500">
                No messages yet. Say hello! 👋
              </p>
            )}
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} isOwn={msg.own === true} />
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input Bar */}
          <form
            onSubmit={handleSend}
            className="border-t border-gray-800 bg-gray-900 p-4 pb-6"
          >
            <div className="flex items-center gap-3 rounded-full bg-gray-800 px-4 py-2">
              <input
                type="text"
                placeholder={wsStatus === WS_STATUS.OPEN ? "Message…" : "Connecting…"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={wsStatus !== WS_STATUS.OPEN}
                className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-gray-500 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!draft.trim() || wsStatus !== WS_STATUS.OPEN}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40 active:scale-95"
              >
                ➤
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
