---
name: weekly-bulletin
description: 교회 홈페이지(Supabase)에 올라온 주보로 이번 주 주일오전예배 순서를 만든다. "주보로 예배 순서 만들어줘", "이번 주 예배 PPT", 토요일 자동 실행 등에 사용.
---

# 주보 → 주일오전예배 순서

매주 금요일 홈페이지에 올라오는 주보(교회소식)를 받아 그 주 예배 덱을 만든다.
**해석(주보 읽기)은 네가 하고, 조립은 스크립트가 결정적으로 한다.** 순서를 바꾸지 말 것.

전제: 이 스킬은 `/Users/jisubpark/code/lyra`에서 실행한다. 실사용 DB·uploads가 거기 있다.
(`~/orca/workspaces/lyra/*` 워크트리에는 빈 DB가 따로 있어서 거기서 돌리면 조용히 아무것도 안 된다.)

## 1. 주보 받기

```bash
cd /Users/jisubpark/code/lyra && bun run scripts/fetch-bulletin.js
```

`data/bulletins/<날짜>/` 에 `bulletin.pdf` · `page-N.png` · `meta.json` 을 펼치고 JSON을 출력한다.

**모든 내용은 PDF(주보)가 기준이다.** `meta.json`의 `content`는 사람이 홈페이지에 따로 적는 것이라
주보와 어긋날 수 있다 — 참고·교차확인용으로만 보고, 어긋나면 **PDF를 따른다.**

이미 만든 주라면 `list_services`에 `<날짜> 주일오전예배`가 있는지 먼저 확인하고, 있으면 중복 생성하지 말고 사용자에게 알린다.

## 2. 주보 읽기

`page-1.png`와 `page-2.png`를 **Read 도구로 직접 본다.** 주보는 2단 조판이라 `pdftotext`로는 순서가
섞인다 — 반드시 눈으로 읽을 것.

`page-1.png` 오른쪽 "주일예배" 칸에서 예배 순서를, `page-2.png` 오른쪽 "교/회/소/식" 칸에서
광고를 뽑는다.

| 주보 항목 | 스펙 필드 |
|---|---|
| *찬 송 (첫 번째) | `hymn1` = { number, title } |
| *교 독 문 | `reading` = { number, title } — "교독문 64번 〈시편 148편〉" → 64 / "시편 148편" |
| 찬 송 (두 번째) | `hymn2` |
| 기 도 | `prayer` = { part1, part2 } — 1부/2부 |
| 헌 금 | `offering` = { part1, part2 } |
| 성 경 봉 독 | `scripture` — 책 약칭·장·절 + `ref_text`("요한복음 6:41-59") + `page_text`("(신약 154쪽)") |
| 찬 양 | `choir` = { part1:{team,song}, part2:{team,song} } |
| 말 씀 | `sermon` = { title, preacher } |

이름은 **주보 표기 그대로** (`1부`/`2부` 접두사는 붙이지 않는다 — Base가 이름만 쓰는 형식이다).

광고는 `page-2.png`의 "교/회/소/식" 번호 항목을 그 순서대로 `announcements`에 담는다.
그 칸의 고정 안내(헌금 계좌, 바른 예배 캠페인)와 별도 구획인 "교/우/동/정"은 Base에 자리가 없으므로
넣지 말고, 필요해 보이면 사용자에게 물어본다.

## 3. 광고 이미지 크롭 (필요할 때만)

광고 항목이 표·그림으로 되어 있으면(예: 교육부서 여름행사 안내) PDF에서 **400 DPI로 잘라** 쓴다.
`meta.json`의 `media_urls` 이미지는 450px 정도라 슬라이드에는 너무 흐리다.

```bash
# 먼저 200dpi로 반쪽만 렌더해 좌표를 눈으로 잡고
pdftoppm -png -r 200 -f 2 -l 2 -x <X> -y 0 -W <W> -H <H> bulletin.pdf right
# 좌표를 2배로 환산해 400dpi로 최종 크롭
pdftoppm -png -r 400 -f 2 -l 2 -x <X*2> -y <Y*2> -W <W*2> -H <H*2> bulletin.pdf table
```

잘라낸 뒤 **Read로 확인**하고 스펙의 해당 광고에 `"image": "<절대경로>"`로 넣는다.

## 4. 스펙 작성 → 빌드

`data/bulletins/<날짜>/spec.json` 으로 저장한 뒤:

```bash
bun run scripts/build-weekly-service.js data/bulletins/<날짜>/spec.json --dry-run   # 먼저 확인
bun run scripts/build-weekly-service.js data/bulletins/<날짜>/spec.json             # 실제 생성
```

스펙 예시는 `scripts/spec.example.json`. `announcements`는 주보 교회소식의 번호 순서를 그대로 따른다.

스크립트가 하는 일: Base 점검·백업 → 복제 → 텍스트 교체 → 광고 재구성 →
찬송 악보(`~/church/ppt/찬양/새찬송가_WIDE/NNN장.pptx`)·교독문·성경본문 새로 생성 → 재정렬.

`--dry-run`이 "Base에서 ... 못 찾음"으로 실패하면 **Base가 훼손된 것**이다. 임의로 고치지 말고
`data/base-backups/`의 최신 백업과 비교해 사용자에게 알린다(아래 주의 참고).

## 5. 보고

만든 예배 id·장수와 함께, 스크립트가 출력한 **"손대지 않음"** 항목을 그대로 전달한다:

- **찬양대 가사** — 곡 제목만 바뀌고 크로마키 가사는 지난주 것 그대로. 매주 수동 입력 필요.
- **새가족 명단** — 주보에 없음.
- **설교 인용 성구** — 지난주 설교 것 그대로.

주보에 있는데 Base에 자리가 없는 항목(예: 교우동정 입원)은 임의로 넣지 말고 **물어본다.**

## 주의 — 편집기 탭을 열어둔 채 돌리지 말 것

편집기의 undo는 `set_service_slides`(해당 예배 전체 DELETE 후 재삽입)를 호출하는데, 클라이언트
메모리의 스냅샷을 서버 현재 상태와 대조하지 않는다(`client/editor/editor.js` `restoreSnapshot`).
즉 **탭을 열어둔 채 이 스킬이 같은 예배를 건드리면**, 그 탭에서 undo를 누를 때 스크립트가 넣은
변경이 통째로 낡은 상태로 되돌아갈 수 있다. 실행 전 편집기 탭을 닫도록 안내할 것.
