// =====================================================
//  question_resource の CSV から problems.js を作る（Node.js・依存なし）
//    node tools/build-problems.js
//  ・入力: question_resource/keisan_dojo_levels.csv（シート情報）, keisan_dojo_questions.csv（問題）
//  ・CSVの答えをそのまま使う。あわせて計算で検算し、食いちがいを表示する（転記ミスの発見用）
// =====================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'question_resource');
const OUT = path.join(ROOT, 'problems.js');

function readCsv(file) {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/^﻿/, '').replace(/\r/g, '').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => { const v = l.split(','); return Object.fromEntries(head.map((k, i) => [k, (v[i] ?? '').trim()])); });
}
const num = (s) => (s === '' || s == null ? null : Number(s));

// モードごとの正解を計算する（検算用）
const tens = (x) => x - (x % 10), ones = (x) => x % 10;
function expected(op, mode, a, b) {
  switch (mode) {
    case 'N':   return { answer: op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b };
    case 'O1':  return { answer: op === '+' ? ones(a) + ones(b) : ones(a - b) };
    case 'T10': return { answer: tens(a % 100) + tens(b % 100) };
    case 'S': case 'S3':
      return op === '+' ? { step1: tens(a) + tens(b), step2: ones(a) + ones(b), answer: a + b }
                        : { step1: a - tens(b), step2: ones(b), answer: a - b };
    case 'K':   return a >= 10 ? { step1: tens(a) * b, step2: ones(a) * b, answer: a * b }
                               : { step1: a * tens(b), step2: a * ones(b), answer: a * b };
    case 'R':   return { answer: Math.floor(a / b), remainder: a % b };
    default:    return {};
  }
}

const levels = readCsv('keisan_dojo_levels.csv');
const questions = readCsv('keisan_dojo_questions.csv');
const warnings = [];

const sheets = levels.map((lv) => {
  const qs = questions.filter((q) => q.level_id === lv.level_id).sort((x, y) => num(x.q_no) - num(y.q_no));
  if (qs.length !== num(lv.question_count)) warnings.push(`${lv.level_id}: 問題数 ${qs.length}（levels.csv は ${lv.question_count}）`);
  const p = qs.map((q) => {
    const a = num(q.a), b = num(q.b), row = [a, b, num(q.answer)];
    if (lv.mode === 'R') row.push(num(q.remainder));
    if (['S', 'S3', 'K'].includes(lv.mode)) row.push(num(q.step1), num(q.step2));
    const exp = expected(q.op, lv.mode, a, b);
    const got = { answer: num(q.answer), remainder: num(q.remainder), step1: num(q.step1), step2: num(q.step2) };
    Object.keys(exp).forEach((k) => {
      if (exp[k] !== got[k]) warnings.push(`${lv.level_id} #${q.q_no} ${q.expr}: ${k} = ${got[k]}（計算では ${exp[k]}）`);
    });
    return row;
  });
  return {
    op: lv.category, level: num(lv.level), no: num(lv.sheet), mode: lv.mode,
    good: num(lv.target_sec), great: num(lv.gold_sec), instruction: lv.instruction, example: lv.example, p,
  };
});

// =====================================================
//  シートの補充：各レベルを X-1〜X-4 の4枚にそろえる
//  足りない番号のシートを、同じレベルの本のシートを見本に1問ずつ作る。
//  見本の問題と「けた数・末尾の0・くり上がり/くり下がりの位置・答えのけた数・わりきれるか」が同じになる数をランダムに選ぶ。
//  乱数はレベルごとに固定（何度作り直しても同じ問題になる）
// =====================================================
const SHEETS_PER_LEVEL = 4;
function rng(seedStr) {                           // mulberry32
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const len = (x) => String(x).length;
const tz = (x) => { if (x === 0) return 0; let n = 0; while (x % 10 === 0) { x /= 10; n++; } return n; };
const digitsR = (x, n) => Array.from({ length: n }, (_, i) => Math.floor(x / 10 ** i) % 10);   // 1の位から
function carries(a, b) { const n = Math.max(len(a), len(b)), A = digitsR(a, n), B = digitsR(b, n); let c = 0; return A.map((d, i) => (c = d + B[i] + c >= 10 ? 1 : 0)).join(''); }
function borrows(a, b) { const n = len(a), A = digitsR(a, n), B = digitsR(b, n); let c = 0; return A.map((d, i) => (c = d - B[i] - c < 0 ? 1 : 0)).join(''); }
function signature(op, a, b) {
  const base = [len(a), len(b), tz(a), tz(b), a === 0, b === 0];
  if (op === '+') return [...base, carries(a, b)].join('|');
  if (op === '-') return [...base, borrows(a, b), len(a - b)].join('|');
  if (op === '*') return [...base, len(a * b)].join('|');
  return [...base, a % b === 0, len(Math.floor(a / b)), tz(Math.floor(a / b))].join('|');
}
// けた数 n・末尾の0が t こ の数（n=1 は 1〜9）
function randNum(R, n, t) {
  if (n === 1) return 1 + Math.floor(R() * 9);
  let s = String(1 + Math.floor(R() * 9));
  for (let i = 1; i < n - t; i++) s += (i === n - t - 1 && t > 0) ? 1 + Math.floor(R() * 9) : Math.floor(R() * 10);
  return Number(s + '0'.repeat(t));
}
function makeLike(R, op, a0, b0, used, inSheet) {
  const sig = signature(op, a0, b0);
  for (let tries = 0; tries < 20000; tries++) {
    let a, b;
    if (op === '/') {                               // わり算は 商とわる数 から作る
      const q0 = Math.floor(a0 / b0), r0 = a0 % b0;
      b = randNum(R, len(b0), tz(b0)); const q = randNum(R, len(q0), tz(q0));
      const r = r0 === 0 ? 0 : 1 + Math.floor(R() * (b - 1));
      if (b === 1 && r0 !== 0) continue;
      a = b * q + r;
    } else {
      a = a0 === 0 ? 0 : randNum(R, len(a0), tz(a0));
      b = b0 === 0 ? 0 : randNum(R, len(b0), tz(b0));
    }
    // かけ算・わり算の「1」は見本が1のときだけ（×1・÷1 だらけにしない）
    if ((op === '*' || op === '/') && ((a === 1 && a0 !== 1) || (b === 1 && b0 !== 1))) continue;
    const key = `${a}${op}${b}`;
    // 前半はレベル全体で重複なし。組み合わせが少ない型（10−8 など）は、後半で「同じシートの中だけ重複なし」にゆるめる
    if (signature(op, a, b) !== sig || inSheet.has(key) || (tries < 5000 && used.has(key))) continue;
    used.add(key); inSheet.add(key); return [a, b];
  }
  throw new Error(`作れなかった: ${a0}${op}${b0}`);
}
function rowFor(mode, op, a, b) {
  const e = expected(op, mode, a, b), row = [a, b, e.answer];
  if (mode === 'R') row.push(e.remainder);
  if (['S', 'S3', 'K'].includes(mode)) row.push(e.step1, e.step2);
  return row;
}
const OPSYM = { tashizan: '+', hikizan: '-', kakezan: '*', warizan: '/' };
const groups = new Map();
sheets.forEach((s) => { const k = `${s.op}:${s.level}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
let added = 0;
for (const [k, list] of groups) {
  const op = OPSYM[list[0].op], used = new Set(list.flatMap((s) => s.p.map((r) => `${r[0]}${op}${r[1]}`)));
  const R = rng(k);
  for (let no = 1; no <= SHEETS_PER_LEVEL; no++) {
    if (list.some((s) => s.no === no)) continue;
    // 番号が近い本のシートを見本にする（ちがう形式が混ざらないよう同じレベル内で）
    const tpl = list.slice().sort((x, y) => Math.abs(x.no - no) - Math.abs(y.no - no) || x.no - y.no)[0];
    const inSheet = new Set();
    const p = tpl.p.map((r) => { const [a, b] = makeLike(R, op, r[0], r[1], used, inSheet); return rowFor(tpl.mode, op, a, b); });
    p.forEach((r) => { const e = expected(op, tpl.mode, r[0], r[1]); if (e.answer !== r[2]) warnings.push(`生成ミス ${k}-${no}: ${r}`); });
    sheets.push({ ...tpl, no, gen: true, p });
    added++;
  }
}
sheets.sort((x, y) => Object.keys(OPSYM).indexOf(x.op) - Object.keys(OPSYM).indexOf(y.op) || x.level - y.level || x.no - y.no);

const fmtSheet = (s) => `SHEETS.push(${JSON.stringify({ ...s, p: undefined }).replace(/}$/, '')},\n  "p":[${s.p.map((r) => JSON.stringify(r)).join(',')}]});`;
const out = `// =====================================================
//  計算道場 教材データ ★自動生成ファイル（手で直さない）
//  元データ: question_resource/keisan_dojo_*.csv → node tools/build-problems.js で作り直す
//
//  mode: N=ふつう / O1=1のくらいだけ / T10=10のくらいだけ / S,S3,K=途中式つき / R=あまりつき
//  p の1行: N,O1,T10 → [a, b, 答え]   R → [a, b, 商, あまり]   S,S3,K → [a, b, 答え, 途中1, 途中2]
//  good=○タイム(秒) great=◎タイム(秒)
//  gen:true = 本にないシートを、同じレベルの本の問題と同じ形でつくったもの（各レベル4枚にそろえるため）
// =====================================================
const SHEETS = [];
${sheets.map(fmtSheet).join('\n')}
`;
fs.writeFileSync(OUT, out);
console.log(`problems.js を作成: ${sheets.length}シート（うち追加 ${added}）/ ${sheets.reduce((s, x) => s + x.p.length, 0)}問`);
console.log(warnings.length ? `⚠ 検算で食いちがい ${warnings.length}件:\n  ` + warnings.join('\n  ') : '検算: 食いちがいなし');
