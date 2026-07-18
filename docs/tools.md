# Lyra 도구 레퍼런스 (자동 생성)

> `bun run scripts/gen-tools-md.js` 로 레지스트리에서 자동 생성됩니다 — 항상 코드와 일치.
> 개념 모델·연결 방법·워크플로우는 [AGENTS.md](./AGENTS.md) 참고.
> 런타임에서 최신 스키마 확인: CLI `bun run cli schema <이름>`, MCP `tools/list`.

총 **54개** 도구.

## 읽기 · 콘텐츠 검색 (LLM 그라운딩)

### `list_bible_books`  _(읽기 전용)_

성경 66권 목록(권 순서/이름/약칭/구약신약)을 반환한다.

_(입력 없음)_

### `get_bible_passage`  _(읽기 전용)_

성경 본문(책/장/절 범위)의 절 배열을 반환한다(슬라이드 생성 없이 조회만).

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `book` | string | ✔ |  |  |
| `chapter` | integer | ✔ |  |  |
| `verse_start` | integer | ✔ |  |  |
| `verse_end` | integer | ✔ |  |  |

### `search_bible`  _(읽기 전용)_

성경 전문 검색. 일치하는 절(책/장/절/본문)을 반환한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `query` | string | ✔ |  |  |
| `limit` | integer |  | `20` |  |

### `get_hymn`  _(읽기 전용)_

찬송가 번호로 제목과 절별 가사를 반환한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `number` | integer | ✔ |  |  |

### `search_hymn`  _(읽기 전용)_

찬송가 제목/가사 검색. 일치하는 번호·제목을 반환한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `query` | string | ✔ |  |  |
| `limit` | integer |  | `20` |  |

### `get_reading`  _(읽기 전용)_

교독문 번호로 제목과 segment(인도자/회중/다같이) 배열을 반환한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `number` | integer | ✔ |  |  |

### `search_reading`  _(읽기 전용)_

교독문 본문 검색. 일치하는 번호·제목을 반환한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `query` | string | ✔ |  |  |
| `limit` | integer |  | `20` |  |

## 예배(Service)

### `list_services`  _(읽기 전용)_

저장된 예배 순서(Service) 목록을 최신순으로 반환한다.

_(입력 없음)_

### `get_service`  _(읽기 전용)_

예배 순서 하나를 슬라이드 목록(평면, 순서대로)까지 포함해 반환한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  | 대상 Service ID |

### `create_service`  _(쓰기)_

새 예배 순서를 만든다. 제목/날짜/예배부(1부·2부·연합)와 선택적 테마를 받는다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `title` | string | ✔ |  |  |
| `date` | string | ✔ |  | YYYY-MM-DD |
| `worship_part` | string | ✔ |  | 예: 1부 / 2부 / 연합 |
| `theme_id` | string |  | `"dark-blue"` |  |

### `update_service`  _(쓰기)_

예배 순서의 필드(title/date/worship_part/theme_id)를 수정한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `fields` | object | ✔ |  |  |

### `duplicate_service`  _(쓰기)_

예배 순서 전체(슬라이드 포함)를 복사해 새 예배를 만든다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `title` | string |  |  | 새 제목(생략 시 원본+' (사본)') |

### `delete_service`  _(쓰기)_

예배 순서를 삭제한다(슬라이드 연쇄 삭제).

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |

### `set_service_theme`  _(쓰기)_

예배 순서의 테마와 커스텀 색을 설정한다. overrides={background?, accent?}로 배경/메인색을 덮어쓴다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `theme_id` | string |  |  |  |
| `overrides` | undefined |  |  | { background?, accent? } 객체 — 생략 시 유지, null이면 초기화 |

### `set_service_transition`  _(쓰기)_

발표 전환 효과를 설정한다: none(없음) | fade | slide.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `transition` | string (none\|fade\|slide) | ✔ |  |  |

### `export_service`  _(읽기 전용)_

예배 순서 전체를 공유용 JSON(worship-service/v2)으로 내보낸다. 슬라이드·테마 커스텀·전환과 첨부 이미지(assets, base64)까지 포함해 다른 머신에서도 그대로 재현된다. assets=false면 이미지 제외(가벼움).

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `assets` | boolean |  | `true` | 첨부 이미지 파일을 함께 내보낼지 |

### `import_service`  _(쓰기)_

공유용 JSON(worship-service/v2)을 받아 새 예배 순서로 가져온다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `payload` | object | ✔ |  | worship-service/v2 객체 |
| `title` | string |  |  | 가져올 제목(생략 시 payload 제목 사용) |

## 슬라이드(Slide)

### `add_slide`  _(쓰기)_

예배 순서에 슬라이드 하나를 추가한다. elements(요소 배열)/background/transition은 선택. position 생략 시 맨 끝.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `elements` | array |  |  | 요소 배열 (text/shape/image/bible/hymn/reading) |
| `background` | object |  |  |  |
| `transition` | string |  | `"fade"` |  |
| `position` | integer |  |  |  |

### `update_slide`  _(쓰기)_

슬라이드 필드를 수정한다. fields에 elements/background/transition 일부.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `slide_id` | string | ✔ |  |  |
| `fields` | object | ✔ |  |  |

### `set_slide_elements`  _(쓰기)_

슬라이드의 요소 배열 전체를 설정한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `slide_id` | string | ✔ |  |  |
| `elements` | array | ✔ |  |  |

### `set_slide_background`  _(쓰기)_

슬라이드 배경을 설정한다. null이면 테마 기본.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `slide_id` | string | ✔ |  |  |
| `background` | object |  |  |  |

### `set_slide_hidden`  _(쓰기)_

슬라이드를 발표에서 숨김/보임 설정한다. 숨긴 슬라이드는 발표 이동 시 건너뛰지만 편집기엔 남는다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `slide_id` | string | ✔ |  |  |
| `hidden` | boolean | ✔ |  |  |

### `reorder_slides`  _(쓰기)_

예배 순서 내 슬라이드 순서를 명시한 ID 배열대로 재배열한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `ordered_slide_ids` | array[string] | ✔ |  |  |

### `remove_slide`  _(쓰기)_

슬라이드를 삭제하고 뒤 슬라이드들의 순서를 메운다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `slide_id` | string | ✔ |  |  |

### `set_service_slides`  _(쓰기)_

예배의 슬라이드 전체를 주어진 배열로 교체한다(id·순서·hidden 보존). 실행취소/다시실행 스냅샷 복원에 쓴다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `slides` | array | ✔ |  |  |

## 콘텐츠 슬라이드 생성 (고가치)

### `add_bible_slides`  _(쓰기)_

성경 본문(책/장/절 범위)을 예배 순서에 추가한다. 절 수에 따라 자동 분할되고 성경 템플릿 디자인이 적용된다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `book` | string | ✔ |  | 책 이름 또는 약칭 (예: 요한복음, 요) |
| `chapter` | integer | ✔ |  |  |
| `verse_start` | integer | ✔ |  |  |
| `verse_end` | integer | ✔ |  |  |
| `layout` | string (auto\|one-per-verse\|all-in-one) |  | `"auto"` |  |

### `add_hymn_slides`  _(쓰기)_

찬송가 번호를 받아 가사 슬라이드를 예배 순서에 추가한다(찬송가 템플릿 디자인 적용).

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `number` | integer | ✔ |  | 찬송가 번호 |
| `verse_nos` | array[integer] |  |  | 표시할 절 번호(생략 시 전체) |
| `lines_per_slide` | integer |  | `4` |  |

### `add_reading_slides`  _(쓰기)_

교독문 번호를 받아 교독문 슬라이드를 예배 순서에 추가한다(교독문 템플릿 디자인 적용).

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `number` | integer | ✔ |  | 교독문 번호 |
| `segments_per_slide` | integer |  | `2` |  |

### `add_praise_slides`  _(쓰기)_

찬양팀 찬양 가사를 구조화된 sections로 받아 예배 순서에 슬라이드로 추가한다. sections=[{label, lines:[...]}]. 지저분한 가사 해석은 호출자(LLM)가 담당한다(내부 파서 없음).

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `title` | string | ✔ |  |  |
| `sections` | array[object] | ✔ |  |  |
| `lines_per_slide` | integer |  | `2` |  |

### `add_announcement_slide`  _(쓰기)_

광고 항목 배열을 받아 광고 슬라이드를 예배 순서에 추가한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `items` | array[string] | ✔ |  |  |
| `title` | string |  | `"광고"` |  |

## 템플릿(Template)

### `list_templates`  _(읽기 전용)_

모든 템플릿(기본 슬라이드 종류 + 커스텀 디자인)을 반환한다. 기본 종류가 먼저.

_(입력 없음)_

### `get_template`  _(읽기 전용)_

템플릿 하나를 params_schema·spec(요소 배치)까지 포함해 반환한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `template_id` | string | ✔ |  |  |

### `save_template`  _(쓰기)_

슬라이드 디자인(background + elements)을 새 커스텀 디자인 템플릿으로 저장한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `name` | string | ✔ |  |  |
| `slide` | object | ✔ |  | { background?, elements } |
| `description` | string |  | `""` |  |

### `apply_template`  _(쓰기)_

템플릿에서 슬라이드를 예배 순서에 추가한다. 기본 종류는 params(책·장·절, 제목 등)로 내용을 채우고 긴 내용은 자동 분할된다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `template_id` | string | ✔ |  |  |
| `service_id` | string | ✔ |  |  |
| `params` | object |  |  |  |
| `position` | integer |  |  |  |

### `update_template`  _(쓰기)_

템플릿 수정. 기본 종류는 디자인(요소 배치·스타일)만 저장(내용 스냅샷 제거), 커스텀은 전체. reset=true면 기본 종류 초기화.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `template_id` | string | ✔ |  |  |
| `name` | string |  |  |  |
| `slide` | object |  |  |  |
| `reset` | boolean |  |  |  |

### `delete_template`  _(쓰기)_

커스텀 디자인 템플릿을 삭제한다. 기본 슬라이드 종류는 삭제 불가(초기화만 가능).

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `template_id` | string | ✔ |  |  |

### `reset_templates`  _(쓰기)_

기본 슬라이드 종류(builtin 템플릿)가 비었거나 일부 빠졌을 때 다시 시드한다(멱등). 커스텀 템플릿은 건드리지 않는다. 템플릿이 0개면 아무것도 추가할 수 없으므로 복구용으로 쓴다.

_(입력 없음)_

## 미디어 · 임포트

### `upload_media`  _(쓰기)_

미디어 파일(영상/이미지)을 base64로 받아 저장하고 url을 반환한다. 브라우저 업로드는 POST /api/upload(멀티파트)를 쓴다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `filename` | string | ✔ |  | 원본 파일명(확장자 포함) |
| `data_base64` | string | ✔ |  | 파일 내용 base64 |

### `import_pdf`  _(쓰기)_

PPT(.pptx/.ppt/.odp)·PDF·이미지 파일(서버 경로)을 페이지별 이미지 슬라이드로 예배 순서에 추가한다. 라이브러리 검색 결과 가져오기에도 사용. 브라우저 업로드는 POST /api/import.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `path` | string | ✔ |  | 서버의 PDF/이미지 파일 경로 |
| `position` | integer |  |  | 삽입 시작 위치(생략 시 맨 끝) |

### `set_video_background`  _(쓰기)_

슬라이드 배경을 영상으로 설정한다(자동재생·음소거·반복 기본). 영상 위에 content 텍스트가 올라간다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `slide_id` | string | ✔ |  |  |
| `url` | string | ✔ |  | 영상 URL (예: /uploads/xxx.mp4) |
| `loop` | boolean |  | `true` |  |
| `muted` | boolean |  | `true` |  |
| `overlay_dim` | number |  | `0.4` | 가독성용 어둡게(0~1) |
| `playback_rate` | number |  |  |  |

## PPT 라이브러리

### `get_library_dir`  _(읽기 전용)_

지정된 PPT 라이브러리 폴더 경로와 색인된 파일 수를 반환한다.

_(입력 없음)_

### `set_library_dir`  _(쓰기)_

PPT 라이브러리 폴더(서버 절대경로)를 설정한다. 이후 index_library로 색인한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `path` | string | ✔ |  | 폴더 절대경로 |

### `index_library`  _(쓰기)_

라이브러리 폴더를 재귀 탐색해 PPT/PDF를 색인한다(파일명+내용). 변경된 파일만 다시 추출한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `refresh` | boolean |  | `false` | true면 강제 재색인 |

### `search_library`  _(읽기 전용)_

색인된 라이브러리에서 파일명·내용을 부분 문자열로 검색한다. 결과에 매치 스니펫 포함.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `query` | string | ✔ |  |  |
| `limit` | integer |  | `40` |  |

## 테마 · 폰트

### `list_fonts`  _(읽기 전용)_

사용 가능한 self-host 웹폰트 목록을 반환한다. 각 항목의 family를 요소 font 또는 서비스 기본 글꼴로 지정한다.

_(입력 없음)_

## 발표 제어

### `get_presentation_state`  _(읽기 전용)_

현재 발표 상태(서비스/슬라이드 인덱스/블랙아웃)를 반환한다.

_(입력 없음)_

### `present_goto`  _(쓰기)_

발표 화면을 특정 슬라이드로 이동한다. page_index는 서비스 전체 슬라이드의 0-base 순번.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `page_index` | integer | ✔ |  | 전체 슬라이드 기준 0-base 인덱스 |
| `service_id` | string |  |  | 발표할 서비스(생략 시 현재 유지) |

### `present_blackout`  _(쓰기)_

발표 화면을 검은 화면으로 전환/해제한다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `on` | boolean | ✔ | `true` |  |

### `present_reload`  _(쓰기)_

발표 화면에 콘텐츠 새로고침을 지시한다(편집 후 반영).

_(입력 없음)_

## 시스템

### `list_network_addresses`  _(읽기 전용)_

이 서버 머신의 LAN IPv4 주소 목록을 반환한다. 같은 네트워크의 다른 기기에서 접속 주소를 만들 때 쓴다.

_(입력 없음)_

## 기타

### `present_set_service`  _(쓰기)_

발표 대상 서비스를 지정한다. 현재와 다르면 첫 슬라이드로 이동하고 발표 화면이 따라온다(같으면 유지). 편집기가 현재 예배를 발표 화면과 동기화하는 데 쓴다 — 새 예배를 열면 발표 화면·새로고침도 그 예배를 따라간다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |

### `parse_bible_refs`  _(읽기 전용)_

자유 텍스트(예: '요 3:16-18, 롬 8:1')를 구조화된 성경 참조 배열로 파싱한다. 문맥(직전 책/장)을 추적해 '18', '16절' 같은 부분 참조도 해석. 슬라이드 생성 전 미리보기용.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `text` | string | ✔ |  | 성경 참조 문자열 |

### `extract_bible_refs_from_pdf`  _(읽기 전용)_

주보 PDF(서버 경로)에서 빨강으로 표기된 성구를 추출해 참조 배열로 반환한다(슬라이드 생성 없이 조회만). 브라우저 업로드는 POST /api/bible-refs/extract.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `path` | string | ✔ |  | 서버의 PDF 파일 경로 |

### `add_bible_ref_slides`  _(쓰기)_

성경 참조(자유 텍스트 text 또는 구조화된 refs)를 성경 본문 슬라이드로 예배 순서에 추가한다. 성경 템플릿 디자인·자동 분할 적용. 주보 PDF는 먼저 extract_bible_refs_from_pdf로 참조를 얻어 넘긴다.

| 파라미터 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `service_id` | string | ✔ |  |  |
| `text` | string |  |  | 성경 참조 문자열(예: '요 3:16-18, 롬 8:1'). refs가 없을 때 파싱. |
| `refs` | array[object] |  |  | 구조화된 참조 배열(parse_bible_refs 결과). 있으면 text 대신 사용. |
| `layout` | string (auto\|one-per-verse\|all-in-one) |  | `"auto"` |  |
| `position` | integer |  |  | 삽입 시작 위치(생략 시 맨 끝) |

