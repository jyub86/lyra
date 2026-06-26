// Process-wide event bus. present_* tools emit here; the WebSocket adapter
// subscribes and broadcasts to presenter clients. Keeps tools transport-agnostic.
import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(50);
