#!/usr/bin/env bun
// ★ MCP 어댑터 (1차 인터페이스) — design §9-3(A), §13.
// Every registry tool is exposed as an MCP tool. Handlers go through the SAME
// registry.execute path as CLI/HTTP. Low-level Server API is used so our JSON
// Schemas pass straight through as `inputSchema` (no Zod re-declaration).
//
// Transport: stdio (Claude Desktop / local agents). HTTP/SSE transport can be
// mounted onto the M6 HTTP server later for networked agents (AXIS).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadTools, schemas, execute, get } from "../core/tools/registry.js";

// 접속 시 에이전트에게 전달되는 안내(요지). 자세한 가이드는 docs/AGENTS.md, 도구 표는 docs/tools.md.
const INSTRUCTIONS = `Lyra는 주일예배 PPT를 만드는 Tool-First 서비스입니다. 아래 도구로 예배 덱을 제작/편집/발표하세요.

개념: Service(예배=순서 전체) > Slide(평면 순서) > elements[](요소 캔버스).
- Slide = { background, elements[], transition, hidden(1=발표에서 건너뜀) }.
- 요소: text/shape/image + 콘텐츠 요소 bible/hymn/reading. 좌표 x,y,w,h는 0~1 상대, size는 cqw(캔버스 너비 %),
  color는 #hex, font는 family 문자열(list_fonts). 콘텐츠 요소는 params(가져올 대상)+content(스냅샷)를 가짐.
- 배경: {type:color,value} | {type:gradient,from,to,angle} | {type:image,url,fit,overlay_dim} | {type:video,url,loop,muted,overlay_dim}.
- 템플릿: builtin(기본 종류: builtin-title/section/bible/hymn/reading/praise/announcement/blank) + custom.
  apply_template가 params로 내용 채우고 긴 본문/가사를 자동 분할.

핵심 워크플로우(주보→덱): create_service → (순서대로) apply_template("builtin-section",{label}) ·
add_bible_slides · add_hymn_slides · add_reading_slides · add_praise_slides(sections=[{label,lines[]}]) · add_announcement_slide.
콘텐츠 도구가 가장 고가치(번호/장·절만 주면 분할·디자인 적용). 분할 밀도: layout / lines_per_slide / segments_per_slide.

관례: 모든 참조는 service_id/slide_id. set_slide_elements는 요소 배열 전체 교체(부분 아님) — 유지하려면 get_service로 읽어 합칠 것.
builtin 템플릿은 삭제 불가(초기화만). "지능"(가사 파싱 등)은 호출자(LLM)가 담당 — 내부 파서 없음.
정확한 입력 스키마는 tools/list가 항상 최신. 읽기 도구(list/get/search_*)로 먼저 그라운딩하세요.`;

export async function buildMcpServer() {
  await loadTools();
  const server = new Server(
    { name: "lyra", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: schemas().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!get(name)) {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await execute(name, args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
    }
  });

  return server;
}

if (import.meta.main) {
  const server = await buildMcpServer();
  await server.connect(new StdioServerTransport());
  // stdio transport keeps the process alive; logs must go to stderr (stdout is the protocol channel).
  process.stderr.write("[mcp] lyra server listening on stdio\n");
}
