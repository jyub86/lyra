#!/usr/bin/env bun
// ★ CLI 어댑터 (1차 인터페이스) — design §9-3(B), §13.
// Auto-generated from the registry: every tool is callable as `worship call <name>`.
// No hand-written per-tool routing.
//
//   worship tools                       # 전체 tool 목록
//   worship schema <name>               # 입력 JSON Schema 출력
//   worship call <name> --json '{...}'  # 실행 (또는 --file f.json / stdin)
//   worship call <name> -- key=value …  # 간단 인자 (문자열/숫자/JSON 자동 파싱)

import { loadTools, list, get, execute } from "../core/tools/registry.js";

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fail(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

// `key=value` pairs → object. Values parsed as JSON when possible, else string.
function parseKvPairs(pairs) {
  const out = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i === -1) fail(`bad arg (expected key=value): ${p}`);
    const key = p.slice(0, i);
    const raw = p.slice(i + 1);
    try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  await loadTools();
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    print({
      usage: [
        "worship tools",
        "worship schema <name>",
        "worship call <name> --json '{...}'",
        "worship call <name> --file args.json",
        "worship call <name> -- key=value …",
      ],
    });
    return;
  }

  if (cmd === "tools") {
    print(list().map((t) => ({ name: t.name, read: t.read, description: t.description })));
    return;
  }

  if (cmd === "schema") {
    const name = rest[0];
    const tool = get(name);
    if (!tool) fail(`unknown tool: ${name}`);
    print({ name: tool.name, description: tool.description, input_schema: tool.input_schema });
    return;
  }

  if (cmd === "call") {
    const name = rest[0];
    if (!get(name)) fail(`unknown tool: ${name}`);
    const args = rest.slice(1);

    let input = {};
    const jsonIdx = args.indexOf("--json");
    const fileIdx = args.indexOf("--file");
    const ddIdx = args.indexOf("--");
    if (jsonIdx !== -1) {
      input = JSON.parse(args[jsonIdx + 1] ?? "{}");
    } else if (fileIdx !== -1) {
      input = JSON.parse(await Bun.file(args[fileIdx + 1]).text());
    } else if (ddIdx !== -1) {
      input = parseKvPairs(args.slice(ddIdx + 1));
    } else {
      const stdin = await readStdin();
      if (stdin) input = JSON.parse(stdin);
    }

    try {
      const result = await execute(name, input);
      print(result);
    } catch (e) {
      fail(e.message, 2);
    }
    return;
  }

  fail(`unknown command: ${cmd}. try 'worship help'`);
}

main();
