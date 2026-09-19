import { Routes, Route, Navigate } from "react-router-dom";
import ChatRoom from "./components/ChatRoom.jsx";
import JoinRoom from "./components/JoinRoom.jsx";

export default function App() {
  return (
    <Routes>
      {/* Landing page – pick a room */}
      <Route path="/" element={<JoinRoom />} />

      {/* Main chat room: /room/:code */}
      <Route path="/room/:code" element={<ChatRoom />} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
