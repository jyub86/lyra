# Lyra — 외부 LLM/에이전트 가이드 (MCP · CLI)

이 문서는 **외부 LLM/에이전트가 Lyra의 도구(tool)를 잘 쓰기 위한 안내서**입니다.
개별 도구의 정확한 입력 스키마는 [tools.md](./tools.md)(자동 생성)와 런타임 introspection이 권위 있는 소스이고,
이 문서는 **개념 모델 · 연결 방법 · 워크플로우 · 관례**를 설명합니다.

Lyra는 **Tool-First**입니다: 모든 기능이 하나의 레지스트리에 도구로 등록되고, **MCP · CLI · HTTP** 세 어댑터가
그 레지스트리에서 자동 생성됩니다. 즉 "UI가 할 수 있는 모든 것 = 외부 LLM·CLI가 할 수 있는 모든 것"입니다.

---

## 1. 연결 방법

### MCP (Claude Desktop / 로컬 에이전트)
```bash
bun run mcp          # stdio MCP 서버. 모든 도구가 MCP tool로 노출됨
```
`tools/list` 로 전체 도구+스키마를, `tools/call` 로 실행. 서버 접속 시 `instructions`에 이 가이드 요지가 담겨 옵니다.

### CLI (셸 / cron / 스크립트)
```bash
bun run cli tools                       # 전체 도구 목록 (name · read · description)
bun run cli schema <이름>               # 특정 도구의 입력 JSON Schema (← 최신·권위)
bun run cli call <이름> --json '{...}'  # 실행 (또는 --file f.json / stdin / -- key=value)
```

### HTTP (UI·자동화)
```
POST /api/tools/<이름>     # 본문 = 인자 JSON. 읽기 도구는 GET도 가능(쿼리스트링)
GET  /api/tools            # 전체 스키마
```

> **항상 최신 스키마 확인**: `bun run cli schema <이름>` 또는 MCP `tools/list`. tools.md도 자동 생성이라 코드와 일치합니다.

---

## 2. 핵심 개념 모델

```
Service(예배 = 순서 전체)      ← 공유 단위
  └─ Slide(슬라이드, 평면 순서: position 0,1,2…)
        └─ elements[]          ← 슬라이드 = 요소 캔버스

Template(생성기, 계층 밖)  ·  Theme(시각 스타일, Service에 적용)
```

### Service
한 예배의 순서 전체. `create_service(title, date, worship_part)` 로 만들고, `service_id` 로 모든 하위 작업을 참조합니다.
- `worship_part`: 자유 문자열(예: `"1부"`, `"주일오전예배"`).
- 공유: `export_service`(이미지 asset+테마까지 포함한 JSON) / `import_service`.

### Slide = `{ background, elements[], transition, hidden }`
- 하나의 연속된 순서(position)로 평면 저장. Scene 계층 없음.
- `hidden: 1` 이면 **발표에서 건너뜀**(편집기엔 남음).
- `background` 가 `null` 이면 테마 기본 배경 사용.

### Element (요소) — 슬라이드의 콘텐츠 단위
공통 필드: `x, y, w, h`(**0~1 상대 좌표**, 해상도 독립), `size`(글자 크기, **cqw**=캔버스 너비 %), `color`(#hex),
`align`(가로: center/left/right), `valign`(세로: middle/top/bottom), `weight`(400/600/700/800),
`font`(폰트 family 문자열, `list_fonts` 참고. 없으면 테마 기본), `line_height`.

| type | 설명 | 주요 필드 |
|---|---|---|
| `text` | 자유 텍스트 | `text` |
| `shape` | 도형 | `shape`(rect/ellipse/line), `fill`, `stroke`, `stroke_width`, `radius` |
| `image` | 이미지 | `url`(/uploads/…), `fit`(cover/contain) |
| `bible` | 성경 본문 | `field`(all/ref/text), `params`(book·chapter·verse), `content`(스냅샷), `show_numbers`, `format` |
| `hymn` | 찬송가 | `field`(all/title/label/lyrics), `params`(number), `content` |
| `reading` | 교독문 | `field`(all/body/leader/congregation/unison), `params`(number), `content`, `show_tags`, `leader_color`, `congregation_color` |

- **콘텐츠 요소**(bible/hymn/reading)는 `params`(가져올 대상) + `content`(가져온 스냅샷)를 가집니다.
  성경/찬송/교독문 본문도 폰트·색·위치를 **자유 편집**할 수 있습니다(요소이므로).
- 요소 배열 전체 교체는 `set_slide_elements(slide_id, elements)` — **부분 갱신이 아니라 전체 배열을 넘겨야** 합니다.

### Background 스키마
```jsonc
{ "type":"color", "value":"#1a1a2e" }
{ "type":"gradient", "from":"#1a1a2e", "to":"#16213e", "angle":135 }
{ "type":"image", "url":"/uploads/bg.jpg", "fit":"cover", "overlay_dim":0.35 }
{ "type":"video", "url":"/uploads/bg.mp4", "loop":true, "muted":true, "overlay_dim":0.4 }
```

### Template = 요소 배치
`spec = { background, elements }`. 두 종류가 한 목록에 공존:
- **builtin(기본 슬라이드 종류)**: `builtin-title` · `builtin-section` · `builtin-bible` · `builtin-hymn` ·
  `builtin-reading` · `builtin-praise` · `builtin-announcement` · `builtin-blank`.
  생성형은 콘텐츠 요소를 갖고, 정적은 `bind:"param"` 텍스트를 가짐. **수정은 디자인만**(`update_template`), 삭제 불가(초기화만).
- **custom(디자인 템플릿)**: 한 슬라이드 디자인을 `save_template` 로 저장. 정적(파라미터 없이 그대로 삽입).

`apply_template(template_id, service_id, params?, position?)` 가 params로 내용을 채우고 **긴 본문/가사를 N장으로 자동 분할**합니다.

### Theme
프리셋(`dark-blue`/`light-warm`/`black`) + 서비스별 `theme_overrides = { background?, accent?, font? }`
(`set_service_theme(service_id, theme_id?, overrides?)`). 전환효과 `set_service_transition`(none/fade/slide).

---

## 3. 자주 쓰는 워크플로우

### 3-1. 주보 → 완성 예배 덱 (핵심 자동화)
LLM이 주보에서 순서를 뽑아 도구를 순서대로 호출합니다. **콘텐츠 도구(add_*_slides)가 가장 고가치** — 번호/장·절만 주면 자동 분할·디자인 적용됩니다.
```
service_id = create_service("2026-07-06 1부 예배", "2026-07-06", "1부")
apply_template("builtin-section", service_id, {label:"예배로의 부름"})         # 순서 구분
add_hymn_slides(service_id, number=1)                                          # 찬송
add_reading_slides(service_id, number=60)                                      # 교독문(시편 등)
add_bible_slides(service_id, book="요한복음", chapter=3, verse_start=16, verse_end=18, layout="one-per-verse")
add_praise_slides(service_id, title="주의 이름 높이어", sections=[{label:"1절",lines:["...","..."]}])
add_announcement_slide(service_id, items=["광고1","광고2"])
```
- 각 콘텐츠 도구는 내부적으로 `apply_template("builtin-*")` 로 위임 → 템플릿 디자인이 적용되고 긴 내용은 자동 분할됩니다.
- `position` 인자로 특정 위치에 삽입 가능(생략 시 맨 끝).

### 3-2. 찬양 가사는 **구조화해서** 전달
내부에 가사 파서가 없습니다. **지저분한 가사 해석은 LLM이 담당** → `sections=[{label, lines:[...]}]` 구조로 넘깁니다.

### 3-3. 자유 요소로 세밀 편집
```
add_slide(service_id, elements=[
  {type:"text", x:0.1,y:0.4,w:0.8,h:0.2, text:"제목", size:8, color:"#dcdcdc", align:"center", weight:800, valign:"middle"},
  {type:"shape", shape:"line", x:0.28,y:0.13,w:0.44,h:0.002, stroke:"#6f6f6f", stroke_width:1}
], background={type:"color", value:"#262626"})
```
기존 슬라이드 요소 수정은 `set_slide_elements(slide_id, elements)`(전체 배열), 배경은 `set_slide_background`.

### 3-4. 템플릿 디자인 바꾸기(모든 예배에 반영)
```
get_template("builtin-bible")                     # 현재 spec 확인
update_template("builtin-bible", slide={background, elements})   # builtin은 디자인만 저장(내용은 param)
reset_templates()                                  # builtin이 비었거나 손상 시 복구
```

### 3-5. 라이브러리에서 기존 PPT 찾아 가져오기
```
set_library_dir("/Users/name/church/ppt")  →  index_library()  →  search_library("부활 구주")
import_pdf(service_id, result.path)         # 검색 결과(PPT/PDF/이미지)를 이미지 슬라이드로 추가
```

### 3-6. 발표 제어 (2번째 모니터)
```
present_goto(service_id, page_index)   present_blackout(on)   present_reload()
get_presentation_state()               # 현재 위치/상태
```
발표 화면은 편집 변경을 WebSocket으로 실시간 반영하고, `hidden` 슬라이드는 좌우 이동 시 건너뜁니다.

### 3-7. 관리
`list_services` / `get_service`(슬라이드 순서대로) · `duplicate_service`(다른 이름 저장) · `delete_service` ·
`reorder_slides(service_id, ordered_slide_ids)` · `set_slide_hidden` · `set_video_background`.

---

## 4. 관례 & 주의점

- **좌표는 0~1 상대**, `size`는 `cqw`(캔버스 너비 %). 해상도 독립.
- **`service_id`** 로 참조(옛 `scene_id` 아님 — Scene 계층은 폐기됨).
- 콘텐츠 도구는 `apply_template("builtin-*")` 로 위임되고 **긴 본문/가사는 자동 분할**됩니다. `layout`(성경) ·
  `lines_per_slide`(찬송/찬양) · `segments_per_slide`(교독문) 로 분할 밀도 조절.
- `set_slide_elements` 는 **요소 배열 전체를 교체**합니다(부분 패치 아님). 기존 요소를 유지하려면 `get_service` 로 읽어 합치세요.
- **builtin 템플릿은 삭제 불가**(초기화만). custom만 `delete_template`.
- 색은 `#hex`, 폰트는 family 문자열(`list_fonts` 로 사용 가능한 것 확인).
- `export_service` 는 참조 이미지(assets, base64)와 `theme_overrides`·전환까지 포함 → 다른 머신에서도 재현.
- **"지능"은 LLM에 둡니다.** 내부에 복잡한 휴리스틱(가사 파싱 등) 없음 — 구조화된 입력을 받아 결정적으로 동작.
- 성경/찬송/교독문 콘텐츠 DB가 없으면 해당 도구는 `unknown bible book …` 처럼 **명확한 에러**를 냅니다(graceful).

---

## 5. 더 보기
- **전체 도구 레퍼런스** (자동 생성, 파라미터 표): [tools.md](./tools.md)
- **설계·변경 이력**: [../CLAUDE.md](../CLAUDE.md)
- **실행/설치**: [../README.md](../README.md)
