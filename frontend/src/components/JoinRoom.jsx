/**
 * JoinRoom
 * --------
 * Landing page with two options:
 *   1. "Create Room" — calls POST /create-room, displays the 6-character room
 *      code large & copyable, shows "waiting for other person" indicator, and
 *      allows entering the call screen.
 *   2. "Join Room" — 6-box auto-advancing code input, validates via
 *      GET /room/{code}/exists before navigating to /room/:code.
 */
import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";

// Allowed characters: uppercase letters and digits excluding ambiguous 0, O, 1, I
const ALLOWED_CHARS_REGEX = /^[2-9A-HJ-NP-Z]$/i;

const apiBase = (() => {
  const wsBase =
    import.meta.env.VITE_WS_URL ||
    (window.location.protocol === "https:"
      ? `wss://${window.location.hostname}`
      : `ws://${window.location.hostname}:8000`);
  return wsBase.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
})();

async function fetchCreateRoom() {
  for (const url of [`${apiBase}/create-room`, `/create-room`]) {
    try {
      const res = await fetch(url, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        return data.code || data.room_code;
      }
    } catch (err) {}
  }
  throw new Error("Unable to reach server to create room.");
}

async function fetchRoomExists(code) {
  for (const url of [
    `${apiBase}/room/${encodeURIComponent(code)}/exists`,
    `/room/${encodeURIComponent(code)}/exists`,
  ]) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        return data.exists === true;
      }
    } catch (err) {}
  }
  return false;
}

export default function JoinRoom() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("create"); // "create" | "join"

  // ── Create Room State ──────────────────────────────────────────────────────
  const [createdCode, setCreatedCode] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // ── Join Room State (6-box input) ──────────────────────────────────────────
  const [boxes, setBoxes] = useState(["", "", "", "", "", ""]);
  const [isValidating, setIsValidating] = useState(false);
  const [joinError, setJoinError] = useState("");
  const boxRefs = useRef([]);

  // Auto-focus first box when switching to "join" tab
  useEffect(() => {
    if (activeTab === "join") {
      boxRefs.current[0]?.focus();
    }
  }, [activeTab]);

  // ── Create Room Handler ────────────────────────────────────────────────────
  async function handleCreateRoom() {
    setIsCreating(true);
    setCreateError("");
    try {
      const code = await fetchCreateRoom();
      setCreatedCode(code);
    } catch (err) {
      setCreateError(err.message || "Failed to create room. Please try again.");
    } finally {
      setIsCreating(false);
    }
  }

  function handleCopyCode() {
    if (!createdCode) return;
    navigator.clipboard.writeText(createdCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  }

  function handleCopyLink() {
    if (!createdCode) return;
    const link = `${window.location.origin}/room/${createdCode}`;
    navigator.clipboard.writeText(link);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  }

  // ── Auto-poll while waiting for other person to join ──────────────────────
  useEffect(() => {
    if (!createdCode || activeTab !== "create") return;
    let timer = null;
    let cancelled = false;

    async function checkPeerJoined() {
      try {
        const res = await fetch(`${apiBase}/rooms`);
        if (res.ok) {
          const data = await res.json();
          const members = data.active_rooms?.[createdCode] || [];
          if (members.length > 0 && !cancelled) {
            navigate(`/room/${createdCode}`);
            return;
          }
        }
      } catch (e) {}

      if (!cancelled) {
        timer = setTimeout(checkPeerJoined, 2500);
      }
    }

    timer = setTimeout(checkPeerJoined, 2500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [createdCode, activeTab, navigate]);

  // ── Validation & Join ──────────────────────────────────────────────────────
  async function validateAndJoin(fullCode) {
    const code = fullCode.trim().toUpperCase();
    if (code.length < 6) {
      setJoinError("Please enter all 6 characters of the room code.");
      return;
    }

    setIsValidating(true);
    setJoinError("");

    try {
      const exists = await fetchRoomExists(code);
      if (exists) {
        navigate(`/room/${code}`);
      } else {
        setJoinError(`Room "${code}" does not exist or has expired.`);
      }
    } catch (err) {
      setJoinError("Failed to validate room code. Please try again.");
    } finally {
      setIsValidating(false);
    }
  }

  // ── 6-Box Input Handlers ───────────────────────────────────────────────────
  function handleBoxChange(index, e) {
    const rawValue = e.target.value;
    const char = rawValue.slice(-1).toUpperCase();

    // Reset errors when typing
    if (joinError) setJoinError("");

    if (!char) {
      const newBoxes = [...boxes];
      newBoxes[index] = "";
      setBoxes(newBoxes);
      return;
    }

    // Check if character is valid (excluding ambiguous 0, O, 1, I)
    if (!ALLOWED_CHARS_REGEX.test(char)) {
      return;
    }

    const newBoxes = [...boxes];
    newBoxes[index] = char;
    setBoxes(newBoxes);

    // Auto-advance to next box
    if (index < 5) {
      boxRefs.current[index + 1]?.focus();
    }

    // Auto-validate if all 6 boxes are now filled
    const fullCode = newBoxes.join("").trim().toUpperCase();
    if (fullCode.length === 6) {
      validateAndJoin(fullCode);
    }
  }

  function handleKeyDown(index, e) {
    if (e.key === "Backspace") {
      if (!boxes[index] && index > 0) {
        boxRefs.current[index - 1]?.focus();
        const newBoxes = [...boxes];
        newBoxes[index - 1] = "";
        setBoxes(newBoxes);
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      boxRefs.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < 5) {
      boxRefs.current[index + 1]?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleJoinSubmit();
    }
  }

  function handlePaste(e) {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").trim();
    if (!pastedData) return;

    // Extract potential code from full URL or raw string
    const match = pastedData.match(/([2-9A-HJ-NP-Za-hj-np-z]{6})/);
    const candidate = match ? match[1].toUpperCase() : pastedData.toUpperCase();

    // Filter characters
    const filteredChars = candidate
      .split("")
      .filter((c) => ALLOWED_CHARS_REGEX.test(c))
      .slice(0, 6);

    if (filteredChars.length === 0) return;

    const newBoxes = [...boxes];
    filteredChars.forEach((ch, i) => {
      newBoxes[i] = ch;
    });
    setBoxes(newBoxes);

    // Focus last filled box or next empty box
    const nextIndex = Math.min(filteredChars.length, 5);
    boxRefs.current[nextIndex]?.focus();

    if (filteredChars.length === 6) {
      validateAndJoin(filteredChars.join("").toUpperCase());
    }
  }

  async function handleJoinSubmit(e) {
    if (e) e.preventDefault();
    const fullCode = boxes.join("").trim().toUpperCase();
    await validateAndJoin(fullCode);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-blue-50 via-slate-50 to-gray-100 p-4 text-gray-800">
      {/* Header */}
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 sm:text-4xl">
          Video Chat
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Instant, secure 1-on-1 video &amp; text rooms
        </p>
      </div>

      {/* Main Card */}
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl border border-gray-100">
        {/* Tab Switcher */}
        <div className="mb-6 flex rounded-xl bg-gray-100 p-1">
          <button
            type="button"
            onClick={() => {
              setActiveTab("create");
              setJoinError("");
            }}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
              activeTab === "create"
                ? "bg-white text-blue-600 shadow-sm"
                : "text-gray-500 hover:text-gray-900"
            }`}
          >
            Create Room
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab("join");
              setCreateError("");
            }}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
              activeTab === "join"
                ? "bg-white text-blue-600 shadow-sm"
                : "text-gray-500 hover:text-gray-900"
            }`}
          >
            Join Room
          </button>
        </div>

        {/* ── Tab 1: Create Room ──────────────────────────────────────────── */}
        {activeTab === "create" && (
          <div className="flex flex-col gap-4">
            {!createdCode ? (
              <div className="flex flex-col items-center gap-4 text-center py-2">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-50 text-blue-500 text-3xl">
                  📹
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-800">
                    Host a New Call
                  </h2>
                  <p className="mt-1 text-xs text-gray-500 max-w-xs">
                    Generate a random 6-character room code to share with your
                    guest. No signup required.
                  </p>
                </div>

                {createError && (
                  <p className="rounded-lg bg-red-50 p-2 text-xs text-red-600 w-full">
                    {createError}
                  </p>
                )}

                <button
                  type="button"
                  disabled={isCreating}
                  onClick={handleCreateRoom}
                  className="mt-2 w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-blue-700 active:scale-95 disabled:opacity-50"
                >
                  {isCreating ? "Generating Room..." : "Create Room →"}
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 text-center">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                  Your Room Code
                </p>

                {/* Large Copyable Code Display */}
                <div className="w-full rounded-2xl bg-blue-50/80 border-2 border-dashed border-blue-300 p-4">
                  <span className="select-all font-mono text-4xl font-extrabold tracking-[0.25em] text-blue-700 pl-2">
                    {createdCode}
                  </span>
                </div>

                {/* Copy Buttons */}
                <div className="flex w-full gap-2">
                  <button
                    type="button"
                    onClick={handleCopyCode}
                    className="flex-1 rounded-lg border border-gray-300 bg-white py-2 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50 active:scale-95"
                  >
                    {copiedCode ? "✓ Code Copied!" : "📋 Copy Code"}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="flex-1 rounded-lg border border-gray-300 bg-white py-2 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50 active:scale-95"
                  >
                    {copiedLink ? "✓ Link Copied!" : "🔗 Copy Link"}
                  </button>
                </div>

                {/* Waiting State */}
                <div className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-amber-50 px-4 py-2.5 text-xs text-amber-800 border border-amber-200/60 w-full">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
                  </span>
                  <span>Waiting for other person to join…</span>
                </div>

                {/* Action Buttons */}
                <div className="mt-2 flex w-full flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => navigate(`/room/${createdCode}`)}
                    className="w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-blue-700 active:scale-95"
                  >
                    Enter Room Now →
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreatedCode("");
                      setCreateError("");
                    }}
                    className="text-xs text-gray-400 hover:text-gray-600 py-1"
                  >
                    Generate another code
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Tab 2: Join Room (6-box Code Input) ─────────────────────────── */}
        {activeTab === "join" && (
          <form onSubmit={handleJoinSubmit} className="flex flex-col gap-4">
            <div className="text-center">
              <h2 className="text-sm font-bold text-gray-800">
                Enter Room Code
              </h2>
              <p className="mt-0.5 text-xs text-gray-500">
                Type or paste the 6-character code you received
              </p>
            </div>

            {/* 6-box input container */}
            <div
              className="flex justify-between gap-2 my-2"
              onPaste={handlePaste}
            >
              {boxes.map((digit, idx) => (
                <input
                  key={idx}
                  ref={(el) => (boxRefs.current[idx] = el)}
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck="false"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleBoxChange(idx, e)}
                  onKeyDown={(e) => handleKeyDown(idx, e)}
                  onPaste={handlePaste}
                  className="h-12 w-11 sm:h-14 sm:w-12 rounded-xl border-2 border-gray-200 bg-gray-50 text-center font-mono text-xl sm:text-2xl font-bold uppercase text-gray-800 outline-none transition focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100"
                />
              ))}
            </div>

            {/* Error Display */}
            {joinError && (
              <div className="rounded-lg bg-red-50 p-2.5 text-xs font-medium text-red-600 text-center border border-red-200">
                {joinError}
              </div>
            )}

            <button
              type="submit"
              disabled={isValidating || boxes.join("").trim().length < 6}
              className="mt-1 w-full rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-blue-700 active:scale-95 disabled:opacity-50"
            >
              {isValidating ? "Validating code…" : "Join Room →"}
            </button>
          </form>
        )}
      </div>

      {/* Footer Info */}
      <p className="mt-6 text-center text-xs text-gray-400">
        Peer-to-peer encrypted · Room codes auto-expire after 1 hour
      </p>
    </div>
  );
}
