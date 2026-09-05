# Lyra — 주일예배 PPT 전체 설계 문서 (v4.1)

> 작성일: 2026-06-24 (v4.1 갱신: 2026-07-04) · 프로젝트명 **Lyra** (구 ryre / Sunday Worship)
> 스택: Bun + 순수 HTML/JS + SQLite
> 실행 환경: M1 Max MacBook Pro (로컬 전용)
> v4 핵심: **슬라이드 = 요소 캔버스** (모든 콘텐츠가 요소) / 템플릿 = 요소 배치 / **MCP·CLI 우선 Tool-First**

> ⚠️ **v4.1 추가 (편집 UX·테마·전환·임포트·이름)** — 구현 기준(현행)
> - **이름 = Lyra** (구 ryre / "Sunday Worship"). UI 브랜드 "Lyra", 패키지·MCP id는 소문자 `lyra`. tool 인터페이스·데이터 불변.
> - **스냅/가이드**: 요소 드래그·리사이즈 시 캔버스 가장자리·가운데(0/0.5/1)에 스냅 + 점선 가이드(`.guide-v/.guide-h`).
> - **글자 크기 숫자 입력**: 디자인 패널 size = 슬라이더 + 숫자(cqw) → 여러 슬라이드에 동일 값 적용.
> - **테마**: 프리셋 dark-blue/light-warm/**black** + 서비스별 커스텀 **배경색·메인색**(`services.theme_overrides` JSON,
>   `mergeTheme`로 편집/발표 병합). `set_service_theme(service_id, theme_id?, overrides?)`.
> - **전환 효과**: `services.transition` = none|fade|slide. `set_service_transition`. 발표(presenter)가 deck에
>   두 stage를 교차(fade=opacity, slide=translateX ~360ms). 편집기 topbar에서 토글.
> - **슬라이드 임포트**: **PPT(.pptx/.ppt/.odp)·PDF·이미지** → 이미지 요소 슬라이드. `POST /api/import`(멀티파트) +
>   `import_pdf(service_id, path)` tool. Office는 LibreOffice `soffice`로 PDF 변환 후 `pdftoppm` 페이지 분할.
>   soffice 미설치 시 PDF로 내보내 사용(graceful). `core/lib/pdf-import.js`(findSoffice/officeToPdf/officeImportAvailable).
> - **PPT 라이브러리 (v4.2)**: 폴더 하나 지정(`settings.library_dir`, 서버 경로) → 재귀 색인(`library_index` 캐시,
>   mtime 증분) → **파일명+내용 부분검색**(pptx/odp=**fflate 순수 JS 압축해제**+슬라이드 XML, pdf=pdftotext; .ppt는 파일명만).
>   여러 단어=AND, 파일명·내용 NFC 정규화(macOS NFD 대응). 결과를 `import_pdf`로 가져오기. 도구
>   get/set_library_dir·index_library·search_library(`core/tools/library.tools.js`, `core/lib/ppt-extract.js`). 편집기 "라이브러리" 모달.

> ⚠️ **크로스플랫폼 / 외부 의존성** (macOS·Windows·Linux)
> - 순수 이식: 편집·발표·DB·서버·요소편집·**pptx/odp 내용 추출(fflate)**은 외부 도구 없이 어디서나 동작.
> - 외부 프로그램 필요(선택 기능): **LibreOffice**(`soffice`) = .pptx/.ppt/.odp 슬라이드 임포트,
>   **poppler**(`pdftoppm`/`pdftotext`) = PDF 임포트·PDF 내용 검색. `findSoffice`가 mac/Win/Linux 경로 탐지,
>   프로필은 `-env:UserInstallation`(OS 무관). 미설치 시 명확 안내로 graceful. Windows: LibreOffice/poppler 설치+PATH.
> - DB 마이그레이션은 **비파괴**(services에 theme_overrides·transition 컬럼 ALTER 추가, `core/db/index.js` ensureColumn).

> ⚠️ **v4.12 추가 (찬양 PPT 모음 → 가사 데이터)** — 구현 기준(현행)
> - 왜: 악보 PPT를 그만 쓰고 "가사만 + 배경 영상"으로 바꾸면서, 기존 찬양 PPT 모음의 **가사를 Lyra 안에서
>   검색·재사용**해야 했다. 대상 = `찬양/찬양ppt모음_WIDE` 474곡(.ppt 296 + .pptx 93 + .ppt 85).
> - **왜 OCR인가 (실측 근거)**: `.pptx` 93곡 중 가사 텍스트가 제대로 든 건 **11곡뿐**, 69곡은 가사가
>   **이미지로 박혀** 있다(예: "시선" = 슬라이드마다 PNG 2개, 추출 텍스트는 6자). `.ppt`는 텍스트가 있어도
>   **홀수 줄만 담긴 목차 텍스트박스**라 화면에 보이는 가사와 다르다. → 슬라이드를 렌더해 보이는 그대로
>   읽는 것만이 일관된 방법. `pptx` 임베드 텍스트만 믿으면 80%를 놓친다.
> - **파이프라인** `scripts/extract-song-lyrics.js`: LibreOffice(`--convert-to pdf`) → `pdftoppm`(PNG, 110dpi)
>   → **macOS Vision OCR**(`scripts/ocr-vision.swift` → `data/bin/ocr`, 필요 시 자동 빌드) → 장식 제거.
>   worker마다 LibreOffice 프로필을 분리해야 병렬이 막히지 않는다(`--jobs`, 기본 4).
>   곡당 ~7.5초 · 474곡 ≈ 13분(jobs 6).
> - **장식 제거는 결정적 규칙**(휴리스틱 파서 아님 → 설계 §15 위반 아님. 슬라이드·줄 나눔은 원본 그대로 가져온다):
>   ① 글자 높이 < 5% (작게 박힌 목차·출처) ② **여러 장에 반복되는 줄**(제목·목차·워터마크 — 가사는 장마다 다르다)
>   ③ 한 글자·기호 ④ 숫자/구분선만. 앞뒤의 빈 장(표지·간지)은 떼고 중간 빈 장은 원본 구성이라 남긴다.
>   OCR이 좌표(x·y·w·h)와 신뢰도를 함께 내보내는 이유가 이 필터다.
> - **데이터**: `data/source/songs.json`(gitignore됨 — 저작권 콘텐츠, bible/hymns와 같은 취급).
>   `lyra-songs/v1` = `{songs:[{title, source, ext, slides, pages:[[줄…],…], lines, chars, conf}], failed}`.
>   **사람이 직접 고쳐도 되는 원본** → 고친 뒤 `bun run core/db/seed/index.js --songs`로 재적재(성경·찬송 재적재 생략).
> - **DB**: `songs(id,title,source,pages,conf)` + `song_pages(song_id,page_no,text)` + `songs_fts(title,text)`.
>   `page_no` = **원본 PPT의 슬라이드 순서 그대로** → 가져오면 원래 넘김이 재현되고, 필요하면 다시 나눌 수도 있다.
>   적재 시 `cleanTitle`이 파일명 잡음을 정리한다(`PPT `, `16_9`, `_Wide`, `(WIDE)`, `(검)` …). 원본명은 `source`에 남는다.
> - **도구**: `search_song(query,limit)` · `get_song(song_id)` · `list_songs(limit,offset)` (`core/tools/search.tools.js`),
>   `add_song_slides(service_id, song_id, template_id?, keep_pages?, lines_per_slide?, position?, style?)`
>   (`core/tools/content.tools.js`). keep_pages=true(기본)면 **장마다 apply_template을 한 번씩** 불러 원본 구성을
>   그대로 만든다(이어붙이면 lines_per_slide 규칙이 원본 나눔을 뭉갠다). v4.11의 커스텀 가사 템플릿·style과 그대로 조합된다.
> - **편집기**: ＋추가 → **🎵 찬양 가사에서 찾기**(`#song-modal`) = 제목·가사 검색 + 디자인 템플릿 선택
>   (bind:lyrics를 가진 템플릿만 나열) + "원본 장 나눔 유지" 토글. `conf < 0.4`인 곡엔 **검토** 배지.
> - **NFC 정규화 필수(실측 함정)**: macOS 파일명은 한글을 **NFD(자모 분리)**로 준다. 그대로 넣으면
>   제목 **381/400곡이 NFD**로 저장돼 `LIKE '%내 안에 사는 이%'`가 **0건**이 된다 —
>   FTS(unicode61)는 우연히 동작해서 눈에 안 띈다. 그래서 ① 추출 스크립트가 title·source·OCR 줄을
>   NFC로 쓰고 ② `cleanTitle`·`import-songs`가 제목·가사를 다시 NFC로 맞추고
>   ③ **`export_service`가 내보내는 JSON 전체를 NFC로 정규화**한다(`toNfc`, `data_base64`는 제외)
>   → 공유 파일에 자모 분리가 새어 나가지 않는다. 라이브러리 색인의 NFC 정책과 같은 이유.
> - **후렴이 장식으로 걸러지던 버그(실측 수정)**: "여러 장에 반복되면 장식" 규칙만으로 지우면
>   **후렴이 날아간다**(15곡 손실 관측: 원본 10장 → 가사 2장 등). 화면 가사는 그 장에서 가장 큰 글자이므로
>   **반복 + 그 장 최대 높이의 70% 미만**일 때만 장식으로 본다(`bigRatio`). 수정 후 15곡 전부 복구,
>   가사줄 9,727 → 10,646(+919). Vision은 실행마다 인접 줄을 합치는 편차가 있어 장수 동일·줄 수만
>   1~7줄 차이 나는 곡이 3곡 생겼다(구조 손실은 아님).
> - **실적(현행 데이터)**: 473/474곡 · 4,213장 · 가사 10,646줄 · 13.4분(jobs 6) · `songs.json` 704KB.
>   실패 1곡 = `고단한 인생길…(예수, 늘 함께하시네)_WIDE_PPT.pptx` — 정상 pptx인데 LibreOffice가
>   이 파일의 PDF 쓰기에만 실패(Io/Write). 짧은 ASCII 이름으로 복사해도 동일 → 파일명 문제 아님.
> - **한계(정직하게)**: OCR 산출물이므로 오탈자가 남는다. 신뢰도(conf)는 Vision 기준이며 외곽선 장식 글꼴에서
>   0.5 근처로 낮게 나오지만 실제 정확도는 그보다 높다(자모 분리 0% 관측). 추출은 **macOS 전용**(Vision) —
>   윈도우에서는 만들어진 `songs.json`을 가져다 쓰면 된다.

> ⚠️ **v4.11 추가 (가사 템플릿 자유화 · 서식 복사기)** — 구현 기준(현행)
> - 문제였던 것: 찬양(가사)로 추가하면 **템플릿에 저장된 한 가지 디자인**만 나왔다. 곡마다 다르게 하려면
>   템플릿 자체를 바꿔야 했고(= 다음 주에도 그 디자인), 이미 추가한 10장을 고치려면 장마다 반복해야 했다.
>   더 결정적으로 **커스텀 템플릿은 가사를 생성하지 못했다** — `save_template`이 `params_schema='{}'`로
>   고정 저장하고 `apply_template`이 custom을 `buildSlidesFromTemplate` 없이 그대로 한 장 넣었기 때문.
>   (사용자의 "크로마키 가사"·"루마키 가사"가 정확히 이 상태였다: `bind:"lyrics"`는 살아 있고 입력칸만 없음)
> - **① `apply_template(…, style)`**: 이번에 추가하는 **본문 요소**의 서식만 덮어쓴다(템플릿 불변).
>   필드 = `STYLE_FIELDS` = font·size·color·align·valign·weight·line_height·x·y·w·h·opacity.
>   대상은 `styleTargets()` — 콘텐츠 요소의 본문(field 없음/all/text/body/lyrics)이나 `bind`이 lyrics·items인
>   텍스트. 없으면 bind된 텍스트 전부(타이틀 등). 제목·참조까지 같이 키우면 배치가 무너지므로 본문만.
>   편집기 = ＋추가 모달의 접이식 **"디자인 (이번에 추가하는 것만)"**(글꼴·크기·색·가로/세로정렬·굵기·줄간격,
>   비우면 템플릿 기본). 위치·크기는 캔버스에서 맞추고 아래 ③으로 퍼뜨리는 쪽이 낫다.
> - **② 커스텀 템플릿도 생성형이 된다**: `save_template`이 요소의 `bind`/콘텐츠 종류에서
>   **`params_schema`를 자동 도출**(`deriveParamsSchema`)하고 굳은 내용을 비운다(`stripForTemplate`이
>   bind된 텍스트를 자리표시자로). lyrics면 `lines_per_slide`까지. `apply_template`은 custom이라도
>   **params_schema에 입력칸이 있으면** 기본 종류와 같은 생성·분할 경로를 탄다.
>   → "내가 꾸민 가사 디자인"을 매주 가사만 넣어 재사용. `update_template`도 custom이면 스키마를 재도출.
>   **하위호환**: 입력칸이 빈 옛 커스텀 템플릿은 예전처럼 디자인 그대로 한 장 추가(동작 불변).
>   옛것을 바꾸고 싶으면 `upgrade_template_params(template_id)` — 디자인 유지, 굳은 내용만 삭제.
>   편집기 템플릿 목록이 해당 템플릿에 **"⚡ 입력칸 만들기"** 버튼과 상태 설명을 띄운다(사용자 확인 후 실행).
>   `list_templates`가 이제 **spec까지 반환**한다(추가 모달의 기본값·업그레이드 안내에 필요).
> - **③ 서식 복사기 `copy_slide_style(source_slide_id, target_slide_ids, include_background?, fields?)`**:
>   한 장을 캔버스에서 원하는 대로 꾸민 뒤 나머지 장에 **서식만** 입힌다(내용 불변).
>   요소 짝짓기 = `bind:<name>` → `content:<type>:<field>` → `type:<type>:<n번째>`. 짝 없는 요소는 안 건드린다
>   → 가사 슬라이드에서 실행해도 성경·찬송 슬라이드는 영향 없음(키가 안 겹친다).
>   UI는 **"복사 → 붙이기" 2단계**(우측 슬라이드 패널). 1단계로 하면 대상을 ⌘클릭하는 순간 현재 슬라이드가
>   바뀌어 **원본이 마지막에 클릭한 대상으로 슬쩍 바뀐다** — 그래서 원본을 `state.styleSource`에 고정하고
>   목록 행에 🎨 표시를 준다. 대상 미선택 상태로 누르면 "나머지 전체"(확인 후).
> - 버그 수정: 추가 모달의 가사 입력칸 라벨이 `lyrics`(원문 키)로 나왔다 → PARAM_LABELS에 추가.

> ⚠️ **v4.10 추가 (여러 슬라이드에 같은 배경 영상)** — 구현 기준(현행)
> - 배경 목적이 바뀌었다: **악보 PPT 대신 가사만 띄우고 뒤에 루프 영상·GIF를 깐다.** 그래서 한 배경이
>   여러 슬라이드에 걸린다. 데이터 모델은 그대로(배경은 슬라이드마다) — 대신 **적용**과 **재생 연속성**을 붙였다.
> - **적용(일괄)**: `set_slide_background` · `set_video_background`가 `slide_ids`(배열)를 받는다. 한 트랜잭션,
>   touch_service 1회. 편집기는 멀티셀렉(⌘/Shift 클릭) 상태에서 배경을 바꾸면 **선택 전체**에 적용
>   (`bgTargetIds()`), 버튼 라벨·안내문이 "N장에 배경 적용"으로 바뀐다.
> - **재생 연속성(핵심)**: 예전엔 슬라이드마다 스테이지를 새로 만들어 `<video>`가 재생성 → **넘길 때마다 루프가
>   0초로 되감기고 깜박였다**(실측: 4.18초 → 0.68초). 이제
>   ① `layer-renderer`가 `bgKey(bg)`로 배경 정체성을 비교해 **키가 같으면 배경을 다시 그리지 않는다**
>     (편집기에서 타이핑·선택할 때마다 영상이 리로드되던 것도 함께 해결),
>   ② 발표 화면은 영상/GIF 배경(`isLiveBackground`)일 때 그 `.layer-bg`를 **deck 바닥으로 hoist**해 살려두고
>     그 위에 투명 스테이지(`.on-live-bg`)만 갈아끼운다 → 같은 배경인 동안 `<video>` 1개가 계속 재생
>     (실측: 3.82 → 4.52 → 5.22 → 5.92초, 동일 element). 배경이 바뀌면 hoist를 풀고 평소 전환 효과를 태운다.
>   사운드 트랙(`tracks`)이 슬라이드 구간에 걸쳐 `<audio>`를 살려두는 것과 같은 발상.
> - **배경 라이브러리**: 자주 쓰는 배경을 이름 붙여 저장(`settings.backgrounds` JSON). 도구
>   `list_backgrounds` / `save_background(name, background)` / `remove_background(background_id)`.
>   편집기 우측 "슬라이드 > 🎬 배경 고르기" 모달(`#bg-modal`) = 저장한 배경 + **이 예배에서 쓰는 배경**(사용 장수까지)
>   + 영상·이미지 업로드. 카드를 누르면 선택한 슬라이드 전체에 적용.
> - **템플릿 경로도 그대로 동작**: 배경을 넣은 슬라이드를 `save_template`으로 저장하면 `apply_template`이 만드는
>   모든 가사 장에 같은 배경이 복제된다 → 매주 "가사 + 배경 영상" 한 번에 생성.
> - **루프가 아닌 영상을 루프로 굽기**: 끝 프레임 ≠ 첫 프레임이면 반복할 때마다 툭 튄다. 발표 중에
>   손보는 게 아니라 **미리 파일로 한 번 구워둔다**(런타임 비용 0). `make_loop_video(url, mode, seconds?)`
>   → `/uploads/<ulid>.mp4`. `probe_video(url)`로 길이·코덱 확인. `core/lib/ffmpeg.js`(findFfmpeg/probeVideo/makeLoopVideo).
>   - `crossfade`(기본): body(N~D-N) 뒤에 **[끝 N초 → 첫 N초] xfade**를 붙인다. 디졸브 끝 지점이 원본 N초
>     = body 시작과 같은 그림이라 되감겨도 이음새가 없다. 길이 = D-N. 겹침은 D/3로 상한.
>     실측(검정→흰색 램프 6초): 이음새 Y차 **253 → 3**.
>   - `pingpong`: 정방향+역방향(역방향 첫 프레임 1장 버려 멈칫 제거). 이음새 **완전 일치(0)**, 길이 ≈2배.
>     `reverse`가 전체를 메모리에 올리므로 **60초 초과는 거부**. 방향성 있는 영상은 되돌아가는 게 티 난다.
>   - 출력은 항상 **H.264/yuv420p/무음 + faststart** → 윈도우 방송실 PC 코덱 호환 문제(H.265 등)도 같이 해결
>     (실측: hevc 입력 → h264 출력). ffmpeg은 **선택 외부 도구**, 없으면 설치 안내로 graceful.
>     `check_environment`에 `ffmpeg` 항목 추가. 탐지 순서 PATH → `LYRA_FFMPEG` → `tools/` → 일반 설치 위치.
>   - UI: 배경 고르기 모달의 **영상 카드에 `🔁 루프로`** → 카드 안에서 디졸브/왕복 선택(설명은 title) →
>     busy 오버레이 → 완성되면 라이브러리에 `<이름> (디졸브|왕복)`으로 저장 + 선택한 슬라이드에 즉시 적용.
> - **내보내기에서의 배경 영상** (경로별로 다르다)
>   - **이미지 내보내기**: `<video>`를 그대로 두면 **첫 프레임**이 찍힌다 → 루프 배경은 검정에서
>     페이드인하는 경우가 많아 **배경이 새까맣게 나온다**(실측 확인). `--print-to-pdf`의
>     `--virtual-time-budget`은 미디어 디코드를 기다려주지 않아서 페이지에서 `currentTime`을
>     옮기는 방식은 **안 통한다**(실측). 그래서 **서버에서 ffmpeg으로 대표 프레임(기본=중간 지점)을
>     뽑아 `<img>`로 바꿔 그린다** — `get_video_poster(url, seconds?)` → `/render-cache/poster-<key>.jpg`
>     (캐시), `client/export/export.js`의 `withPosterBackgrounds`. 이미지 대기 경로(`waitPainted`)를
>     그대로 타므로 확실하다. `background.poster_time`(초)으로 지점 지정 가능.
>     같은 배경을 쓰는 여러 장은 poster 1개만 만든다. ffmpeg 없으면 원래대로 `<video>`(첫 프레임) — graceful.
>   - **JSON 내보내기**(`export_service`): 배경 영상도 **base64로 통째 포함**된다(중복 파일은 1번만).
>     base64는 1.33배 → 398MB 영상이면 **531MB JSON**(실측). 그래서 `asset_refs:[{url,bytes}]`를
>     `assets=false`일 때도 항상 반환하고, 편집기는 합계 **40MB 초과 시 물어본다**(함께 넣기 / JSON만).
>     `assets:false`면 배경 url만 남으므로 받는 쪽에 파일이 없으면 배경이 빈다.
>   - **데이터 번들**(`scripts/export-bundle.js`): uploads를 파일째 복사 → 영상 그대로 이관(대용량 이관 권장 경로).
> - 참고: 썸네일·타일은 여전히 영상 배경을 그라데이션 플레이스홀더로 대체한다(`thumbSlide`, `<video>` 남발 방지).

> ⚠️ **v4.9 추가 (이미지 내보내기)** — 구현 기준(현행)
> - JSON(`export_service`) 외에 **슬라이드를 이미지로** 내보낸다. `export_slide_images(service_id, slide_ids?, include_hidden?, format?)`
>   → `data/exports/<날짜_부_제목>/001.webp …` + 파일 목록. 편집기는 ⚙예배▾ "🖼 이미지로 내보내기"
>   (여러 장 선택 시 그 장만) → `POST /api/export/images`가 zip으로 내려준다.
> - **렌더는 헤드리스 크롬**이 전용 화면 `/export/?service_id=…[&ids=…][&index=N]`을 굽는다
>   (`client/export/*`). 편집·발표와 같은 `layer-renderer`를 쓰므로 보이는 그대로 나온다.
>   브라우저 JS로 굽는 방법(SVG foreignObject→canvas)은 **크롬이 캔버스를 오염시켜 불가**.
> - 경로 2개: ① 크롬 `--print-to-pdf` 1회 → `pdftoppm` **페이지 범위 병렬** 분할(145장 ≈ 63초),
>   ② poppler 없으면 장당 `--screenshot`(크롬만 필요, 장당 ~2.5초). cwebp 있으면 WebP, 없으면 PNG.
> - 크롬은 파일을 다 쓴 뒤에도 프로세스가 남는다 → stderr의 `"bytes written to file"`을 완료 신호로
>   쓰고 바로 kill(`runUntilFile`). 종료를 기다리면 145장에서 3분+ 멈춘다. 새 프로필은
>   백그라운드 네트워크를 끊어야(`--disable-background-networking` 등) `--virtual-time-budget`이 만료된다.
> - 도구 `check_environment`로 크롬·poppler·cwebp·필수 모듈 설치 상태를 한 번에 확인.

> ⚠️ **편집기 UI 구성 (v4.7)** — 문맥 인스펙터 + 통합 추가 (v4.3의 3탭 구성을 대체)
> - 상단바 = **4그룹**: `Lyra · 예배선택 │ 리스트/타일 │ ＋추가▾ · ⚙예배▾ │ ▶발표`.
>   **＋추가▾** = 슬라이드(템플릿 목록·`renderAddMenu`) + 📖성구 + 🖼파일(PPT/PDF/이미지) + 🔎라이브러리.
>   **⚙예배▾** = 테마·색·글꼴·전환 + 🎵사운드 트랙 + 🎨디자인 템플릿 + JSON 내보내기/가져오기 + 예배 생성·수정·복제·삭제 + 접속 주소.
>   메뉴 토글 `wireMenu`(바깥클릭/Esc 닫힘, 항목 클릭은 위임으로 닫힘).
> - 우측 패널 = **속성 전용(탭 없음)**: `슬라이드`(배경·숨기기, `<details data-gkey="slide-props">`) + `선택한 요소`
>   (내용/글자/효과 접이식 그룹). 요소를 고르면 탭 전환 없이 바로 속성이 뜬다.
> - **슬라이드 추가는 모달**(`#add-modal`): ＋추가에서 종류를 고르면 params 입력창이 뜨고(입력이 없는 종류는 즉시 추가),
>   `add-type`/`add-fields`/`add-after-btn`/`add-slide-btn`/`add-msg` id는 그대로 재사용. 템플릿 관리도 모달(`#tpl-modal`, `tpl-save`/`tpl-list`).
> - 캔버스 위 요소 툴바는 **아이콘 전용**(툴팁으로 설명). 기존 핸들러 id는 모두 불변.

> ⚠️ **v4.4 추가 (self-host 무료 웹폰트)** — 구현 기준(현행)
> - **오프라인 우선**: 구글폰트 CDN 링크가 아니라 폰트 파일을 로컬에 받아 `data/fonts/`에서 서빙(`/fonts/`).
>   예배 중 인터넷이 끊겨도 폰트 유지. 출처=fontsource(jsDelivr), 패밀리별 korean/latin 결합 woff2 1~2파일 +
>   직접 작성 `@font-face`(unicode-range). 빌드/추가: `bun run scripts/build-fonts.js`(FONTS 배열에 추가 후 재실행).
>   산출물 `data/fonts/{files/*.woff2, fonts.css, fonts.json}`. 기본 14종(한글 노토산스/나눔명조/송명/블랙한산스/도현/주아/
>   개구/나눔펜/고운도담 + 영어 Montserrat/Roboto/Playfair/Bebas/Dancing).
> - **도구**: `list_fonts()` → 매니페스트(`core/tools/font.tools.js`). Tool-First 일관.
> - **적용**: 요소(text/bible/hymn/reading)에 `font`=family 문자열 → 렌더러가 `fontFamily` 지정(`layer-renderer.js`).
>   서비스 기본 글꼴 = `theme_overrides.font`(`mergeTheme`가 `--font-family`에 병합). 요소 font가 없으면 기본 글꼴 상속.
> - **UI**: 디자인 탭 "선택한 요소"에 **글꼴 select**(text·콘텐츠 요소), ⚙설정에 **기본 글꼴 select**(id `font-select`).
>   둘 다 `list_fonts`로 채움. editor+presenter가 `/fonts/fonts.css` 로드.

> ⚠️ **v4 변경 (요소 중심 모델)** — 구현 기준(현행, 가장 권위 있음)
> - **슬라이드 = `{ background, elements:[] }`.** 타입 슬라이드(template_type)·typed data·overlays 레이어를 제거.
>   `slides(id, service_id, position, background, elements, transition)`.
> - **요소(element)**: text / shape(rect·ellipse·line) / image + **콘텐츠 요소** bible / hymn / reading.
>   콘텐츠 요소 = `{ params(가져올 대상), content(가져온 스냅샷), x,y,w,h, size,color,align,weight … }` —
>   **성경/교독문/찬송 본문도 폰트·색·위치를 자유 편집**(요소이므로). 0~1 상대 박스, size=cqw.
> - **템플릿 = 요소 배치** `spec={background, elements}`. 기본 종류는 콘텐츠 요소/`bind:"param"` 텍스트를 가짐.
>   `apply_template`이 bind 채우고 params로 content를 fetch, **긴 본문/가사를 N장으로 자동 분할**(각 장이 템플릿 디자인 복제).
>   콘텐츠 도구(add_*_slides)는 apply_template(builtin-*)로 위임. 기본 종류 편집=요소 배치/스타일만(내용은 param).
> - **공유 = `export_service`/`import_service` worship-service/v2** (elements). DB는 v3→v4 스키마 리셋.
> - 렌더링: `layer-renderer.js`가 background + elements(콘텐츠 요소 본문 포함) 단일 렌더 → 편집/타일/발표 동일.
> - 아래 본문(§4 data·§5 레이어·§6 슬라이드 타입·§8 slide 도구)의 옛 설명은 **이 v4 노트로 대체**. 권위는 이 노트 + 코드.

> ⚠️ **v3 변경 (Scene 계층 제거)** — 구현 기준(현행)
> - **Scene 계층을 제거**했다. 슬라이드는 한 예배(Service) 안에 **하나의 연속된 순서**로 평면 저장된다(`slides.service_id` + `position`).
> - **공유 단위는 Service 전체**(= 한 예배의 순서 전체). `export_service` / `import_service` (worship-service/v2 JSON). Scene Library/`scene_library` 테이블·scene 도구는 폐기됐다.
> - 편집 화면은 **리스트 뷰 + 타일(썸네일 그리드) 뷰 토글**을 제공한다.
> - 아래 본문 중 `Scene`/`scene_*` 도구·`scenes`/`scene_library` 테이블·`worship-scene/v1` 언급은 **이 v3 노트로 대체**됐다(역사적 기록). 권위 있는 현행 구조는 §1·§4·§8·§10·§15와 이 노트다.

---

## 0. 설계 철학 — Tool-First / Headless-First (가장 중요)

이 시스템의 **제품 본체는 Tool Registry**다. UI가 아니다.
모든 기능은 Tool로 구현되고, **MCP·CLI·HTTP 세 어댑터가 레지스트리에서 자동 생성**된다.
외부(Claude / 로컬 vLLM / AXIS / 셸 스크립트)가 1차 사용자이고, UI는 그중 한 클라이언트일 뿐이다.

```
                  ┌─────────────────────────┐
                  │      Core Engine        │
                  │   (순수 함수 + DB)       │
                  └────────────┬────────────┘
                               │
                  ┌────────────▼────────────┐
                  │      Tool Registry      │  ← 제품 본체. 모든 기능이 여기 등록
                  │  { name, description,   │     이 레지스트리에서 아래 3어댑터를
                  │    input_schema, handler}│     자동 생성 (수기 매핑 없음)
                  └────────────┬────────────┘
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
  │   MCP Server   │  │      CLI       │  │   HTTP (thin)  │
  │  ★ 1차 인터페  │  │  ★ 1차 인터페  │  │   UI 전용 래퍼  │
  │   이스 (외부   │  │   이스 (셸/    │  │                │
  │   에이전트)    │  │   cron/자동화) │  │                │
  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
          ▼                   ▼                   ▼
  [Claude/AXIS/         [터미널/스크립트/      [로컬 편집 UI]
   로컬 vLLM]            cron 자동화]
```

**원칙:**
1. 모든 기능 = Tool. UI 전용 로직을 따로 만들지 않는다.
2. Tool은 JSON Schema로 입출력이 명세된다 → MCP tool / CLI 명령 / HTTP 엔드포인트로 **자동 생성**.
3. **MCP와 CLI가 1차 인터페이스.** 외부에서 호출 가능해야 큰 수정 없이 지속 발전·자동화가 된다.
4. UI는 Tool의 한 소비자. "UI가 할 수 있는 모든 것 = 외부 LLM·CLI가 할 수 있는 모든 것".
5. **"지능"은 외부 LLM에 둔다.** 내부에 복잡한 휴리스틱(예: 찬양 가사 파싱)을 만들지 않는다.
   Tool은 구조화된 입력을 받아 결정적으로 동작하고, 모호한 해석은 LLM이 담당한다.
6. 이 구조 덕분에 "주보 PDF → 완성된 예배 덱" 전체 자동화가 자연히 가능해진다.

---

## 1. 개념 계층 구조

```
Service (예배 = 순서 전체)   "2026-06-28 1부 예배"  ← 공유 단위
  └─ Slide (슬라이드)        개별 화면, 하나의 연속된 순서(position)로 평면 저장

Template (템플릿)           슬라이드를 생성하는 "생성기" (계층 밖, 도구)
Theme (테마)               시각 스타일 (계층 밖, Service에 적용)
```

| 개념 | 정의 | 저장 | 공유 |
|------|------|------|------|
| Service | 한 예배의 순서 전체 | DB | **export/import (worship-service/v2 JSON)** + 덱 복사 |
| Slide | 개별 화면 (순서 내 position) | DB | (Service 단위로) |
| Template | 슬라이드 생성기 | DB(custom) + 파일(builtin) | JSON |
| Theme | 시각 스타일 | DB(custom) + 파일(builtin) | JSON |

> Scene(씬) 계층은 v3에서 제거됨. "씬"은 곧 한 예배의 순서 전체(=Service)를 가리키던 표현이었고, 이제 Service가 그 단위다.

---

## 2. 요구사항 명세

### 2-1. 기능 요구사항

| ID  | 기능 | 우선순위 |
|-----|------|---------|
| F01 | Service 생성/불러오기/저장/복사 | 핵심 |
| F02 | Scene 추가/제거/순서변경, **JSON export/import** | 핵심 |
| F03 | Scene Library (재사용 씬 저장/공유) | 핵심 |
| F04 | Slide 추가/제거/순서변경(드래그) | 핵심 |
| F05 | **Template 시스템** (내장 + 커스텀, 파라미터 → 슬라이드 생성) | 핵심 |
| F06 | 성경 본문 → 슬라이드 자동 생성 | 핵심 |
| F07 | 찬송가 → 슬라이드 자동 생성 | 핵심 |
| F08 | 교독문 → 슬라이드 자동 생성 | 핵심 |
| F09 | 찬양 가사 붙여넣기 → 슬라이드 자동 분할 | 핵심 |
| F10 | **영상 배경 재생 + 영상 위 텍스트** | 핵심 |
| F11 | 발표 화면 (2번째 모니터 전체화면) | 핵심 |
| F12 | 편집 → 발표 실시간 동기화 (WebSocket) | 핵심 |
| F13 | 테마 시스템 (내장 + 커스텀) | 핵심 |
| F14 | **Tool API — 모든 기능을 MCP·CLI로 외부 호출 가능** | 핵심 |
| F15 | **LLM 자동 제작** (주보/지시 → 덱 자동 생성) | 핵심 |
| F16 | 슬라이드 전환 효과 | 부가 |
| F17 | PPT 임포트 → 이미지 슬라이드 | 부가 |
| F18 | 로컬 네트워크 다른 기기 접근 | 부가 |

### 2-2. 비기능 요구사항

- **안정성**: 예배 중 무중단. 로컬 서버, 네트워크 의존 없음
- **오프라인**: 성경/찬송가/교독문 로컬 DB로 완전 동작
- **LLM 모델 독립성**: Claude API / 로컬 vLLM(DGX Spark) 모두 동일 Tool 인터페이스로 구동
- **응답속도**: 슬라이드 전환 < 100ms
- **영상 재생**: 끊김 없는 루프, muted 자동재생

---

## 3. 디렉터리 구조

```
sunday-ppt/
├── package.json
├── core/                          # ★ Core Engine — UI/LLM 공통
│   ├── db/
│   │   ├── index.js               # bun:sqlite 연결
│   │   ├── schema.sql
│   │   └── seed/
│   │       ├── import-bible.js
│   │       ├── import-hymns.js
│   │       └── import-readings.js
│   ├── tools/                     # ★ 모든 기능 = Tool
│   │   ├── registry.js            # Tool 등록/조회/실행 + JSON Schema 익스포트
│   │   ├── service.tools.js       # create_service, duplicate_service ...
│   │   ├── scene.tools.js         # add_scene, export_scene, import_scene ...
│   │   ├── slide.tools.js         # add_slide, update_slide, reorder_slides ...
│   │   ├── content.tools.js       # add_bible_slides, add_hymn_slides ...
│   │   ├── template.tools.js      # list_templates, apply_template, create_template
│   │   ├── media.tools.js         # set_slide_background, import_pptx, upload_media
│   │   ├── theme.tools.js         # list_themes, set_service_theme ...
│   │   ├── search.tools.js        # search_bible, get_hymn ... (LLM 그라운딩용 read tools)
│   │   └── present.tools.js       # present_goto, present_blackout
│   ├── splitter.js                # 긴 내용 → 슬라이드 페이지 분할
│   └── templates/                 # 내장 템플릿 정의 (JSON)
├── adapters/                      # ★ 레지스트리에서 자동 생성되는 어댑터들
│   ├── mcp.js                     # ★ MCP 서버 (1차) — stdio + HTTP/SSE 전송
│   ├── cli.js                     # ★ CLI (1차) — 모든 tool을 셸 명령으로 노출
│   ├── http.js                    # HTTP (얇음) — UI 전용, POST /api/tools/:name
│   └── ws.js                      # WebSocket (발표 동기화)
├── server/
│   └── index.js                   # 진입점: adapters 조립 + 정적 파일 서빙
├── client/
│   ├── editor/                    # 편집 UI (Tool을 HTTP로 호출)
│   ├── presenter/                 # 발표 UI
│   ├── settings/                  # 테마/템플릿 편집 UI
│   ├── assistant/                 # (옵션, 후순위) 인앱 채팅 — MCP/레지스트리 위에 구축
│   └── shared/
│       ├── slide-renderer.js      # 렌더링 공통 (편집/발표 동일)
│       ├── layer-renderer.js      # ★ background(영상 등) + content 레이어 합성
│       ├── transitions.js
│       └── styles/
├── data/
│   ├── source/                    # 원본 JSON (bible/hymns/readings)
│   ├── worship.db
│   └── uploads/                   # 영상/이미지/PPT변환 미디어
└── themes/                        # 내장 테마 JSON
```

---

## 4. 데이터 모델 (SQLite)

```sql
-- ===== 콘텐츠 DB (성경/찬송가/교독문) =====
-- (v1과 동일: bible_books, bible_aliases, bible_verses, bible_fts,
--  hymns, hymn_verses, hymns_fts, responsive_readings, reading_segments)
-- 원본 JSON 구조 그대로 매핑. 성경은 v1(int) 절번호 사용, 교독문 role=leader|congregation|unison.

-- ===== Service > Slide 평면 계층 (v3: Scene 제거) =====
CREATE TABLE services (
  id           TEXT PRIMARY KEY,       -- ulid
  title        TEXT NOT NULL,
  date         TEXT NOT NULL,
  worship_part TEXT NOT NULL,          -- "1부" | "2부" | "연합"
  theme_id     TEXT NOT NULL DEFAULT 'dark-blue',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE slides (
  id            TEXT PRIMARY KEY,      -- ulid
  service_id    TEXT NOT NULL,         -- ★ 이제 service에 직접 속함 (Scene 없음)
  position      INTEGER NOT NULL,      -- 예배 순서 내 슬라이드 순번 (연속)
  template_type TEXT NOT NULL,
  data          TEXT NOT NULL,         -- JSON (타입별 스키마)
  background    TEXT,                  -- JSON: 레이어 배경 (null=테마 기본)
  overlays      TEXT,                  -- JSON: 추가 텍스트/이미지 레이어 배열
  transition    TEXT DEFAULT 'fade',
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);
CREATE INDEX idx_slides_service ON slides(service_id, position);

-- (v3: scenes / scene_library 테이블 폐기. 공유는 Service export/import로.)

-- ===== Template =====
CREATE TABLE templates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,          -- LLM이 읽는 설명
  kind         TEXT NOT NULL,          -- "builtin" | "custom"
  produces     TEXT NOT NULL,          -- "slides" | "scene"
  params_schema TEXT NOT NULL,         -- JSON Schema (입력 파라미터)
  spec         TEXT NOT NULL           -- 생성 로직: builtin 핸들러 ref 또는 declarative blueprint
);

-- ===== Custom Theme =====
CREATE TABLE custom_themes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_theme TEXT NOT NULL,
  overrides  TEXT NOT NULL             -- JSON
);
```

---

## 5. 레이어 모델 (영상 / 영상 위 텍스트)

모든 슬라이드는 **3겹 레이어**로 합성된다.

```
┌─────────────────────────────────┐
│  overlays (옵션)                 │  ← 추가 텍스트/이미지/로고 (자유 위치)
│  ┌───────────────────────────┐  │
│  │  content                  │  │  ← template_type별 본문 (가사/본문/광고)
│  │  ┌─────────────────────┐  │  │
│  │  │  background          │  │  │  ← 색 / 이미지 / 영상 / 그라데이션
│  │  └─────────────────────┘  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### 5-1. background 스키마

```js
// 색
{ "type": "color", "value": "#1a1a2e" }
// 이미지
{ "type": "image", "url": "/uploads/bg1.jpg", "fit": "cover" }
// ★ 영상 (영상 위에 content 텍스트가 자동으로 올라감)
{ "type": "video", "url": "/uploads/worship-bg.mp4",
  "fit": "cover", "loop": true, "muted": true, "playback_rate": 1.0,
  "overlay_dim": 0.35 }   // 텍스트 가독성을 위한 어둡게 처리(0~1)
// 그라데이션
{ "type": "gradient", "from": "#1a1a2e", "to": "#16213e", "angle": 135 }
```

- `background`가 `null`이면 테마 기본 배경 사용
- 영상 background는 자동재생(muted+loop) → 발표 화면에서 끊김 없이 반복
- `overlay_dim`으로 영상 위 가사 가독성 확보 (검은 반투명 레이어)

### 5-2. overlays(자유 요소) 스키마 — v3에서 일반화

overlays 레이어는 **자유 요소(text box / shape / image)** 다. 편집기에서 드래그·크기조절·서식
편집(구글 슬라이드식)을 한다. 좌표 `x,y,w,h`는 0~1 상대(해상도 독립). text `size`는 cqw.

```js
[
  { "type":"text",  "x":0.3,"y":0.8,"w":0.4,"h":0.1,
    "text":"주일 예배", "size":4, "color":"#ffffff", "align":"center", "weight":700 },
  { "type":"shape", "x":0.06,"y":0.08,"w":0.2,"h":0.12,
    "shape":"rect", "fill":"#7aa2f7", "stroke":"#fff", "stroke_width":0, "radius":8 },
  // shape: "rect" | "ellipse" | "line"  (ellipse=원, line=가는 막대)
  { "type":"image", "x":0.85,"y":0.85,"w":0.1,"h":0.1, "url":"/uploads/logo.png" }
]
```

### 5-3. 콘텐츠 스타일(가사·본문) — 슬라이드별

구조화 콘텐츠(가사/본문 등)의 폰트 크기·색·정렬을 슬라이드별로 조절: `slide.data.style = { scale?, color?, align? }`.
렌더러가 테마 크기에 `scale`을 곱하고(`--content-scale`) 색/정렬을 override. 도구는 `update_slide`(data) 재사용.

### 5-3. 순수 영상 슬라이드

글자 없는 영상(예: 광고 영상, 헌금 영상)은 `template_type: "media"` + `background.type: "video"` + content 없음.

---

## 6. 슬라이드 타입 및 data 스키마

| type | 설명 | DB 연동 | 분할 |
|------|------|---------|------|
| `title` | 예배 타이틀 | - | - |
| `section` | 순서 구분자 | - | - |
| `hymn` | 찬송가 | ○ | ○ |
| `praise` | 찬양팀 찬양(자유입력) | - | ○ |
| `bible` | 성경 본문 | ○ | ○ |
| `responsive_reading` | 교독문 | ○ | ○ |
| `announcement` | 광고 | - | - |
| `offering` | 헌금 | - | - |
| `prayer` | 기도제목 | - | - |
| `media` | 이미지/영상 | - | - |
| `blank` | 빈 화면 | - | - |

(각 data 스키마는 v1과 동일 + 모든 타입이 background/overlays 레이어를 가질 수 있음)

```js
// "praise" — 영상 배경 위 가사 예시
{
  "template_type": "praise",
  "data": {
    "title": "주의 이름 높이어",
    "sections": [
      { "label": "1절", "lines": ["주의 이름 높이어", "온 열방이 경배해"] },
      { "label": "후렴", "lines": ["할렐루야", "할렐루야"] }
    ],
    "lines_per_slide": 2
  },
  "background": {
    "type": "video", "url": "/uploads/worship-bg.mp4",
    "loop": true, "muted": true, "overlay_dim": 0.4
  },
  "transition": "fade"
}

// "media" — 순수 영상 슬라이드
{
  "template_type": "media",
  "data": { "caption": "" },
  "background": { "type": "video", "url": "/uploads/offering.mp4", "loop": false, "muted": false }
}
```

---

## 7. 템플릿 시스템

> **v3 통합 템플릿 (구현됨)**: **슬라이드 종류 = 템플릿.** 하나의 템플릿 목록에 두 종류가 공존:
> - **builtin (기본 슬라이드 종류, 시드)**: title/section/bible/hymn/reading/praise/announcement/blank.
>   `spec={tool}`(생성형 — 콘텐츠 도구 재사용) 또는 `spec={template_type}`(정적) + **편집 가능한 디자인 래퍼**
>   `spec.design={background,style,overlays}`. params_schema는 생성형이면 콘텐츠 도구 input_schema에서 파생.
>   **수정 = 디자인만**(내용은 추가 시 params로 입력). 삭제 불가·초기화 가능. (`core/templates/builtins.js` 멱등 시드)
> - **custom (디자인 템플릿)**: 한 슬라이드 디자인(`template_type,data,background,overlays`)을 `save_template`로 저장.
>
> 공통: `apply_template(template_id, service_id, params?)` 로 슬라이드 추가(생성형은 콘텐츠 생성 후 디자인 래퍼 적용,
> 정적은 params→data+디자인, custom은 그대로). `update_template`(builtin=디자인만/custom=전체, reset 지원).
> 도구: list/get/save/apply/update/delete_template (§8). produces="slides". 편집기 "추가" 탭=템플릿 선택+params,
> "템플릿" 탭=관리. **콘텐츠 도구(add_*_slides)는 1차 LLM/CLI API로 유지**(apply_template이 재사용).

템플릿 = **파라미터를 받아 슬라이드(또는 씬)를 생성하는 도구**.

### 7-1. 두 종류

**(A) Builtin 템플릿** — 핸들러 코드로 동작 (DB/분할 로직 사용)
```js
// core/templates/bible-passage.json
{
  "id": "bible-passage",
  "name": "성경 본문",
  "description": "성경 책·장·절을 받아 본문 슬라이드들을 생성한다",
  "kind": "builtin",
  "produces": "slides",
  "params_schema": {
    "type": "object",
    "properties": {
      "book": { "type": "string", "description": "책 이름 또는 약칭 (예: 요한복음, 요)" },
      "chapter": { "type": "integer" },
      "verse_start": { "type": "integer" },
      "verse_end": { "type": "integer" },
      "layout": { "type": "string", "enum": ["auto","one-per-verse","all-in-one"], "default": "auto" }
    },
    "required": ["book","chapter","verse_start","verse_end"]
  },
  "spec": { "handler": "builtin:bible" }
}
```

**(B) Custom 템플릿** — 선언적 blueprint (변수 치환)
```js
// 사용자가 만든 "환영 인사" 템플릿
{
  "id": "custom-welcome",
  "name": "환영 인사",
  "description": "예배 시작 환영 슬라이드를 생성",
  "kind": "custom",
  "produces": "slides",
  "params_schema": {
    "type": "object",
    "properties": {
      "date_text": { "type": "string" },
      "preacher": { "type": "string" }
    },
    "required": ["date_text"]
  },
  "spec": {
    "blueprint": [
      { "template_type": "title",
        "data": { "title": "{{date_text}} 주일 예배", "subtitle": "환영합니다" },
        "background": { "type": "video", "url": "/uploads/welcome.mp4", "loop": true, "muted": true } },
      { "template_type": "section", "data": { "label": "예배로 부름" } }
    ]
  }
}
```

### 7-2. 내장 템플릿 목록

| ID | 생성물 | 파라미터 |
|----|--------|---------|
| `bible-passage` | 성경 본문 슬라이드들 | book, chapter, verse_start, verse_end, layout |
| `hymn` | 찬송가 슬라이드들 | number, verse_nos, lines_per_slide |
| `responsive-reading` | 교독문 슬라이드들 | number |
| `praise-lyrics` | 찬양 슬라이드들 | title, **sections**(구조화), lines_per_slide |
| `announcement` | 광고 슬라이드 | items |
| `welcome` | 타이틀+구분 씬 | date_text, part |
| `full-service` | **예배 전체 씬 골격** | date, part, order(순서배열) |

`full-service`가 핵심: 예배 순서 배열을 받아 빈 씬 골격 전체를 한 번에 생성 → LLM이 주보를 읽고 이걸 호출.

---

## 8. ★ Tool Registry — 전체 도구 목록

모든 Tool은 `{ name, description, input_schema(JSON Schema), handler }` 구조.
이 목록이 그대로 (1) HTTP 엔드포인트, (2) LLM function 정의, (3) MCP tool 로 노출된다.

### 8-1. 읽기 도구 (LLM 그라운딩)

```
list_services()                                  → 예배 순서 목록
get_service(service_id)                           → 예배 + 슬라이드(평면, 순서대로)
export_service(service_id)                        → 공유용 JSON (worship-service/v2)
list_bible_books()                                → 성경 책 목록
get_bible_passage(book, chapter, v_start, v_end)  → 본문 절 배열
search_bible(query, limit)                        → 전문 검색
get_hymn(number)                                  → 찬송가 절/가사
search_hymn(query, limit)                         → 찬송가 검색
get_reading(number)                               → 교독문 segment 배열
search_reading(query, limit)                      → 교독문 검색
list_templates()                                  → 템플릿 + params_schema
list_themes()                                     → 테마 목록
get_presentation_state()                          → 현재 발표 위치/상태
```

### 8-2. 쓰기 도구 (제작)

```
# Service (예배 순서 전체 — 공유 단위)
create_service(title, date, worship_part, theme_id?)      → service_id
update_service(service_id, fields)                        # fields: title/date/worship_part/theme_id/transition
duplicate_service(service_id, title?)                     → new_service_id
delete_service(service_id)
set_service_theme(service_id, theme_id?, overrides?)      # overrides={background?,accent?}, null이면 초기화
set_service_transition(service_id, transition)            # none | fade | slide
export_service(service_id)                                → worship-service/v2 JSON
import_service(payload, title?)                           → service_id

# Slide (v4 — service 직속, 평면 순서, 슬라이드=요소 캔버스)
add_slide(service_id, elements?, background?, transition?, position?)  → slide_id
update_slide(slide_id, fields)                       # fields: elements/background/transition
set_slide_elements(slide_id, elements)               # 요소 배열 전체 설정
set_slide_background(slide_id, background)
remove_slide(slide_id)
reorder_slides(service_id, ordered_slide_ids)

# 콘텐츠 생성 (고가치 — LLM이 주로 사용)
add_bible_slides(service_id, book, chapter, verse_start, verse_end, layout?)  → slide_ids
add_hymn_slides(service_id, number, verse_nos?, lines_per_slide?)             → slide_ids
add_reading_slides(service_id, number)                                       → slide_ids
add_praise_slides(service_id, title, sections, lines_per_slide?)             → slide_ids
   # ★ sections = [{ label, lines:[...] }]  — 구조화된 입력만 받음.
   #   지저분한 가사 텍스트 해석은 외부 LLM이 담당 → 내부 파서 없음.
add_announcement_slide(service_id, items)                                    → slide_id

# 템플릿 (v3 통합 — 기본 슬라이드 종류 + 커스텀 디자인)
list_templates()                                          → 템플릿 목록(기본 먼저) + params_schema
get_template(template_id)                                 → 템플릿 + params_schema + spec
save_template(name, slide, description?)                  → template_id (커스텀 디자인)
apply_template(template_id, service_id, params?, position?) → slide_ids (params=책·장·절/제목 등)
update_template(template_id, {name?, slide?, reset?})     → ok (builtin=디자인만/custom=전체)
delete_template(template_id)                              → ok (커스텀만; 기본 종류는 거부)

# 미디어 / 임포트
upload_media(filename, data_base64)                       → { url, filename }
set_video_background(slide_id, url, options?)             → ok
import_pdf(service_id, path)                              → slide_ids (PPT/PDF/이미지 → 이미지 슬라이드)
# 브라우저 업로드=POST /api/upload, 슬라이드 임포트=POST /api/import(멀티파트). .pptx는 LibreOffice(soffice)로 자동 변환.

# PPT 라이브러리 (폴더 검색·가져오기)
get_library_dir()                                         → { library_dir, indexed }
set_library_dir(path)                                     → ok (서버 폴더 절대경로)
index_library(refresh?)                                   → { files, added, updated, removed, skipped }
search_library(query, limit?)                             → { results:[{path,name,relpath,ext,pages,matched_in,snippet}] }
# 검색 결과 가져오기는 import_pdf(service_id, result.path) 재사용.

# 발표 제어
present_goto(page_index)
present_blackout(on)
present_reload()
```

### 8-3. Tool 정의 예시 (실제 형태)

```js
// core/tools/content.tools.js
registry.register({
  name: "add_bible_slides",
  description: "지정한 성경 본문(책/장/절 범위)을 현재 예배 순서에 본문 슬라이드로 추가한다. 절 수에 따라 자동 분할된다.",
  input_schema: {
    type: "object",
    properties: {
      service_id:  { type: "string", description: "대상 예배(Service) ID" },
      book:        { type: "string", description: "책 이름 또는 약칭 (예: 요한복음, 요)" },
      chapter:     { type: "integer" },
      verse_start: { type: "integer" },
      verse_end:   { type: "integer" },
      layout:      { type: "string", enum: ["auto","one-per-verse","all-in-one"], default: "auto" }
    },
    required: ["service_id","book","chapter","verse_start","verse_end"]
  },
  handler: async (db, args) => {
    const bookOrder = resolveBook(db, args.book);          // 별칭 매핑
    const verses = queryVerses(db, bookOrder, args.chapter, args.verse_start, args.verse_end);
    const pages  = splitBible(verses, args.layout);        // 분할
    return insertSlides(db, args.service_id, "bible", pages);
  }
});
```

MCP·CLI·HTTP 어댑터가 모두 이 동일한 registry를 소비한다 → 기능 중복 없음, Tool 하나 추가 = 세 곳 동시 노출.

---

## 9. LLM 자동 제작 (F15) — 핵심 워크플로우

### 9-1. 주보 PDF → 완성 덱 (원래 풀고 싶던 그 문제)

```
1. 사용자: 주보 PDF 업로드 + "1부 예배 PPT 만들어줘"
2. LLM: PDF에서 예배 순서 추출
        (예배로 부름 / 찬송 1장 / 교독문 1편 / 성경 요3:16-18 / 설교 / 광고 ...)
3. LLM Tool 호출 시퀀스:
     create_service("2025-06-29 1부 예배", "2025-06-29", "1부")
     add_scene(svc, "예배로 부름")        → scene1
       apply_template("welcome", scene1, { date_text:"6월 29일", part:"1부" })
     add_scene(svc, "찬송")               → scene2
       add_hymn_slides(scene2, 1)
     add_scene(svc, "교독문")             → scene3
       add_reading_slides(scene3, 1)
     add_scene(svc, "말씀")               → scene4
       add_bible_slides(scene4, "요한복음", 3, 16, 18)
     add_scene(svc, "광고")               → scene5
       add_announcement_slide(scene5, [...])
4. LLM: "초안 완성했습니다. 검토해 주세요" → 사용자가 편집 UI에서 미세 조정
```

→ 매주 1시간 작업이 **검토 + 미세조정 몇 분**으로 단축.

### 9-2. 부분 자동화 예시

- "찬양팀 가사 줄게, 영상 배경 깔아서 찬양 씬 만들어줘"
  → LLM이 **지저분한 가사를 sections로 구조화** → `add_scene` → `add_praise_slides(sections)` → `set_video_background`(각 슬라이드)
  → (찬양 가사 파싱이 LLM 책임으로 빠지는 지점. 내부 파서 불필요)
- "지난주 광고 씬 불러와서 날짜만 이번 주로 바꿔줘"
  → `add_scene_from_library` → `update_slide`
- "이번 본문 너무 길면 절당 한 장씩으로 다시 나눠줘"
  → `update_slide`(layout 변경) 또는 재생성

### 9-3. 구동 방식 — MCP / CLI (외부 호출)

LLM은 앱 내부에 갇히지 않는다. **외부에서 MCP 또는 CLI로 레지스트리를 구동**한다.

**(A) MCP 경로** — Claude Desktop / AXIS / 로컬 vLLM 에이전트가 MCP 서버에 연결
```js
// adapters/mcp.js — 레지스트리를 MCP tool로 자동 등록
import { McpServer } from "@modelcontextprotocol/sdk";
const server = new McpServer({ name: "sunday-worship", version: "1.0" });

for (const tool of registry.list()) {
  server.tool(tool.name, tool.description, tool.input_schema,
    async (input) => registry.execute(tool.name, input));   // ★ UI와 같은 경로
}
// 전송: stdio (Claude Desktop) + HTTP/SSE (네트워크상 AXIS)
server.listen({ stdio: true, http: { port: 3100 } });
```
→ 외부 Claude에게 "주보 PDF 줄게, 1부 예배 만들어줘" 하면 MCP tool들을 호출해 덱 완성.

**(B) CLI 경로** — 셸 / cron / 스크립트 자동화
```bash
# 레지스트리에서 자동 생성되는 범용 명령
worship tools                          # 전체 tool 목록
worship schema add_bible_slides        # 입력 스키마 출력
worship call add_bible_slides --json '{"service_id":"S1","book":"요한복음","chapter":3,"verse_start":16,"verse_end":18}'

# 파이프라인 자동화 예 (매주 토요일 cron)
SVC=$(worship call create_service --json '{"title":"6월29일 1부","date":"2025-06-29","worship_part":"1부"}' | jq -r .service_id)
worship call add_hymn_slides --json "{\"service_id\":\"$SVC\",\"number\":1}"
```
→ MCP 없이도 셸에서 모든 기능 호출 가능. 테스트·디버깅·무인 자동화에 사용.

**(C) 모델 독립성** — MCP/CLI 어느 쪽이든 핸들러는 동일 registry.execute.
Claude API든 DGX Spark 로컬 vLLM이든, 모델 쪽이 tool 스키마만 받으면 구동된다.
앱은 모델을 알 필요가 없다.

---

## 10. 씬 공유 포맷 (JSON)

```js
// worship-scene/v1
{
  "format": "worship-scene/v1",
  "name": "1부 찬양",
  "theme_hint": "dark-blue",
  "slides": [
    {
      "template_type": "praise",
      "data": { "title": "주의 이름 높이어", "sections": [ ... ] },
      "background": { "type": "video", "url": "asset://worship-bg.mp4", "loop": true, "muted": true },
      "transition": "fade"
    }
  ],
  "assets": [
    { "ref": "asset://worship-bg.mp4", "sha256": "...", "note": "영상 배경" }
  ]
}
```

- `asset://` 참조로 미디어 분리 → 씬 JSON은 가볍게, 미디어는 별도 번들
- import 시 asset 없으면 경고 후 배경 제거 또는 사용자에게 업로드 요청
- LLM도 이 포맷을 읽고/쓸 수 있음 (export_scene / import_scene tool)

---

## 11. 화면 설계

(편집/발표/설정 화면은 v1과 동일 구조 + 아래 추가)

### 11-1. Assistant 패널 (신규)

편집 화면에 **채팅 패널** 추가. 사용자가 자연어로 지시 → LLM이 Tool 실행 → 슬라이드 목록 실시간 갱신.

```
┌─────────────────────────────────────────────────────────────┐
│ 편집 화면                                    [💬 어시스턴트]  │
├──────────┬────────────────────────┬──────────────┬──────────┤
│ 씬/슬라  │   캔버스 미리보기        │ 추가/편집     │ 💬 채팅   │
│ 이드 목록 │   (레이어 합성 렌더)     │ 패널         │          │
│          │                        │              │ "요3:16  │
│ ▸ 예배로 │                        │              │  추가해"  │
│   부름   │                        │              │   ↓      │
│ ▸ 찬양   │                        │              │ [Tool실행]│
│ ▸ 말씀   │                        │              │ ✓ 3슬라  │
│ ▸ 광고   │                        │              │  이드 추가│
└──────────┴────────────────────────┴──────────────┴──────────┘
```

### 11-2. 영상 배경 편집 UI

슬라이드 Inspector에 "배경" 섹션:
```
배경: ( ) 테마기본 ( ) 색 ( ) 이미지 (•) 영상
영상: [worship-bg.mp4 선택] [업로드]
□ 반복재생  □ 음소거(권장)  어둡게: [====|----] 0.4
```

---

## 12. 렌더링 — 레이어 합성

```js
// shared/layer-renderer.js
function renderSlideWithLayers(container, slide, theme) {
  container.innerHTML = '';

  // 1. background 레이어
  const bg = slide.background ?? themeBackground(theme, slide.template_type);
  renderBackground(container, bg);   // color/image/video/gradient
  if (bg.type === 'video') {
    // <video autoplay muted loop playsinline> + dim 오버레이
  }

  // 2. content 레이어 (기존 slide-renderer)
  const content = document.createElement('div');
  content.className = 'layer-content';
  renderSlide(content, slide, theme);   // v1 렌더러 재사용
  container.appendChild(content);

  // 3. overlays 레이어
  (slide.overlays ?? []).forEach(o => renderOverlay(container, o));
}
```

발표/편집 미리보기 모두 이 함수 사용 → 영상 배경도 편집 시 그대로 보임.

---

## 13. 어댑터 매핑 — 레지스트리 → MCP / CLI / HTTP 자동 생성

세 어댑터 모두 `registry.list()`를 순회하며 자동 생성된다. 수기 라우팅 없음.

```
MCP   : registry tool → MCP tool (stdio + HTTP/SSE)     ← 1차, 외부 에이전트
CLI   : registry tool → `worship call <name> --json`     ← 1차, 셸/cron 자동화
HTTP  : registry tool → POST /api/tools/:name            ← UI 전용 얇은 래퍼
```

```
# HTTP 예
POST /api/tools/add_bible_slides
     { "service_id":"...", "book":"요한복음", "chapter":3, "verse_start":16, "verse_end":18 }

# CLI 예 (동일 tool)
worship call add_bible_slides --json '{"service_id":"...","book":"요한복음","chapter":3,"verse_start":16,"verse_end":18}'

# MCP 예 (동일 tool) — 외부 Claude/AXIS가 tool_use로 호출
```

읽기 전용 tool은 HTTP GET도 허용. WebSocket은 present_* 결과를 발표 화면에 브로드캐스트.

**핵심 이점: Tool 하나 추가 = MCP·CLI·HTTP 세 곳에 자동 노출.** 어댑터 코드 수정 불필요.
이게 "큰 수정 없이 지속 발전 가능"을 구조적으로 보장한다.

---

## 14. 구현 단계 (권장 순서)

레지스트리·MCP·CLI를 **조기에** 세워서 처음부터 외부 호출·자동화 가능 상태로 개발한다.

| 단계 | 내용 | 완료 기준 |
|------|------|----------|
| 1 | Core: DB 스키마 + JSON 임포트(성경/찬송가/교독문) | 콘텐츠 쿼리 동작 |
| 2 | **Tool Registry 골격** + service/scene/slide tools | registry.execute 동작 |
| 3 | **CLI 어댑터** (worship call/tools/schema 자동생성) | 셸에서 전 tool 호출 |
| 4 | **MCP 어댑터** (stdio + HTTP/SSE) | 외부 Claude가 tool 구동 |
| 5 | content tools (bible/hymn/reading) + splitter | 콘텐츠 슬라이드 생성 |
| 6 | add_praise_slides (구조화 sections 입력) | 가사 구조화 입력→슬라이드 |
| 7 | 레이어 렌더러 (color/image/gradient) | 편집/발표 동일 출력 |
| 8 | HTTP 어댑터 + 편집 UI (씬/슬라이드/Inspector) | 수동 제작 가능 |
| 9 | 발표 화면 + WebSocket + present tools | 듀얼 모니터 동작 |
| 10 | **영상 배경 + 영상 위 텍스트** | 영상 위 가사 발표 |
| 11 | 템플릿 시스템 (builtin + apply_template) | 템플릿으로 생성 |
| 12 | **주보 PDF → 덱 자동제작** (외부 LLM via MCP) | 1부 예배 자동 초안 |
| 13 | 씬 export/import + Scene Library | 씬 저장/공유 |
| 14 | 커스텀 템플릿 + 테마 편집(Settings) | 사용자 정의 |
| 15 | 전환 효과 / PPT 임포트 / (옵션)인앱 Assistant | 부가 기능 |

→ 1~4단계가 끝나면 **UI가 없어도 외부 LLM·CLI로 예배 덱을 만들 수 있는** 상태가 된다.
   이 시점부터 자동화 실험을 바로 시작할 수 있다.

---

## 15. 핵심 기술 결정사항 요약

| 항목 | 결정 | 이유 |
|------|------|------|
| 아키텍처 | **Tool-First / Headless-First** (Registry가 본체) | "모든 기능 외부 호출 가능" 보장 |
| 1차 인터페이스 | **MCP + CLI** (HTTP는 UI용 얇은 래퍼) | 외부 호출·자동화·지속 발전 |
| 어댑터 생성 | 레지스트리에서 MCP/CLI/HTTP **자동 생성** | Tool 추가 = 3곳 동시 노출 |
| 계층 | **Service > Slide (평면)** | 한 예배=하나의 연속 순서, Service가 공유 단위 (v3: Scene 제거) |
| 템플릿 | builtin(핸들러) + custom(blueprint) | 빠른 생성 + 사용자 확장 |
| 영상 | background 레이어에 video 타입 | 모든 슬라이드에 영상+텍스트 |
| 레이어 | background / content / overlays 3겹 | 영상 위 텍스트 자연 해결 |
| 찬양 가사 | **내부 파서 없음.** 구조화는 외부 LLM | 변수 과다 → 휴리스틱 불가 |
| LLM 연결 | tool 스키마 자동 노출 (MCP/CLI) | Claude/로컬 vLLM 모델 독립 |
| 순서 공유 | **worship-service/v2 JSON** (export/import_service) | 한 예배 순서 전체를 파일로 공유 |
| 편집 뷰 | 리스트 + 타일(썸네일) 토글 | 순서 개요를 라이트테이블처럼 |
| 서버/DB | Bun + bun:sqlite | 오프라인, 단일 파일 |
| 클라이언트 | 순수 HTML/JS | 빌드 없음 |
