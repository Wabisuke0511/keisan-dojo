// 計算道場：進捗メールの送信（eitan-radar の send-weekly-report を手本に簡略化）
//  POST { app:"keisan", user_id:<あだな>, email:<宛先> }   Authorization: Bearer <anon key>
//  ・本文はクライアントから受け取らず、drill_records / drill_progress から作る（なりすまし文面を送らせない）
//  ・認証なしアプリなので、レート制限で悪用を抑える（drill_report_logs に記録）
//  Secrets: RESEND_API_KEY（必須）, KEISAN_REPORT_FROM（なければ REPORT_FROM）
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const env = (n: string) => { const v = Deno.env.get(n); if (!v) throw new Error(`${n} is not set`); return v; };

const APP = "keisan";
const LIMIT_PER_USER = 5, LIMIT_PER_EMAIL = 5, LIMIT_GLOBAL = 50;   // 24時間あたり
const OPS: Record<string, { name: string; icon: string }> = {
  tashizan: { name: "たし算", icon: "➕" }, hikizan: { name: "ひき算", icon: "➖" },
  kakezan: { name: "かけ算", icon: "✖️" }, warizan: { name: "わり算", icon: "➗" },
  lcm: { name: "最小公倍数", icon: "🔗" }, bunsu: { name: "分数のたし算・ひき算", icon: "🍰" },
  bunsu2: { name: "分数のかけ算・わり算", icon: "🥧" }, bunsu3: { name: "分数の混合計算", icon: "🧁" },
};
const okMail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const user = String(body.user_id ?? "").trim(), email = String(body.email ?? "").trim();
    if (body.app !== APP || !user || user.length > 20 || !okMail(email)) return json({ error: "bad_request" }, 400);

    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
    const since = new Date(Date.now() - 86400_000).toISOString();
    const count = async (col?: string, val?: string) => {
      let q = admin.from("drill_report_logs").select("id", { count: "exact", head: true }).eq("app", APP).gte("created_at", since);
      if (col) q = q.eq(col, val);
      return (await q).count ?? 0;
    };
    if ((await count("user_id", user)) >= LIMIT_PER_USER || (await count("email", email)) >= LIMIT_PER_EMAIL || (await count()) >= LIMIT_GLOBAL) {
      return json({ error: "rate_limited" }, 429);
    }

    const { data: recs } = await admin.from("drill_records").select("played_at, score, theme, total_q, time_sec")
      .eq("user_id", user).like("theme", APP + ":%").gte("played_at", new Date(Date.now() - 7 * 86400_000).toISOString())
      .order("played_at", { ascending: true });
    const { data: prog } = await admin.from("drill_progress").select("item_key, count").eq("user_id", user).eq("app", APP);
    const view = summarize(user, recs ?? [], prog ?? []);

    let status = "sent", error: string | null = null;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("KEISAN_REPORT_FROM") ?? env("REPORT_FROM"), to: [email],
          subject: `【計算道場】${user}さんの進捗（直近7日）`, html: renderHtml(view), text: renderText(view),
        }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    } catch (e) { status = "failed"; error = String(e).slice(0, 300); }

    await admin.from("drill_report_logs").insert({ app: APP, user_id: user, email, status, error });
    return json(status === "sent" ? { status } : { status, error });
  } catch (e) {
    console.error(e);
    return json({ error: "internal" }, 500);
  }
});

type Rec = { played_at: string; score: number; theme: string; total_q: number | null; time_sec: number | null };

function label(theme: string) {
  const [, op, lv, tag] = theme.split(":");
  const name = OPS[op]?.name ?? op, n = parseInt((lv ?? "").replace("lv", ""), 10);
  if (tag === "q") return `${name} Lv${n} 一問一答`;
  const m = (tag ?? "").match(/^s(\d+)(?:-(\d+))?$/);
  if (!m) return `${name} Lv${n}`;
  return `${name} ${n}-${m[1]}${m[2] ? `（${m[2]}）` : ""}`;
}
const fmtTime = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
const jstDate = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
const jstMD = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" });

function summarize(name: string, recs: Rec[], prog: { item_key: string; count: number }[]) {
  const rows = recs.map((r) => {
    const total = r.total_q || 1;
    return { ...r, total, correct: Math.round((r.score / 100) * total), op: r.theme.split(":")[1] };
  });
  const sum = (rs: typeof rows) => {
    const total = rs.reduce((s, r) => s + r.total, 0), correct = rs.reduce((s, r) => s + r.correct, 0);
    return { n: rs.length, total, pct: total ? Math.round((100 * correct) / total) : null };
  };
  const byOp = Object.keys(OPS).map((op) => {
    const s = sum(rows.filter((r) => r.op === op));
    const p = prog.filter((x) => x.item_key.startsWith(op + ":"));
    return { op, ...OPS[op], ...s, great: p.filter((x) => x.count >= 3).length, good: p.filter((x) => x.count === 2).length, ok: p.filter((x) => x.count === 1).length };
  }).filter((x) => x.n || x.great || x.good || x.ok);
  return {
    name, all: sum(rows), days: new Set(rows.map((r) => jstDate(r.played_at))).size,
    minutes: Math.round(rows.reduce((s, r) => s + (r.time_sec ?? 0), 0) / 60), byOp,
    recent: rows.slice(-10).reverse().map((r) => ({ date: jstMD(r.played_at), label: label(r.theme), correct: r.correct, total: r.total, time: fmtTime(r.time_sec) })),
  };
}
type View = ReturnType<typeof summarize>;

function renderText(v: View) {
  const L = [`🧮 ${v.name}さんの計算道場（直近7日）`, ""];
  if (!v.all.n) L.push("この7日間の きろくは ありません。");
  else {
    L.push(`学習した日：${v.days}/7日`, `とりくんだ回数：${v.all.n}回（${v.all.total}問）`, `正答率：${v.all.pct}%`, `計算した時間：${v.minutes}分`, "");
    v.byOp.forEach((o) => L.push(`${o.icon} ${o.name}：${o.n}回・${o.total}問${o.pct != null ? `・正答率${o.pct}%` : ""}　達成シート ◎${o.great}・○${o.good}・✓${o.ok}`));
    L.push("", "最近の結果：");
    v.recent.forEach((r) => L.push(`・${r.date} ${r.label}　${r.correct}/${r.total}問${r.time ? "　" + r.time : ""}`));
  }
  L.push("", "※ このメールは計算道場アプリの「進捗をメールで送る」から送信されました。");
  return L.join("\n");
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function renderHtml(v: View) {
  const kpi = (n: string, lbl: string) => `<td style="background:#e8f0fa;border-radius:12px;padding:12px;width:50%"><div style="font-size:24px;font-weight:800;color:#1f5089">${n}</div><div style="font-size:12px;color:#475569">${lbl}</div></td>`;
  const body = !v.all.n ? `<div style="font-size:14px;color:#475569">この7日間の きろくは ありません。</div>` : `
<table role="presentation" width="100%" cellspacing="8"><tr>${kpi(`${v.days}<small style="font-size:13px"> / 7日</small>`, "学習した日")}${kpi(`${v.all.total}<small style="font-size:13px"> 問</small>`, `とりくんだ問題（${v.all.n}回）`)}</tr>
<tr>${kpi(`${v.all.pct ?? "–"}<small style="font-size:13px">%</small>`, "正答率")}${kpi(`${v.minutes}<small style="font-size:13px"> 分</small>`, "計算した時間")}</tr></table>
<div style="font-weight:800;font-size:13px;margin:14px 0 6px">種目べつ</div>
<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse">${v.byOp.map((o) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eef1f4">${o.icon} ${esc(o.name)}</td><td style="text-align:right;border-bottom:1px solid #eef1f4">${o.n}回・${o.total}問${o.pct != null ? `・<b>${o.pct}%</b>` : ""}</td><td style="text-align:right;border-bottom:1px solid #eef1f4;color:#27ae60;font-weight:700">◎${o.great} ○${o.good} ✓${o.ok}</td></tr>`).join("")}</table>
<div style="font-weight:800;font-size:13px;margin:14px 0 6px">最近の結果</div>
<table role="presentation" width="100%" style="font-size:13px;border-collapse:collapse">${v.recent.map((r) => `<tr><td style="padding:5px 0;color:#475569">${esc(r.date)}</td><td>${esc(r.label)}</td><td style="text-align:right">${r.correct}/${r.total}</td><td style="text-align:right;color:#1f5089;font-weight:700">${esc(r.time)}</td></tr>`).join("")}</table>`;
  return `<!doctype html><html><body style="margin:0;background:#f0f4f8;font-family:-apple-system,'Hiragino Sans',sans-serif;color:#2c3e50">
<div style="max-width:520px;margin:0 auto;padding:16px"><div style="background:#fff;border:1px solid #dde3ea;border-radius:16px;padding:20px">
<div style="font-size:18px;font-weight:800">🧮 ${esc(v.name)}さんの計算道場</div><div style="font-size:13px;color:#475569;margin-bottom:12px">直近7日のようす</div>
${body}
</div><div style="font-size:12px;color:#94a3b8;text-align:center;margin-top:12px">このメールは計算道場アプリの「進捗をメールで送る」から送信されました。</div></div></body></html>`;
}
