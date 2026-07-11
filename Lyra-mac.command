#!/bin/bash
# Lyra 실행 (macOS) — 이 파일을 더블클릭하면 서버를 켜고 브라우저를 엽니다.
# (최초 1회만 인터넷이 필요합니다: Bun 런타임 + 의존성 설치)
cd "$(dirname "$0")" || exit 1

pause_exit() { echo ""; echo "종료하려면 Enter 를 누르세요."; read -r _; exit "${1:-0}"; }

# ── Bun 준비 (없으면 설치) ─────────────────────────
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "Bun 런타임을 설치합니다 (최초 1회)…"
  curl -fsSL https://bun.sh/install | bash || { echo "❌ Bun 설치 실패 — 인터넷 연결을 확인하세요."; pause_exit 1; }
  export PATH="$HOME/.bun/bin:$PATH"
fi

# ── 의존성 (없을 때만) ─────────────────────────────
if [ ! -d node_modules ]; then
  echo "의존성 설치 중…"
  bun install || { echo "❌ 의존성 설치 실패"; pause_exit 1; }
fi

# ── (선택) 콘텐츠 JSON이 있고 DB가 없으면 시드 ──────
if [ ! -f data/worship.db ] && [ -f data/source/bible.json ]; then
  echo "성경·찬송·교독문 콘텐츠를 DB로 시드합니다…"
  bun run seed || echo "⚠️  시드 실패(콘텐츠 없이 계속 진행)"
fi

echo ""
echo "▶ Lyra 실행 중…  브라우저가 자동으로 열립니다."
echo "   (이 창을 닫으면 Lyra가 종료됩니다.)"
echo ""
LYRA_OPEN=1 bun run server/index.js
pause_exit
