// WebSocket 어댑터 (발표 동기화) — design §13.
// Bridges the present_* tools (which emit on the bus) to presenter clients.
// Tools stay transport-agnostic; this is the only place that knows about sockets.
import { bus } from "../core/lib/bus.js";

const TOPIC = "present";
const clients = new Set();
let lastState = { action: "init", index: 0, blackout: false, service_id: null };

export function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) {
    try { ws.send(s); } catch {}
  }
}

// Bun.serve websocket handlers.
export const websocket = {
  open(ws) {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "present", ...lastState })); // catch new clients up
  },
  close(ws) {
    clients.delete(ws);
  },
  message() {
    // Presenter is a passive follower for now; control flows via present_* tools.
  },
};

// Bus → sockets. present_* tools emit the full current state here.
bus.on(TOPIC, (state) => {
  lastState = { ...lastState, ...state };
  broadcast({ type: "present", ...lastState });
});

// Any content mutation (edit from any client/CLI/MCP) → tell clients to refresh.
bus.on("changed", (info) => broadcast({ type: "changed", tool: info?.tool }));
