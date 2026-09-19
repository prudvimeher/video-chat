/**
 * useWebSocket
 * -----------
 * Manages a single WebSocket connection for the lifetime of the consuming
 * component.  Returns helpers the component needs to send messages and
 * inspect connection status.
 *
 * @param {string} url        - Full WebSocket URL
 * @param {Function} onMessage - Called with the parsed JSON payload on every
 *                               incoming message
 */
import { useEffect, useRef, useCallback, useState } from "react";

export const WS_STATUS = {
  CONNECTING: "connecting",
  OPEN: "open",
  CLOSED: "closed",
  ERROR: "error",
};

export default function useWebSocket(url, onMessage) {
  const wsRef = useRef(null);
  const [status, setStatus] = useState(WS_STATUS.CONNECTING);

  // Keep a stable ref to the latest onMessage callback so the effect closure
  // never stales out.
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!url) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    setStatus(WS_STATUS.CONNECTING);

    ws.onopen = () => setStatus(WS_STATUS.OPEN);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessageRef.current?.(data);
      } catch {
        console.warn("[ws] Non-JSON message ignored:", event.data);
      }
    };

    ws.onerror = () => setStatus(WS_STATUS.ERROR);

    ws.onclose = () => setStatus(WS_STATUS.CLOSED);

    return () => {
      ws.close();
    };
  }, [url]); // Re-connect only when the URL changes

  /** Send a JSON-serialisable object over the socket. */
  const sendMessage = useCallback((payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  return { status, sendMessage };
}
