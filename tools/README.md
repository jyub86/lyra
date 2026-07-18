# tools/ — 외부 바이너리 드롭인 (선택)

가져오기 관련 외부 도구(**poppler**, **cwebp**)를 PATH 편집 없이 쓰고 싶을 때,
압축 푼 폴더를 **이 `tools/` 폴더 안에** 그대로 넣으면 앱이 자동으로 찾습니다.
(앱은 `tools/*`, `tools/*/bin`, `tools/*/Library/bin` 을 탐색합니다.)

## poppler (Windows에서 특히 유용)

1. prebuilt 다운로드: <https://github.com/oschwartz10612/poppler-windows/releases>
   (`Release-xx.xx.x-0.zip` 자산)
2. 압축을 풀어 폴더째로 이 `tools/` 안에 넣습니다. 예:
   ```
   tools/poppler-24.08.0/Library/bin/pdftoppm.exe
   tools/poppler-24.08.0/Library/bin/pdftotext.exe
   ```
3. 끝. Lyra가 `tools/*/Library/bin`(또는 `tools/*/bin`)에서 자동 탐지합니다. PATH 등록 불필요.

> 대안: 환경변수 `LYRA_POPPLER` 에 poppler의 `bin` 폴더 경로를 지정해도 됩니다.
> macOS/Linux는 보통 `brew install poppler` / `apt install poppler-utils` 로 PATH에 들어가므로 이 폴더가 필요 없습니다.

## cwebp (WebP 변환 — 선택)

가져온 PPT/PDF 페이지 이미지를 **WebP로 저장**해 용량을 7~12배 줄입니다(없으면 PNG로 저장 — 정상 동작).

1. prebuilt 다운로드: <https://developers.google.com/speed/webp/download> (libwebp의 Windows/macOS/Linux zip)
2. 압축을 풀어 폴더째 이 `tools/` 안에 넣습니다. 예:
   ```
   tools/libwebp-1.4.0-windows-x64/bin/cwebp.exe
   ```
3. 끝. Lyra가 `tools/*/bin`(또는 `tools/*`)에서 자동 탐지합니다.

> 대안: 환경변수 `LYRA_CWEBP` 에 `cwebp`(.exe)가 있는 폴더 경로를 지정.
> macOS/Linux는 보통 `brew install webp` / `apt install webp` 로 PATH에 들어갑니다.

## LibreOffice

`.pptx/.ppt/.odp` 가져오기에 필요합니다. **설치 파일로 설치하면 앱이 기본 경로를 자동 탐지**하므로
이 폴더에 넣을 필요가 없습니다. (Windows: <https://www.libreoffice.org/download> 의 설치 파일)

이 폴더에 넣은 파일은 `.gitignore` 되어 저장소에 올라가지 않습니다.
