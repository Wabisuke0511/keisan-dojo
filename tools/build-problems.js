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
// =====================================================
//  追加教材（本にはない・ぜんぶ自動でつくる）：最小公倍数 / 分数のたし算・ひき算
//  各レベル4枚。○◎タイムは目安（使ってみて調整する）
// =====================================================
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return Math.abs(a); };
const lcm = (a, b) => (a / gcd(a, b)) * b;
const lcmN = (xs) => xs.reduce(lcm);
const pick = (R, arr) => arr[Math.floor(R() * arr.length)];
const between = (R, lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

// 1シートぶんを作る。gen(R) が1問（キー文字列つき）を返す。シートの中で同じ問題を出さない
function makeSheet(R, n, gen) {
  const seen = new Set(), p = [];
  for (let tries = 0; p.length < n && tries < 100000; tries++) {
    const g = gen(R); if (!g || seen.has(g.key)) continue;
    seen.add(g.key); p.push(g.row);
  }
  if (p.length < n) throw new Error('問題が足りない');
  return p;
}
function addGenerated(op, levels) {
  levels.forEach((lv, i) => {
    for (let no = 1; no <= SHEETS_PER_LEVEL; no++) {
      const R = rng(`${op}:${i + 1}:${no}`);
      sheets.push({ op, level: i + 1, no, mode: lv.mode, good: lv.good, great: lv.great, instruction: lv.instruction, example: lv.example, gen: true, p: makeSheet(R, lv.n, lv.gen) });
      added++;
    }
  });
}

// ---------- 最小公倍数（L2: [a, b, 答え] / L3: [a, b, c, 答え]） ----------
const lcm2 = (as, bs, ok = () => true) => (R) => {
  let a = pick(R, as), b = pick(R, bs); if (a === b || !ok(a, b)) return null;
  if (a > b && R() < 0.5) [a, b] = [b, a];
  return { key: `${a},${b}`, row: [a, b, lcm(a, b)] };   // 4と6 と 6と4 は別の問題として数える
};
const FRIENDLY = [6, 8, 9, 10, 12, 14, 15, 16, 18, 20, 21, 24, 25, 28, 30, 32, 35, 36, 40, 42, 45, 48];   // 分数でよく出る分母
addGenerated('lcm', [
  { mode: 'L2', n: 36, good: 150, great: 100, instruction: '2つの数の最小公倍数をこたえなさい。', example: '4と6→12',
    gen: lcm2(range(2, 9), range(2, 9)) },
  { mode: 'L2', n: 36, good: 180, great: 120, instruction: '2つの数の最小公倍数をこたえなさい。', example: '6と8→24',
    gen: lcm2(range(2, 12), range(6, 20), (a, b) => lcm(a, b) <= 120) },
  { mode: 'L2', n: 18, good: 150, great: 100, instruction: '2つの数の最小公倍数をこたえなさい。', example: '12と18→36',
    gen: lcm2(FRIENDLY, FRIENDLY, (a, b) => a % b !== 0 && b % a !== 0 && lcm(a, b) <= 360) },
  { mode: 'L3', n: 18, good: 180, great: 120, instruction: '3つの数の最小公倍数をこたえなさい。', example: '4と6と9→36',
    gen: (R) => {
      const xs = [pick(R, range(2, 12)), pick(R, range(2, 12)), pick(R, range(2, 12))];
      if (new Set(xs).size < 3 || lcmN(xs) > 180) return null;
      return { key: xs.slice().sort((x, y) => x - y).join(','), row: [...xs, lcmN(xs)] };
    } },
]);

// ---------- 分数のたし算・ひき算（F: [整数1, 分子1, 分母1, 符号, 整数2, 分子2, 分母2, 答え整数, 答え分子, 答え分母]） ----------
// 答えは約分して、1より大きいときは帯分数。整数になるときは 答え分子・分母 = null
function fracAnswer(num, den) {               // num/den（仮分数）→ [整数, 分子, 分母]
  const g = gcd(num, den); num /= g; den /= g;
  const w = Math.floor(num / den), r = num - w * den;
  return r === 0 ? [w, null, null] : [w, r, den];
}
function fracRow(R, x, y, sign, opt = {}) {    // x, y = [整数, 分子, 分母]
  const v = (f) => f[0] * f[2] + f[1];          // 仮分数の分子
  const D = lcm(x[2], y[2]);
  const num = v(x) * (D / x[2]) + sign * v(y) * (D / y[2]);
  if (num <= 0) return null;                    // 0やマイナスは出さない
  const ans = fracAnswer(num, D);
  if (opt.noReduce && (gcd(num, D) !== 1 || num >= D)) return null;   // 約分なし・1未満
  if (opt.needWhole === true && ans[0] === 0) return null;
  if (ans[1] === null && R() < 0.8) return null;   // 答えが整数の問題は少なめ
  return { key: `${x}|${sign}|${y}`, row: [x[0], x[1], x[2], sign > 0 ? '+' : '-', y[0], y[1], y[2], ...ans] };
}
const properFrac = (R, den) => { for (;;) { const n = between(R, 1, den - 1); if (gcd(n, den) === 1) return n; } };
const F = (R, den, whole = 0) => [whole, properFrac(R, den), den];
const sameDen = (R, sign, opt) => { const d = between(R, 3, 12); return fracRow(R, F(R, d), F(R, d), sign, opt); };
const multDen = (R, sign) => {                 // 一方の分母がもう一方の倍数（1/3 と 1/6 など）
  const d1 = between(R, 2, 6), d2 = d1 * pick(R, [2, 3, 4]); if (d2 > 24) return null;
  return R() < 0.5 ? fracRow(R, F(R, d1), F(R, d2), sign) : fracRow(R, F(R, d2), F(R, d1), sign);
};
const otherDen = (R, sign, wholes) => {        // 最小公倍数で通分する（1/4 と 1/6 など）
  const d1 = between(R, 2, 12), d2 = between(R, 2, 12);
  if (d1 === d2 || d1 % d2 === 0 || d2 % d1 === 0 || lcm(d1, d2) > (wholes ? 36 : 60)) return null;   // 帯分数は通分を軽めに
  // 帯分数はどちらも整数部分あり。ひき算は ひかれる数の整数部分を大きく（くり下がりは自然に出る）
  const w1 = !wholes ? 0 : sign > 0 ? between(R, 1, 4) : between(R, 2, 5);
  const w2 = !wholes ? 0 : sign > 0 ? between(R, 1, 4) : between(R, 1, w1 - 1);
  return fracRow(R, F(R, d1, w1), F(R, d2, w2), sign);
};
const FRAC_INST = '計算しなさい。答えは約分して、1より大きいときは帯分数にしなさい。';
addGenerated('bunsu', [
  { mode: 'F', n: 18, good: 90,  great: 60,  instruction: '分母が同じ分数のたし算をしなさい。', example: '1/5+2/5=3/5',
    gen: (R) => sameDen(R, 1, { noReduce: true }) },
  { mode: 'F', n: 18, good: 120, great: 80,  instruction: '分母が同じ分数の計算。' + FRAC_INST.slice(7), example: '5/6+5/6=1と2/3',
    gen: (R) => sameDen(R, R() < 0.6 ? 1 : -1) },
  { mode: 'F', n: 18, good: 150, great: 100, instruction: '分母がちがう分数のたし算。' + FRAC_INST.slice(7), example: '1/3+1/6=1/2',
    gen: (R) => multDen(R, 1) },
  { mode: 'F', n: 18, good: 150, great: 100, instruction: '分母がちがう分数のひき算。' + FRAC_INST.slice(7), example: '3/4-1/8=5/8',
    gen: (R) => multDen(R, -1) },
  { mode: 'F', n: 18, good: 210, great: 140, instruction: '最小公倍数で通分して、たし算をしなさい。答えは約分して、1より大きいときは帯分数に。', example: '1/4+1/6=5/12',
    gen: (R) => otherDen(R, 1, false) },
  { mode: 'F', n: 18, good: 210, great: 140, instruction: '最小公倍数で通分して、ひき算をしなさい。答えは約分して、1より大きいときは帯分数に。', example: '5/6-3/8=11/24',
    gen: (R) => otherDen(R, -1, false) },
  { mode: 'F', n: 18, good: 270, great: 180, instruction: '帯分数のたし算。' + FRAC_INST.slice(7), example: '1と1/2+2と2/3=4と1/6',
    gen: (R) => otherDen(R, 1, true) },
  { mode: 'F', n: 18, good: 270, great: 180, instruction: '帯分数のひき算。' + FRAC_INST.slice(7), example: '3と1/4-1と2/3=1と7/12',
    gen: (R) => otherDen(R, -1, true) },
]);

// 追加教材の検算（答えをべつの方法で計算しなおす）
sheets.filter((s) => s.op === 'lcm' || s.op === 'bunsu').forEach((s) => s.p.forEach((r) => {
  if (s.op === 'lcm') {
    const xs = r.slice(0, -1), ans = r[r.length - 1];
    let m = Math.max(...xs); while (!xs.every((x) => m % x === 0)) m++;   // 素朴に数えあげる
    if (m !== ans) warnings.push(`lcm ${s.level}-${s.no}: ${r}`);
  } else {
    const [w1, a, b, op, w2, c, d, W, N, D] = r, sign = op === '+' ? 1 : -1;
    const left = ((w1 * b + a) * d + sign * (w2 * d + c) * b) * (D ?? 1), right = (W * (D ?? 1) + (N ?? 0)) * b * d;
    const okForm = N === null || (N < D && gcd(N, D) === 1);
    if (left !== right || !okForm || left <= 0) warnings.push(`bunsu ${s.level}-${s.no}: ${r}`);
  }
}));

// ---------- 分数のかけ算・わり算 / 分数の混合計算（FX: { t: [[整数, 分子, 分母], ...], o: ['×','÷','+','−', ...], a: [答え整数, 答え分子, 答え分母] }） ----------
// 整数の項は [整数, null, null]。計算の順序は ×÷ が先、+− があと（ふつうの決まり）
const Q = (n, d = 1) => { if (d < 0) { n = -n; d = -d; } const g = gcd(n, d) || 1; return { n: n / g, d: d / g }; };
const qOf = ([w, n, d]) => (n == null ? Q(w) : Q(w * d + n, d));
const qOp = (x, op, y) => op === '×' ? Q(x.n * y.n, x.d * y.d) : op === '÷' ? Q(x.n * y.d, x.d * y.n)
  : op === '+' ? Q(x.n * y.d + y.n * x.d, x.d * y.d) : Q(x.n * y.d - y.n * x.d, x.d * y.d);
function evalFX(t, o) {                         // ×÷ を先にまとめて、+− を左から。途中でマイナスになったら null
  const vals = [qOf(t[0])], ops = [];
  o.forEach((op, i) => {
    const y = qOf(t[i + 1]);
    if (op === '×' || op === '÷') vals[vals.length - 1] = qOp(vals[vals.length - 1], op, y);
    else { ops.push(op); vals.push(y); }
  });
  let acc = vals[0];
  for (let i = 0; i < ops.length; i++) { acc = qOp(acc, ops[i], vals[i + 1]); if (acc.n < 0) return null; }
  return acc;
}
function fxRow(t, o, opt = {}) {
  const v = evalFX(t, o);
  if (!v || v.n <= 0 || v.d > (opt.maxDen || 60) || v.n / v.d > (opt.maxVal || 20)) return null;
  const a = fracAnswer(v.n, v.d);
  return { key: JSON.stringify([t, o]), row: { t, o, a } };
}
const pf = (R, dens, whole = 0) => { const d = pick(R, dens); return [whole, properFrac(R, d), d]; };   // 真分数（約分ずみ）
const D9 = range(2, 9), D12 = range(2, 12);
const intOK = (R, row) => row && (row.row.a[1] !== null || R() < 0.15) ? row : null;   // 答えが整数になる問題は少なめ
const MUL_INST = '計算しなさい。答えは約分して、1より大きいときは帯分数にしなさい。';
addGenerated('bunsu2', [
  { mode: 'FX', n: 18, good: 90, great: 60, instruction: '分数×整数、分数÷整数。' + MUL_INST.slice(7), example: '2/9×3=2/3',
    gen: (R) => intOK(R, fxRow([pf(R, D9), [between(R, 2, 9), null, null]], [R() < 0.5 ? '×' : '÷'])) },
  { mode: 'FX', n: 18, good: 120, great: 80, instruction: '分数×分数。約分できるときは、とちゅうで約分すると楽。' + MUL_INST.slice(7), example: '3/4×2/9=1/6',
    gen: (R) => intOK(R, fxRow([pf(R, D9), pf(R, D9)], ['×'])) },
  { mode: 'FX', n: 18, good: 120, great: 80, instruction: '分数÷分数。わる数をひっくり返してかける。' + MUL_INST.slice(7), example: '2/3÷4/9=1と1/2',
    gen: (R) => intOK(R, fxRow([pf(R, D9), pf(R, D9)], ['÷'])) },
  { mode: 'FX', n: 18, good: 180, great: 120, instruction: '帯分数のかけ算・わり算。帯分数は仮分数になおしてから。' + MUL_INST.slice(7), example: '1と1/2×2/3=1',
    gen: (R) => intOK(R, fxRow([pf(R, D9, between(R, 0, 3)), pf(R, D9, between(R, 1, 2))].sort(() => R() - 0.5), [R() < 0.5 ? '×' : '÷'])) },
  { mode: 'FX', n: 12, good: 180, great: 120, instruction: '3つの分数のかけ算・わり算。' + MUL_INST.slice(7), example: '2/3×3/4÷1/2=1',
    gen: (R) => intOK(R, fxRow([pf(R, D9), pf(R, D9), pf(R, D9)], [R() < 0.5 ? '×' : '÷', R() < 0.5 ? '×' : '÷'])) },
]);
const ALL4 = ['+', '−', '×', '÷'];
const mixedOps = (R, n) => {                    // +− と ×÷ が かならず まざるように
  for (;;) { const o = Array.from({ length: n }, () => pick(R, ALL4)); if (n < 2 || (o.some((x) => x === '+' || x === '−') && o.some((x) => x === '×' || x === '÷'))) return o; }
};
const MIX_INST = '×÷を先に計算しなさい。答えは約分して、1より大きいときは帯分数に。';
addGenerated('bunsu3', [
  { mode: 'FX', n: 18, good: 150, great: 100, instruction: '+−×÷ のどれかの計算。答えは約分して、1より大きいときは帯分数に。', example: '3/4−1/6=7/12',
    gen: (R) => intOK(R, fxRow([pf(R, D9), pf(R, D9)], [pick(R, ALL4)], { maxDen: 36 })) },
  { mode: 'FX', n: 12, good: 180, great: 120, instruction: '3つの分数の計算。' + MIX_INST, example: '1/2+1/3×3/4=3/4',
    gen: (R) => intOK(R, fxRow([pf(R, D9), pf(R, D9), pf(R, D9)], mixedOps(R, 2), { maxDen: 36 })) },
  { mode: 'FX', n: 12, good: 240, great: 160, instruction: '帯分数をふくむ3つの分数の計算。' + MIX_INST, example: '1と1/2÷3/4−2/3=1と1/3',
    gen: (R) => intOK(R, fxRow([pf(R, D9, between(R, 1, 2)), pf(R, D9), pf(R, D9)], mixedOps(R, 2), { maxDen: 36 })) },
  { mode: 'FX', n: 12, good: 300, great: 200, instruction: '4つの分数の計算。' + MIX_INST, example: '1/2×2/3+3/4÷3/8=2と1/3',
    gen: (R) => intOK(R, fxRow([pf(R, D9), pf(R, D9), pf(R, D9), pf(R, D9)], mixedOps(R, 3), { maxDen: 48 })) },
]);
// FX の検算：小数で計算しなおして答えと比べる（べつの方法）＋答えの形
sheets.filter((s) => s.mode === 'FX').forEach((s) => s.p.forEach((r) => {
  const num = r.t.map(([w, n, d]) => (n == null ? w : w + n / d));
  const vals = [num[0]], ops = [];
  r.o.forEach((op, i) => { if (op === '×') vals[vals.length - 1] *= num[i + 1]; else if (op === '÷') vals[vals.length - 1] /= num[i + 1]; else { ops.push(op); vals.push(num[i + 1]); } });
  const f = ops.reduce((acc, op, i) => (op === '+' ? acc + vals[i + 1] : acc - vals[i + 1]), vals[0]);
  const [W, N, D] = r.a, ans = W + (N == null ? 0 : N / D);
  const okForm = N == null || (N < D && gcd(N, D) === 1);
  if (Math.abs(f - ans) > 1e-9 || !okForm || ans <= 0) warnings.push(`${s.op} ${s.level}-${s.no}: ${JSON.stringify(r)}`);
}));

const OP_ORDER = [...Object.keys(OPSYM), 'lcm', 'bunsu', 'bunsu2', 'bunsu3'];
sheets.sort((x, y) => OP_ORDER.indexOf(x.op) - OP_ORDER.indexOf(y.op) || x.level - y.level || x.no - y.no);

const fmtSheet = (s) => `SHEETS.push(${JSON.stringify({ ...s, p: undefined }).replace(/}$/, '')},\n  "p":[${s.p.map((r) => JSON.stringify(r)).join(',')}]});`;
const out = `// =====================================================
//  計算道場 教材データ ★自動生成ファイル（手で直さない）
//  元データ: question_resource/keisan_dojo_*.csv → node tools/build-problems.js で作り直す
//
//  mode: N=ふつう / O1=1のくらいだけ / T10=10のくらいだけ / S,S3,K=途中式つき / R=あまりつき
//  p の1行: N,O1,T10 → [a, b, 答え]   R → [a, b, 商, あまり]   S,S3,K → [a, b, 答え, 途中1, 途中2]
//          L2 → [a, b, 最小公倍数]   L3 → [a, b, c, 最小公倍数]
//          F → [整数1, 分子1, 分母1, '+'/'-', 整数2, 分子2, 分母2, 答え整数, 答え分子, 答え分母]（答えが整数なら分子・分母は null）
//          FX → { t: [[整数, 分子, 分母], ...], o: ['×','÷','+','−'...], a: [答え整数, 答え分子, 答え分母] }（整数の項は [n, null, null]・×÷が先）
//  good=○タイム(秒) great=◎タイム(秒)
//  gen:true = 本にないシートを、同じレベルの本の問題と同じ形でつくったもの（各レベル4枚にそろえるため）
// =====================================================
const SHEETS = [];
${sheets.map(fmtSheet).join('\n')}
`;
fs.writeFileSync(OUT, out);
console.log(`problems.js を作成: ${sheets.length}シート（うち追加 ${added}）/ ${sheets.reduce((s, x) => s + x.p.length, 0)}問`);
console.log(warnings.length ? `⚠ 検算で食いちがい ${warnings.length}件:\n  ` + warnings.join('\n  ') : '検算: 食いちがいなし');
