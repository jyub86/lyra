// Presentation-control tools (design §8-2). A single in-process "current
// presentation" state. Writers emit on the bus; the WebSocket adapter relays
// to presenter clients. Tools stay transport-agnostic.
import { register } from "./registry.js";

// Module-level singleton: survives across tool calls within the server process.
const current = { service_id: null, index: 0, blackout: false };

function emit(bus, action) {
  bus.emit("present", { action, ...current });
  return { ok: true, ...current };
}

register({
  name: "get_presentation_state",
  description: "현재 발표 상태(서비스/슬라이드 인덱스/블랙아웃)를 반환한다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: () => ({ ...current }),
});

register({
  name: "present_goto",
  description: "발표 화면을 특정 슬라이드로 이동한다. page_index는 서비스 전체 슬라이드의 0-base 순번.",
  input_schema: {
    type: "object",
    properties: {
      page_index: { type: "integer", description: "전체 슬라이드 기준 0-base 인덱스" },
      service_id: { type: "string", description: "발표할 서비스(생략 시 현재 유지)" },
    },
    required: ["page_index"],
  },
  handler: ({ page_index, service_id }, { bus }) => {
    if (service_id) current.service_id = service_id;
    current.index = page_index;
    current.blackout = false;
    return emit(bus, "goto");
  },
});

register({
  name: "present_blackout",
  description: "발표 화면을 검은 화면으로 전환/해제한다.",
  input_schema: {
    type: "object",
    properties: { on: { type: "boolean", default: true } },
    required: ["on"],
  },
  handler: ({ on }, { bus }) => {
    current.blackout = !!on;
    return emit(bus, "blackout");
  },
});

register({
  name: "present_reload",
  description: "발표 화면에 콘텐츠 새로고침을 지시한다(편집 후 반영).",
  input_schema: { type: "object", properties: {} },
  handler: (_a, { bus }) => emit(bus, "reload"),
});
