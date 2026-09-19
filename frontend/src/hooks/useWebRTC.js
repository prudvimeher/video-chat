/**
 * useWebRTC
 * ---------
 * Manages a single RTCPeerConnection for 1-on-1 peer-to-peer video/audio.
 *
 * ICE server config (STUN + TURN) is passed in from the outside so
 * credentials stay in the backend .env and are never hardcoded here.
 *
 * Key behaviours
 * ──────────────
 * • oniceconnectionstatechange tracks ICE state and exposes it as React state.
 * • When ICE reaches "connected" / "completed", pc.getStats() is called to
 *   detect whether the active candidate pair is a relay (TURN) type.
 * • retryConnection() closes the dead PC, signals the peer to do the same,
 *   then re-creates the offer so the call can restart cleanly.
 * • RTCRtpTransceiver.setCodecPreferences() prefers VP9, then H.264.
 * • RTCRtpSender.setParameters() enforces a target video bitrate.
 * • getStats() is polled every 2 s to compute packet loss % + RTT.
 *   If loss > 5% for 3 consecutive checks, bitrate is stepped down to
 *   LOW_BITRATE_BPS. It recovers back to HIGH_BITRATE_BPS after
 *   RECOVER_CHECKS clean intervals.
 */
import { useEffect, useRef, useCallback, useState } from "react";

// Fallback used only when the ICE-config request fails or times out.
const STUN_ONLY = [{ urls: "stun:stun.l.google.com:19302" }];
const ICE_CONFIG_TIMEOUT_MS = 3000;

// ── Bitrate constants (bps) ────────────────────────────────────────────────
const HIGH_BITRATE_BPS  = 2_500_000;   // normal quality target
const LOW_BITRATE_BPS   = 1_000_000;   // degraded-network fallback
const LOSS_THRESHOLD    = 0.05;        // 5% packet loss triggers step-down
const LOSS_CHECKS_LIMIT = 3;           // consecutive bad intervals before step-down
const RECOVER_CHECKS    = 5;           // clean intervals before restoring high bitrate
const STATS_INTERVAL_MS = 2_000;

// ── Preferred codec order ─────────────────────────────────────────────────
const PREFERRED_VIDEO_CODECS = ["VP9", "H264"];

const MEDIA_CONSTRAINTS = {
  video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: true,
};

// ─── exported status enums ───────────────────────────────────────────────────

export const RTC_STATUS = {
  IDLE:         "idle",
  CONNECTING:   "connecting",
  CONNECTED:    "connected",
  DISCONNECTED: "disconnected",
  FAILED:       "failed",
};

export const ICE_STATE = {
  IDLE:         "idle",        // before first connection
  CHECKING:     "checking",    // ICE negotiation in progress
  CONNECTED:    "connected",   // at least one working candidate pair
  COMPLETED:    "completed",   // all candidates checked, best pair selected
  FAILED:       "failed",      // ICE failed — no working pair found
  DISCONNECTED: "disconnected",// temporary loss — may recover automatically
  CLOSED:       "closed",
};

export const NETWORK_QUALITY = {
  UNKNOWN: "unknown",
  GOOD:    "good",    // loss < 2%, RTT < 150 ms
  FAIR:    "fair",    // loss < 5%, RTT < 300 ms
  POOR:    "poor",    // anything worse
};

// ─── codec helpers ────────────────────────────────────────────────────────────

/**
 * Sort the supported codecs so that PREFERRED_VIDEO_CODECS appear first (in
 * order), with everything else preserved afterwards. Does not mutate the input.
 */
function reorderCodecs(codecs) {
  const preferred = [];
  const rest = [];
  for (const name of PREFERRED_VIDEO_CODECS) {
    for (const c of codecs) {
      if (c.mimeType?.toLowerCase() === `video/${name.toLowerCase()}`) {
        preferred.push(c);
      }
    }
  }
  for (const c of codecs) {
    if (!preferred.includes(c)) rest.push(c);
  }
  return [...preferred, ...rest];
}

/**
 * Apply codec preferences on all video transceivers.
 * setCodecPreferences is not supported on all browsers; we guard for that.
 */
function applyCodecPreferences(pc) {
  try {
    for (const transceiver of pc.getTransceivers()) {
      if (
        transceiver.sender?.track?.kind === "video" &&
        typeof transceiver.setCodecPreferences === "function"
      ) {
        const supported = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
        if (supported.length) {
          transceiver.setCodecPreferences(reorderCodecs(supported));
          logger("[WebRTC] Applied codec preferences: VP9 → H264 → rest");
        }
      }
    }
  } catch (err) {
    logger("[WebRTC] setCodecPreferences not supported or failed:", err.message);
  }
}

/**
 * Set target max bitrate on the first video sender.
 * setParameters() must be called with the object returned by getParameters()
 * to preserve unknown fields that the browser may have added.
 */
async function applyBitrate(pc, targetBps) {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings.forEach((enc) => {
        enc.maxBitrate = targetBps;
      });
      await sender.setParameters(params);
      logger(`[WebRTC] Video bitrate target set to ${(targetBps / 1_000_000).toFixed(2)} Mbps`);
    } catch (err) {
      logger("[WebRTC] setParameters failed:", err.message);
    }
    break; // only the first video sender
  }
}

// ─── hook ────────────────────────────────────────────────────────────────────

/**
 * @param {Function} sendMessage  – stable callback from useWebSocket
 * @param {Array}    iceServers   – ICE server list fetched from /ice-servers
 */
export default function useWebRTC(sendMessage, iceServers) {
  const pcRef                = useRef(null);
  const pcPromiseRef         = useRef(null);
  const localStreamRef       = useRef(null);
  const pendingCandidatesRef = useRef([]);

  // ── Bitrate + stats tracking ────────────────────────────────────────────
  const currentBitrateRef   = useRef(HIGH_BITRATE_BPS);
  const statsIntervalRef    = useRef(null);
  const lossCheckCountRef   = useRef(0);   // consecutive bad intervals
  const cleanCheckCountRef  = useRef(0);   // consecutive clean intervals
  // Last packet counters — used to compute loss over the interval.
  const prevStatsRef = useRef({ packetsSent: 0, packetsLost: 0, timestamp: 0 });

  // A PeerConnection must not capture the STUN fallback while the backend's
  // TURN config is still in flight.  This promise is resolved by the fetch
  // result, or by ensurePC's three-second safety timeout.
  const iceConfigRef = useRef({
    servers: Array.isArray(iceServers) ? (iceServers.length ? iceServers : STUN_ONLY) : null,
    resolved: Array.isArray(iceServers),
    promise: null,
    resolve: null,
  });

  const resolveIceConfig = useCallback((servers) => {
    const config = iceConfigRef.current;
    if (config.resolved) return config.servers;
    config.servers = servers?.length ? servers : STUN_ONLY;
    config.resolved = true;
    config.resolve?.(config.servers);
    return config.servers;
  }, []);

  useEffect(() => {
    // ChatRoom sets a STUN-only array when its request has failed, so a
    // non-null value always means the request has settled.
    if (Array.isArray(iceServers)) resolveIceConfig(iceServers);
  }, [iceServers, resolveIceConfig]);

  // Stable ref so PeerConnection event callbacks never stale-close over sendMessage.
  const sendRef = useRef(sendMessage);
  useEffect(() => { sendRef.current = sendMessage; }, [sendMessage]);

  // ── React state exposed to the component ──────────────────────────────
  const [localStream,        setLocalStream]        = useState(null);
  const [remoteStream,       setRemoteStream]        = useState(null);
  const [rtcStatus,          setRtcStatus]           = useState(RTC_STATUS.IDLE);
  const [iceConnectionState, setIceConnectionState]  = useState(ICE_STATE.IDLE);
  const [isRelaying,         setIsRelaying]          = useState(false);
  const [micOn,              setMicOn]               = useState(true);
  const [cameraOn,           setCameraOn]            = useState(true);
  const [networkQuality,     setNetworkQuality]      = useState(NETWORK_QUALITY.UNKNOWN);
  const [networkStats,       setNetworkStats]        = useState({ lossPercent: 0, rttMs: 0 });

  // ── Local media ────────────────────────────────────────────────────────
  const startLocalMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  }, []);

  // ── Stats polling ──────────────────────────────────────────────────────
  const stopStatsPolling = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
  }, []);

  /**
   * Poll getStats() every STATS_INTERVAL_MS and update quality indicator.
   * Also runs the auto step-down logic on sustained high packet loss.
   */
  const startStatsPolling = useCallback((pc) => {
    stopStatsPolling();
    prevStatsRef.current = { packetsSent: 0, packetsLost: 0, timestamp: 0 };
    lossCheckCountRef.current = 0;
    cleanCheckCountRef.current = 0;

    statsIntervalRef.current = setInterval(async () => {
      if (!pcRef.current || pcRef.current.connectionState === "closed") {
        stopStatsPolling();
        return;
      }

      try {
        const stats = await pc.getStats();

        let currentPacketsSent = 0;
        let currentPacketsLost = 0;
        let rttMs = 0;

        stats.forEach((report) => {
          // Outbound video RTP — for packet loss
          if (report.type === "outbound-rtp" && report.kind === "video") {
            currentPacketsSent += report.packetsSent ?? 0;
            currentPacketsLost += report.retransmittedPacketsSent ?? 0; // proxy for lost
          }
          // Remote inbound — actual packet loss reported by receiver
          if (report.type === "remote-inbound-rtp" && report.kind === "video") {
            currentPacketsLost = report.packetsLost ?? currentPacketsLost;
            // RTT comes from remote-inbound or candidate-pair
            if (report.roundTripTime != null) {
              rttMs = Math.round(report.roundTripTime * 1000);
            }
          }
          // Candidate pair RTT (fallback)
          if (
            report.type === "candidate-pair" &&
            report.nominated &&
            report.currentRoundTripTime != null &&
            rttMs === 0
          ) {
            rttMs = Math.round(report.currentRoundTripTime * 1000);
          }
        });

        const prev = prevStatsRef.current;
        const sentDelta = currentPacketsSent - prev.packetsSent;
        const lostDelta = Math.max(0, currentPacketsLost - prev.packetsLost);
        const lossPercent = sentDelta > 0 ? lostDelta / (sentDelta + lostDelta) : 0;

        prevStatsRef.current = {
          packetsSent: currentPacketsSent,
          packetsLost: currentPacketsLost,
          timestamp: Date.now(),
        };

        // Update quality state
        let quality;
        if (lossPercent < 0.02 && rttMs < 150) {
          quality = NETWORK_QUALITY.GOOD;
        } else if (lossPercent < LOSS_THRESHOLD && rttMs < 300) {
          quality = NETWORK_QUALITY.FAIR;
        } else {
          quality = NETWORK_QUALITY.POOR;
        }
        setNetworkQuality(quality);
        setNetworkStats({ lossPercent: Math.round(lossPercent * 100), rttMs });

        // ── Auto step-down logic ───────────────────────────────────────
        if (lossPercent > LOSS_THRESHOLD) {
          lossCheckCountRef.current += 1;
          cleanCheckCountRef.current = 0;

          if (
            lossCheckCountRef.current >= LOSS_CHECKS_LIMIT &&
            currentBitrateRef.current !== LOW_BITRATE_BPS
          ) {
            logger(`[WebRTC] Stepping down bitrate to ${LOW_BITRATE_BPS / 1_000_000} Mbps (loss=${Math.round(lossPercent * 100)}%)`);
            currentBitrateRef.current = LOW_BITRATE_BPS;
            await applyBitrate(pc, LOW_BITRATE_BPS);
          }
        } else {
          lossCheckCountRef.current = 0;
          cleanCheckCountRef.current += 1;

          if (
            cleanCheckCountRef.current >= RECOVER_CHECKS &&
            currentBitrateRef.current !== HIGH_BITRATE_BPS
          ) {
            logger(`[WebRTC] Recovering bitrate to ${HIGH_BITRATE_BPS / 1_000_000} Mbps`);
            currentBitrateRef.current = HIGH_BITRATE_BPS;
            await applyBitrate(pc, HIGH_BITRATE_BPS);
          }
        }
      } catch {
        // getStats() may fail transiently; safe to ignore.
      }
    }, STATS_INTERVAL_MS);
  }, [stopStatsPolling]);

  // ── Create RTCPeerConnection (lazy, only when needed) ──────────────────
  const waitForIceConfig = useCallback(async () => {
    const config = iceConfigRef.current;
    if (config.resolved) return config.servers;

    if (!config.promise) {
      config.promise = new Promise((resolve) => { config.resolve = resolve; });
    }

    await Promise.race([
      config.promise,
      new Promise((resolve) => setTimeout(() => {
        if (!config.resolved) {
          console.warn("[ice-servers] Timed out after 3 seconds; using STUN only.");
          resolveIceConfig(STUN_ONLY);
        }
        resolve();
      }, ICE_CONFIG_TIMEOUT_MS)),
    ]);
    return config.servers;
  }, [resolveIceConfig]);

  const ensurePC = useCallback(async () => {
    if (pcRef.current) return pcRef.current;
    if (pcPromiseRef.current) return pcPromiseRef.current;

    pcPromiseRef.current = (async () => {
    const servers = await waitForIceConfig();
    const pc = new RTCPeerConnection({ iceServers: servers });
    pcRef.current = pc;
    setRtcStatus(RTC_STATUS.CONNECTING);
    setIceConnectionState(ICE_STATE.IDLE);
    setIsRelaying(false);
    setNetworkQuality(NETWORK_QUALITY.UNKNOWN);
    currentBitrateRef.current = HIGH_BITRATE_BPS;

    // Attach local tracks so they are included in the SDP offer/answer.
    localStreamRef.current?.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current);
    });

    // Apply codec preferences immediately after adding tracks (before offer/answer).
    applyCodecPreferences(pc);

    // Set initial bitrate target once transceivers are available.
    // We use a microtask delay so the engine has processed addTrack internally.
    queueMicrotask(() => applyBitrate(pc, HIGH_BITRATE_BPS));

    // Relay ICE candidates to the remote peer via WebSocket.
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        sendRef.current({ type: "ice-candidate", candidate: candidate.toJSON() });
      }
    };

    // Expose remote media stream to the component.
    pc.ontrack = (event) => {
      setRemoteStream(event.streams[0] ?? null);
    };

    // High-level connection lifecycle (DTLS + ICE combined).
    pc.onconnectionstatechange = () => {
      const map = {
        connecting:   RTC_STATUS.CONNECTING,
        connected:    RTC_STATUS.CONNECTED,
        disconnected: RTC_STATUS.DISCONNECTED,
        failed:       RTC_STATUS.FAILED,
        closed:       RTC_STATUS.IDLE,
      };
      setRtcStatus(map[pc.connectionState] ?? RTC_STATUS.IDLE);
    };

    // ── ICE-layer state: the primary UX signal ─────────────────────────
    pc.oniceconnectionstatechange = async () => {
      const state = pc.iceConnectionState;
      setIceConnectionState(state);

      // When ICE succeeds, inspect stats to detect relay (TURN) usage
      // and start the quality polling loop.
      if (state === "connected" || state === "completed") {
        try {
          const stats = await pc.getStats();
          let usingRelay = false;
          stats.forEach((report) => {
            // Find the nominated (winning) candidate pair.
            if (
              report.type === "candidate-pair" &&
              report.nominated &&
              report.localCandidateId
            ) {
              const local = stats.get(report.localCandidateId);
              if (local?.candidateType === "relay") {
                usingRelay = true;
              }
            }
          });
          setIsRelaying(usingRelay);
          logger(
            `[WebRTC] ICE ${state}; active local candidate type: ${usingRelay ? "relay" : "host/srflx"}; isRelaying=${usingRelay}`
          );
        } catch {
          // getStats() may fail in edge cases; safe to ignore.
        }

        // Re-apply bitrate after connection is stable (transceivers are live).
        await applyBitrate(pc, currentBitrateRef.current);

        // Start quality monitoring.
        startStatsPolling(pc);
      }

      if (state === "disconnected" || state === "failed" || state === "closed") {
        stopStatsPolling();
        setNetworkQuality(NETWORK_QUALITY.UNKNOWN);
      }
    };

    return pc;
    })();

    try {
      return await pcPromiseRef.current;
    } finally {
      pcPromiseRef.current = null;
    }
  }, [waitForIceConfig, startStatsPolling, stopStatsPolling]); // intentionally uses refs for signaling/media

  // ── SDP signaling ──────────────────────────────────────────────────────
  const createOffer = useCallback(async () => {
    const pc = await ensurePC();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendRef.current({ type: "offer", sdp: pc.localDescription.sdp });
  }, [ensurePC]);

  const handleSignal = useCallback(
    async (data) => {
      const pc = await ensurePC();
      try {
        if (data.type === "offer") {
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "offer", sdp: data.sdp })
          );
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendRef.current({ type: "answer", sdp: pc.localDescription.sdp });
          // Flush queued candidates now that remote description is set.
          for (const c of pendingCandidatesRef.current) await pc.addIceCandidate(c);
          pendingCandidatesRef.current = [];

        } else if (data.type === "answer") {
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "answer", sdp: data.sdp })
          );
          for (const c of pendingCandidatesRef.current) await pc.addIceCandidate(c);
          pendingCandidatesRef.current = [];

        } else if (data.type === "ice-candidate" && data.candidate) {
          const candidate = new RTCIceCandidate(data.candidate);
          if (pc.remoteDescription) {
            await pc.addIceCandidate(candidate);
          } else {
            // Remote description not yet set — queue the candidate.
            pendingCandidatesRef.current.push(candidate);
          }
        }
      } catch (err) {
        console.error("[WebRTC] Signaling error:", err);
      }
    },
    [ensurePC]
  );

  // ── Connection management ──────────────────────────────────────────────
  const closePeerConnection = useCallback(() => {
    stopStatsPolling();
    pcRef.current?.close();
    pcRef.current = null;
    pcPromiseRef.current = null;
    pendingCandidatesRef.current = [];
    setRemoteStream(null);
    setRtcStatus(RTC_STATUS.IDLE);
    setIceConnectionState(ICE_STATE.IDLE);
    setIsRelaying(false);
    setNetworkQuality(NETWORK_QUALITY.UNKNOWN);
    setNetworkStats({ lossPercent: 0, rttMs: 0 });
  }, [stopStatsPolling]);

  /**
   * retryConnection
   * ───────────────
   * Called when the user clicks "Try again" after ICE failure.
   *
   * 1. Closes our broken PeerConnection.
   * 2. Sends { type: "retry" } so the peer also closes theirs.
   * 3. Creates a fresh offer — we become the new offerer.
   */
  const retryConnection = useCallback(async () => {
    closePeerConnection();
    sendRef.current({ type: "retry" });
    // Brief delay ensures the peer processes the retry signal and closes
    // their PC before we send a new offer, avoiding a glare condition.
    await new Promise((r) => setTimeout(r, 400));
    await createOffer();
  }, [closePeerConnection, createOffer]);

  // ── Media controls ─────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    localStreamRef.current
      ?.getAudioTracks()
      .forEach((t) => { t.enabled = !t.enabled; });
    setMicOn((prev) => !prev);
  }, []);

  const toggleCamera = useCallback(() => {
    localStreamRef.current
      ?.getVideoTracks()
      .forEach((t) => { t.enabled = !t.enabled; });
    setCameraOn((prev) => !prev);
  }, []);

  // ── Full teardown (unmount) ────────────────────────────────────────────
  const cleanup = useCallback(() => {
    stopStatsPolling();
    closePeerConnection();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setMicOn(true);
    setCameraOn(true);
  }, [closePeerConnection, stopStatsPolling]);

  useEffect(() => cleanup, [cleanup]);

  return {
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
    cleanup,
  };
}

// ── tiny logger util ──────────────────────────────────────────────────────────
function logger(...args) {
  if (import.meta.env.DEV) console.log(...args);
}
