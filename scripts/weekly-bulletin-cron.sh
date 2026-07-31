#!/bin/zsh
# 매주 토요일 launchd가 부르는 진입점 — 주보를 받아 그 주 예배 순서를 만든다.
# 수동 실행: zsh scripts/weekly-bulletin-cron.sh
set -uo pipefail

export PATH="/Users/jisubpark/.local/bin:/Users/jisubpark/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ROOT="/Users/jisubpark/code/lyra"
LOG_DIR="$ROOT/data/bulletins"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cron.log"

cd "$ROOT" || exit 1
echo "\n===== $(date '+%Y-%m-%d %H:%M:%S') 주보 자동 실행 =====" >>"$LOG"

# 편집기 undo가 예배를 통째로 덮어쓸 수 있어(set_service_slides) 열려 있으면 경고만 남긴다.
if lsof -nP -iTCP:4321 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "[알림] Lyra 서버가 떠 있습니다. 편집기 탭이 열려 있다면 작업 중 실행취소를 누르지 마세요." >>"$LOG"
fi

claude -p "weekly-bulletin 스킬을 사용해 이번 주 주보로 주일오전예배 순서를 만들어줘. 이미 그 날짜 예배가 있으면 새로 만들지 말고 그렇게 보고해줘." \
  --allowedTools Bash Read Write Edit Glob Grep Skill \
  --add-dir "$ROOT" \
  >>"$LOG" 2>&1
STATUS=$?

if [ $STATUS -eq 0 ]; then
  MSG="이번 주 예배 순서 초안이 준비됐습니다. 찬양대 가사·새가족·설교 인용 성구는 확인이 필요합니다."
  TITLE="Lyra 주보 자동 생성 완료"
else
  MSG="실패했습니다 (종료코드 $STATUS). data/bulletins/cron.log 를 확인하세요."
  TITLE="Lyra 주보 자동 생성 실패"
fi
echo "[$(date '+%H:%M:%S')] $TITLE — $MSG" >>"$LOG"
osascript -e "display notification \"$MSG\" with title \"$TITLE\"" >/dev/null 2>&1

exit $STATUS
