# Lyra — 주일예배 PPT 시스템

> **Lyra** — 시편에서 다윗이 연주한 수금(竪琴, lyre)에서 따온 이름. 찬양·예배·말씀을 담는 도구.

교회 주일예배용 프레젠테이션(PPT)을 **빠르게 제작하고 발표**하는 로컬 도구입니다.
성경·찬송가·교독문을 오프라인 DB에서 바로 슬라이드로 만들고, 모든 슬라이드를
**요소(텍스트·도형·이미지·성경/찬송/교독)의 자유 캔버스**로 편집합니다.
편집 화면과 발표 화면이 **WebSocket으로 실시간 동기화**됩니다.

> 스택: **Bun + 순수 HTML/JS + SQLite**. 빌드 과정 없음, 로컬 전용, 오프라인 동작.

---

## 핵심 특징

- **콘텐츠 자동 생성** — 성경(개역개정)·새찬송가·교독문을 번호/장·절만 넣으면 슬라이드로 자동 분할.
  찬송가는 **제목·가사로 검색**(번호 몰라도), 주보 PDF의 **빨강 성구를 자동 추출**해 본문 슬라이드로.
- **요소 중심 편집** — 슬라이드 = `{ 배경, 요소[] }`. 성경 본문·찬송 가사·교독문도 요소라
  **글자 크기·색·위치를 자유롭게** 편집(구글 슬라이드식 드래그·스냅·가이드). 캔버스에서 바로 인라인 텍스트 편집·부분 색상.
- **디자인 템플릿** — 슬라이드 종류(타이틀/성경/찬송/교독문/광고 등)가 곧 템플릿. 디자인을 저장·재사용·편집.
- **발표 화면** — 2번째 모니터 전체화면, 편집과 실시간 동기화, 전환 효과(페이드/슬라이드), 블랙아웃, 번호 입력 이동.
- **PPT/PDF/이미지 가져오기** — PPT/PDF는 페이지를 이미지로 임포트(LibreOffice·poppler 활용), 이미지 파일은 그대로 첨부.
  PPT/PDF 페이지는 cwebp가 있으면 **WebP로 저장**(용량 약 7~8배↓)해 내보내기가 가볍습니다.
- **PPT 라이브러리 검색** — 폴더 하나를 지정하면 하위 폴더까지 재귀 색인, **파일명+내용**으로 검색해 바로 가져오기.
  자주 쓰는 폴더는 **미리 변환**해두면 가져오기가 즉시.
- **테마 & 커스텀 색** — 프리셋(다크블루/라이트웜/블랙) + 서비스별 배경색·메인색.
- **자유 폰트** — 오프라인 self-host 웹폰트(한글/영문 14종), 요소별·서비스 기본 글꼴 지정.
- **Tool-First / Headless-First** — 모든 기능이 Tool Registry에 등록되고, **MCP·CLI·HTTP** 세 어댑터로
  자동 노출됩니다. 즉 외부 LLM(Claude 등)이나 셸 스크립트로도 예배 덱을 만들 수 있습니다.

---

## 요구 사항

| 구분 | 필요 | 용도 |
|---|---|---|
| **필수** | [Bun](https://bun.sh) 1.3+ | 런타임·SQLite·서버 내장 |
| **콘텐츠** | `bible.json` / `hymns.json` / `readings.json` | 성경·찬송·교독문 (저작권 자료, 별도 준비 — [아래](#1-콘텐츠-데이터-준비)) |
| 선택 | **LibreOffice** (`soffice`) | `.pptx/.ppt/.odp` 가져오기 |
| 선택 | **poppler** (`pdftoppm`·`pdftotext`) | PDF 가져오기 · 라이브러리 PDF 내용 검색 |
| 선택 | **cwebp** (libwebp) | 가져온 PPT/PDF 페이지를 WebP로 저장(용량 약 7~8배↓). 없으면 PNG로 저장(정상 동작) |

> 편집·발표·요소편집·**PPT/ODP 내용 검색**은 외부 도구 없이 어디서든(macOS·Windows·Linux) 동작합니다.
> "선택" 도구는 슬라이드 가져오기·PDF·이미지 압축에만 필요하며, 없으면 해당 기능만 비활성/대체됩니다.

### macOS

```bash
# 1) Bun (필수)
curl -fsSL https://bun.sh/install | bash

# 2) 선택 도구 (Homebrew) — 가져오기·PDF·WebP
brew install --cask libreoffice     # .pptx/.ppt/.odp 가져오기
brew install poppler webp           # PDF 가져오기·검색 + WebP 변환(cwebp)
```

### Windows

패키지 매니저(scoop/choco)가 없어도 됩니다. **설치 파일/압축본**으로 넣으면 앱이 자동 탐지합니다(PATH 편집 불필요).

```powershell
# 1) Bun (필수) — PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
```

2) 선택 도구:

| 도구 | 설치 |
|---|---|
| **LibreOffice** | [libreoffice.org/download](https://www.libreoffice.org/download) 의 **.msi** 설치 → 기본 경로 자동 탐지. (winget: `winget install -e --id TheDocumentFoundation.LibreOffice`) |
| **poppler** | [poppler-windows Release](https://github.com/oschwartz10612/poppler-windows/releases) 의 `Release-…zip` → 압축 풀어 폴더째 **`tools/`** 안에. 예: `tools/poppler-24.08.0/Library/bin/pdftoppm.exe`. (대안: 환경변수 `LYRA_POPPLER`=bin 폴더) |
| **cwebp** | [libwebp 다운로드](https://developers.google.com/speed/webp/download) 의 Windows zip → 폴더째 **`tools/`** 안에. 예: `tools/libwebp-1.4.0-windows-x64/bin/cwebp.exe`. (대안: `LYRA_CWEBP`=cwebp.exe가 있는 폴더). 없으면 이미지를 PNG로 저장 |

> 자세한 드롭인 방법: [`tools/README.md`](./tools/README.md).

### Linux (Debian/Ubuntu)

```bash
# 1) Bun (필수)
curl -fsSL https://bun.sh/install | bash
# 2) 선택 도구
sudo apt install libreoffice poppler-utils webp
```

---

## 쉬운 실행 (더블클릭) ⭐

터미널 없이 실행하려면 프로젝트 폴더의 실행 파일을 **더블클릭**하세요.

- **macOS** — `Lyra-mac.command`
- **Windows** — `Lyra-windows.bat`

더블클릭하면 자동으로 (1) Bun 런타임 설치(최초 1회, 인터넷 필요) → (2) 의존성 설치 →
(3) `data/source/`에 콘텐츠 JSON이 있으면 시드 → (4) 서버 실행 → (5) 브라우저로 편집기를 엽니다.
창을 닫으면 종료됩니다.

> macOS에서 “확인되지 않은 개발자” 경고가 뜨면: 파일 **우클릭 → 열기** 한 번이면 이후엔 더블클릭으로 됩니다.
> (또는 터미널에서 `chmod +x Lyra-mac.command` 후 실행.)
>
> 콘텐츠(성경·찬송·교독문)는 저작권 자료라 포함돼 있지 않습니다 — 아래 “콘텐츠 데이터 준비”대로
> `data/source/`에 JSON을 두면 첫 실행 시 자동 시드됩니다. 없으면 편집·발표는 되지만 성경/찬송/교독문 생성만 비활성입니다.

---

## 설치 & 실행 (수동)

```bash
git clone https://github.com/jyub86/lyra.git
cd lyra
bun install
```

> **Windows 참고** — `bun install`·`bun run …` 명령은 macOS/Linux와 동일합니다.
> 다만 아래 예시의 `PORT=8080 bun run dev`처럼 **환경변수를 명령 앞에 붙이는 문법은 bash 전용**입니다.
> PowerShell에서는 나눠서 실행하세요:
> ```powershell
> $env:PORT = 8080; bun run dev
> $env:WORSHIP_DATA_DIR = "C:\path\to\data"; bun run seed
> ```

### 1) 콘텐츠 데이터 준비

성경/찬송가/교독문 원본 JSON을 `data/source/`에 둡니다 (파일명 고정):

```
data/source/bible.json      # 성경 (개역개정 등)
data/source/hymns.json      # 새찬송가
data/source/readings.json   # 교독문
```

> 이 자료는 **저작권 대상**이라 저장소에 포함되어 있지 않습니다(`data/source/`는 `.gitignore`).
> 각자 보유한 자료를 아래 형식에 맞춰 두거나, 임포트 스크립트를 형식에 맞게 수정하세요.
> 다른 경로에 두려면 `WORSHIP_DATA_DIR` 환경변수로 지정할 수 있습니다.

#### 기대 JSON 형식

```jsonc
// bible.json
{ "version": "개역개정", "book_count": 66,
  "books": [ { "order": 1, "name": "창세기", "short": "창", "aliases": ["창","창세기"],
    "chapters": 50,
    "verses": [ { "chapter": 1, "verse": "1", "v1": 1, "v2": 1, "text": "태초에 …", "title": "천지 창조" } ] } ] }

// hymns.json (새찬송가) — 배열
[ { "number": 1, "title": "만복의 근원 하나님",
    "verses": [ { "no": 1, "lines": ["만복의 근원 하나님 …", "저 천사여 찬송하세 …"] } ] } ]

// readings.json (교독문) — 배열
[ { "number": 1, "title": "시편 1편",
    "segments": [ { "order": 1, "role": "leader", "role_ko": "사회자", "text": "복 있는 사람은 …" },
                  { "order": 2, "role": "congregation", "role_ko": "회중", "text": "…" } ] } ]
```

### 2) 시드(콘텐츠 DB 생성)

```bash
bun run seed        # data/source/*.json → data/worship.db 로 임포트 (멱등)
# 다른 경로면: WORSHIP_DATA_DIR=/path/to/data bun run seed
```

### 3) 서버 실행

```bash
bun run dev         # http://localhost:4321
# 포트 변경: PORT=8080 bun run dev
```

- **편집 화면**: <http://localhost:4321/>
- **발표 화면**: <http://localhost:4321/presenter> (2번째 모니터에서 전체화면 `F`)

---

## 사용 흐름 (편집기)

1. 상단 **`+`** 로 새 예배 순서를 만든다.
2. 우측 **추가** 탭에서 종류(타이틀/성경/찬송/교독문/찬양/광고 …) 선택 → 값 입력 → **순서 끝에 추가**.
   - 성경: 책·장·절 / 찬송: 번호 / 교독문: 번호 + **슬라이드당 문장 수**. 긴 본문은 자동 분할됩니다.
3. **디자인** 탭에서 슬라이드 배경, 선택한 요소의 글자 크기·색·위치를 편집.
   - 캔버스 상단 **요소 추가**로 텍스트·도형·이미지·성경/찬송/교독 요소를 자유롭게 얹을 수 있음.
4. **템플릿** 탭에서 디자인을 저장/편집 → 이후 같은 종류에 자동 적용.
5. 좌측 **순서**에서 드래그로 재배열(여러 개 ⌘/Shift 선택), **리스트/타일** 뷰 전환.
6. 상단 **⚙ 설정**에서 테마·배경색·메인색·전환 효과.
7. **▶ 발표 화면**을 열고, 편집기에서 슬라이드를 클릭/이동하면 실시간 반영.
   - 발표 화면 단축키: `←/→` 이동 · `B` 블랙아웃 · `F` 전체화면.
8. **가져오기** 메뉴: PPT/PDF/이미지 임포트, PPT 라이브러리 검색, 예배 순서 JSON 내보내기/가져오기.

---

## 아키텍처 (Tool-First / Headless-First)

제품의 본체는 **Tool Registry**입니다. 모든 기능은 Tool로 등록되고,
**MCP·CLI·HTTP** 세 어댑터가 레지스트리에서 자동 생성됩니다. UI는 그중 한 소비자일 뿐입니다.

```
Core Engine (순수 함수 + SQLite)
        │
   Tool Registry  ← 모든 기능이 여기에 { name, description, input_schema, handler } 로 등록
        │
 ┌──────┼───────────────┐
 ▼      ▼               ▼
 MCP    CLI            HTTP
(외부   (셸/cron       (편집·발표 UI)
 LLM)    자동화)
```

### CLI

```bash
bun run cli tools                      # 전체 도구 목록
bun run cli schema add_bible_slides    # 입력 스키마
bun run cli call create_service --json '{"title":"1부","date":"2026-06-29","worship_part":"1부"}'
bun run cli call add_bible_slides --json '{"service_id":"…","book":"요한복음","chapter":3,"verse_start":16,"verse_end":18}'
```

### MCP (Claude Desktop 등)

```bash
bun run mcp     # stdio MCP 서버 — 외부 에이전트가 tool로 예배 덱 제작
```

> **외부 LLM/에이전트용 가이드**: 개념 모델·워크플로우·관례는 [`docs/AGENTS.md`](./docs/AGENTS.md),
> 전체 도구 레퍼런스(자동 생성)는 [`docs/tools.md`](./docs/tools.md).
> MCP 접속 시 이 요지가 서버 `instructions`로 자동 전달됩니다.
> 도구 표 재생성: `bun run scripts/gen-tools-md.js`.

### HTTP

```
POST /api/tools/:name        # 도구 실행 (읽기 도구는 GET도 가능)
GET  /api/tools              # 도구 목록
POST /api/import             # 멀티파트 슬라이드 가져오기(PPT/PDF/이미지)
POST /api/import-service     # 멀티파트 예배 순서 JSON 가져오기(큰 파일 대응)
POST /api/bible-refs/extract # 주보 PDF에서 빨강 성구 추출
POST /api/upload             # 멀티파트 미디어 업로드
```

---

## 프로젝트 구조

```
lyra/
├── core/
│   ├── db/           # SQLite 연결·스키마·시드(성경/찬송/교독문 임포트)
│   ├── tools/        # ★ Tool Registry + 모든 도구(service/slide/content/template/library/media/present …)
│   ├── templates/    # 기본 슬라이드 종류(요소 배치 템플릿) 시드
│   ├── lib/          # ulid·검증·업로드·PDF/PPT 추출 등 유틸
│   └── splitter.js   # 긴 본문/가사 → 슬라이드 분할
├── adapters/         # cli.js · mcp.js · http.js · ws.js (레지스트리에서 자동 생성)
├── server/index.js   # 진입점: 정적 서빙 + HTTP + WebSocket
├── client/
│   ├── editor/       # 편집 화면
│   ├── presenter/    # 발표 화면
│   └── shared/       # 레이어 렌더러(편집/발표 공통)·API 클라이언트
├── themes/           # 내장 테마 JSON
└── data/             # worship.db(생성됨) · source/(콘텐츠, gitignore) · uploads/(gitignore)
```

---

## 데이터 모델 (요약)

- **Service(예배 = 순서 전체) > Slide(평면 순서)**. 공유 단위는 Service (`export_service`/`import_service`, worship-service/v2 JSON).
- **Slide = `{ background, elements[] }`**. 요소: `text` / `shape`(rect·ellipse·line) / `image` +
  **콘텐츠 요소** `bible` / `hymn` / `reading`(가져올 대상 params + 가져온 스냅샷 content + 글자 스타일).
- **Template = 요소 배치**. 기본 종류는 `apply_template`으로 콘텐츠를 가져와 긴 본문을 자동 분할.

자세한 설계·변경 이력은 [`CLAUDE.md`](./CLAUDE.md) 참고.

---

## 스크립트

| 명령 | 설명 |
|---|---|
| `bun run dev` | 서버 실행 (편집/발표/HTTP/WebSocket) |
| `bun run seed` | `data/source/*.json` → DB 임포트 |
| `bun run cli …` | CLI 어댑터 (`tools`/`schema`/`call`) |
| `bun run mcp` | MCP 서버(stdio) |
| `bun run db:reset` | DB 파일 삭제 후 스키마 재생성 |

---

## 라이선스 / 주의

- 개인·교회 내부용 로컬 도구입니다. 성경·찬송가·교독문 등 **콘텐츠 자료의 저작권**은 각 저작권자에게 있으며,
  본 저장소에는 포함되지 않습니다. 사용 시 저작권·이용 약관을 확인하세요.
