# 내장 웹폰트 (self-host)

예배 중 오프라인 동작을 위해 무료 웹폰트를 로컬에 내장한다. `/fonts/`로 서빙되고
`list_fonts` 도구·편집기 글꼴 선택기가 이 매니페스트(`fonts.json`)를 사용한다.

- 재생성/추가: `bun run scripts/build-fonts.js` (스크립트의 `FONTS` 배열 편집 후 재실행)
- 출처: [fontsource](https://fontsource.org/) (jsDelivr) — 패밀리별 korean/latin 결합 woff2

## 라이선스 (모두 재배포 허용)

- **SIL Open Font License 1.1 (OFL)**: Noto Sans KR, Nanum Myeongjo, Nanum Pen Script,
  Gowun Dodum, Song Myung, Black Han Sans, Do Hyeon, Jua, Gaegu, Montserrat,
  Playfair Display, Bebas Neue, Dancing Script
- **Apache License 2.0**: Roboto

각 폰트의 원 저작권·라이선스 전문은 위 출처(fontsource/Google Fonts)의 각 패밀리 페이지를 따른다.
