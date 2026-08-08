// WebSocket 어댑터 (발표 동기화) — design §13.
// Bridges the present_* tools (which emit on the bus) to presenter clients.
// Tools stay transport-agnostic; this is the only place that knows about sockets.
import { bus } from "../core/lib/bus.js";

const TOPIC = "present";
const clients = new Set();
// live = 발표 화면(presenter)이 하나라도 연결돼 있는지. 편집기는 이 값으로 "발표중"
// 표시를 켜고 끈다. 발표 화면을 닫으면 live=false로 브로드캐스트된다.
let lastState = { action: "init", index: 0, blackout: false, service_id: null, live: false };
let presenters = 0;
let darkTimer = null;   // 발표 화면 새로고침(잠깐 끊김)에 깜박이지 않도록 유예 타이머

export function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) {
    try { ws.send(s); } catch {}
  }
}

function setLive(live) {
  if (lastState.live === live) return;
  lastState = { ...lastState, live };
  broadcast({ type: "present", ...lastState });
}

// Bun.serve websocket handlers.
export const websocket = {
  open(ws) {
    clients.add(ws);
    if (ws.data?.role === "presenter") {
      presenters++;
      clearTimeout(darkTimer); darkTimer = null;   // 재접속 → "발표 꺼짐" 예약 취소
      if (!lastState.live) setLive(true);           // 첫 발표 화면 → live 통지
    }
    ws.send(JSON.stringify({ type: "present", ...lastState, live: presenters > 0 })); // catch new clients up
  },
  close(ws) {
    clients.delete(ws);
    if (ws.data?.role === "presenter") {
      presenters = Math.max(0, presenters - 1);
      if (presenters === 0) {
        // 새로고침으로 잠깐 끊겼다가 다시 붙는 경우를 대비해 잠깐 유예 후 "발표 꺼짐" 통지.
        clearTimeout(darkTimer);
        darkTimer = setTimeout(() => { if (presenters === 0) setLive(false); }, 1500);
      }
    }
  },
  message() {
    // Presenter is a passive follower for now; control flows via present_* tools.
  },
};

// Bus → sockets. present_* tools emit the full current state here.
bus.on(TOPIC, (state) => {
  lastState = { ...lastState, ...state, live: presenters > 0 };
  broadcast({ type: "present", ...lastState });
});

// Any content mutation (edit from any client/CLI/MCP) → tell clients to refresh.
// origin = 변경을 만든 탭의 id. 편집기는 자기 origin이면 무시하고 남의 변경만 반영한다.
bus.on("changed", (info) => broadcast({ type: "changed", tool: info?.tool, origin: info?.origin ?? null }));
