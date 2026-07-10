// System tools (design §0 Tool-First) — 실행 환경 정보.
import { register } from "./registry.js";
import { networkInterfaces } from "node:os";

register({
  name: "list_network_addresses",
  description: "이 서버 머신의 LAN IPv4 주소 목록을 반환한다. 같은 네트워크의 다른 기기에서 접속 주소를 만들 때 쓴다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: () => {
    const addresses = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === "IPv4" && !ni.internal) addresses.push(ni.address);
      }
    }
    return { addresses };
  },
});
