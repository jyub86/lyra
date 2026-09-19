// 슬라이드끼리 "같은 역할"의 요소를 짝짓는 키.
// 여기 한 곳에만 둔다 — 서식 복사(copy_slide_style)와 일괄 편집(update_elements)이
// 같은 규칙으로 짝지어야 "복사는 됐는데 일괄 수정은 다른 걸 건드리는" 사고가 없다.
//
//   bind:<name>            가사·제목처럼 템플릿이 채우는 텍스트 (가장 확실한 신호)
//   content:<type>:<field> 성경 본문/참조, 찬송 가사, 교독문 역할별
//   type:<type>:<n>        나머지는 종류별 등장 순서 (도형 1번째, 이미지 1번째 …)
//
// 순서 기반(type:…)은 슬라이드마다 요소를 넣은 순서가 같아야 맞는다. 템플릿으로 만든
// 슬라이드는 순서가 같으므로 잘 맞고, 손으로 제각각 만든 장은 어긋날 수 있다 —
// 그래서 도구가 "몇 장에서 찾았는지"를 항상 돌려준다(짝이 없으면 안 건드린다).
export const CONTENT_TYPES = new Set(["bible", "hymn", "reading"]);

export function matchKeys(els) {
  const seen = {};
  return (els || []).map((e) => {
    if (e.type === "text" && e.bind) return `bind:${e.bind}`;
    if (CONTENT_TYPES.has(e.type)) return `content:${e.type}:${e.field || "all"}`;
    const n = (seen[e.type] = (seen[e.type] || 0) + 1);
    return `type:${e.type}:${n}`;
  });
}

const TYPE_LABEL = {
  text: "텍스트", shape: "도형", image: "이미지", video: "영상",
  bible: "성경", hymn: "찬송", reading: "교독문",
};
const FIELD_LABEL = {
  all: "전체", text: "본문", ref: "장절", lyrics: "가사", title: "제목",
  leader: "인도자", congregation: "회중", unison: "다같이",
};

// 사람이 읽는 이름. UI 목록과 CLI 출력에 같이 쓴다.
export function keyLabel(key) {
  const [kind, a, b] = key.split(":");
  if (kind === "bind") return `${a} (템플릿 칸)`;
  if (kind === "content") return `${TYPE_LABEL[a] || a} ${FIELD_LABEL[b] || b}`;
  return `${TYPE_LABEL[a] || a} ${b}번째`;
}
