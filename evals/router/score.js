'use strict';

const RT = require('../../bridge/router');

const ROUTE_NAMES = Object.keys(RT.ROUTES);
const LORE_KIND_NAMES = Object.keys(RT.LORE_KINDS);
const DIFFICULTIES = ['easy', 'ambiguous', 'adversarial'];
const NOULS = [
  { key: 'needs_fresh', field: 'needsFresh' },
  { key: 'risky_edit', field: 'riskyEdit' },
];
const TARGET_WRONG_RATE = 0.05;
const MIN_EXECUTED_FOR_TRUST = 20;
const CALIBRATION_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0001];
const NOUL_EDGES = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001];
const PRICING = {
  'jev-1.13.0': { inputPerMtok: 0.042, outputPerMtok: 0, asOf: '2026-09-29', source: 'https://docs.typesafe.ai/models.md' },
};

function ratio(part, whole) {
  return whole ? part / whole : null;
}

function round(n, digits = 4) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return RT.percentile(sorted, p);
}

function acceptedProjects(c) {
  return [c.expected.project, ...(Array.isArray(c.also_ok_projects) ? c.also_ok_projects : [])];
}

function predictedProject(r) {
  return r && r.project ? r.project.name : null;
}

function judge(c, r) {
  const predictedRoute = r.route;
  const routeOk = predictedRoute === c.expected.route;
  const project = predictedProject(r);
  const projectStrict = project === c.expected.project;
  const projectLenient = acceptedProjects(c).includes(project);
  const nouls = {};
  for (const n of NOULS) {
    const p = r[n.field];
    nouls[n.key] = typeof p === 'number' ? { p, ok: (p >= 0.5) === c.expected[n.key] } : { p: null, ok: null };
  }
  const loreKindOk = c.expected.route === 'lore' && c.expected.lore_kind ? r.loreKind === c.expected.lore_kind : null;
  const wrong = [];
  if (!routeOk) wrong.push('route');
  if (c.expected.route === 'code' && !projectLenient) wrong.push('project');
  for (const n of NOULS) if (nouls[n.key].ok === false) wrong.push(n.key);
  if (loreKindOk === false) wrong.push('lore_kind');
  return { routeOk, projectStrict, projectLenient, nouls, loreKindOk, wrong };
}

function confusion(rows) {
  const labels = [...ROUTE_NAMES];
  const matrix = {};
  for (const e of labels) {
    matrix[e] = {};
    for (const p of labels) matrix[e][p] = 0;
  }
  for (const row of rows) {
    const e = row.case.expected.route;
    const p = row.result.route;
    if (!matrix[e]) continue;
    if (matrix[e][p] === undefined) matrix[e][p] = 0;
    matrix[e][p]++;
  }
  const perRoute = {};
  for (const r of labels) {
    const tp = matrix[r][r];
    const support = labels.reduce((s, p) => s + (matrix[r][p] || 0), 0);
    const predicted = labels.reduce((s, e) => s + (matrix[e][r] || 0), 0);
    const precision = ratio(tp, predicted);
    const recall = ratio(tp, support);
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
    perRoute[r] = { support, predicted, tp, precision: round(precision), recall: round(recall), f1: round(f1) };
  }
  return { labels, matrix, perRoute };
}

function auroc(pairs) {
  const pos = pairs.filter(x => x.label).map(x => x.p);
  const neg = pairs.filter(x => !x.label).map(x => x.p);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function bucketize(items, edges, valueOf, correctOf) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const inBucket = items.filter(x => { const v = valueOf(x); return v >= lo && v < hi; });
    const n = inBucket.length;
    const mean = n ? inBucket.reduce((s, x) => s + valueOf(x), 0) / n : null;
    const hits = inBucket.filter(correctOf).length;
    out.push({ bucket: `${lo.toFixed(2)}-${Math.min(hi, 1).toFixed(2)}`, n, meanValue: round(mean), observed: round(ratio(hits, n)) });
  }
  return out;
}

function expectedCalibrationError(buckets, total) {
  if (!total) return null;
  let sum = 0;
  for (const b of buckets) if (b.n) sum += (b.n / total) * Math.abs(b.meanValue - b.observed);
  return round(sum);
}

function noulMetrics(rows, key, field) {
  const pairs = rows.filter(r => typeof r.result[field] === 'number').map(r => ({ p: r.result[field], label: !!r.case.expected[key] }));
  const n = pairs.length;
  const tp = pairs.filter(x => x.label && x.p >= 0.5).length;
  const fp = pairs.filter(x => !x.label && x.p >= 0.5).length;
  const fn = pairs.filter(x => x.label && x.p < 0.5).length;
  const tn = pairs.filter(x => !x.label && x.p < 0.5).length;
  const brier = n ? pairs.reduce((s, x) => s + (x.p - (x.label ? 1 : 0)) ** 2, 0) / n : null;
  const calibration = bucketize(pairs, NOUL_EDGES, x => x.p, x => x.label);
  return {
    n,
    positives: tp + fn,
    missing: rows.length - n,
    auroc: round(auroc(pairs)),
    accuracyAt05: round(ratio(tp + tn, n)),
    precisionAt05: round(ratio(tp, tp + fp)),
    recallAt05: round(ratio(tp, tp + fn)),
    counts: { tp, fp, fn, tn },
    brier: round(brier),
    calibration,
  };
}

function wilsonUpper(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre + margin) / denom;
}

function recommendThresholds(rows, { target = TARGET_WRONG_RATE, minExecuted = MIN_EXECUTED_FOR_TRUST } = {}) {
  const answered = rows.filter(r => !r.result.fallback && typeof r.result.confidence === 'number');
  const perRoute = {};
  const chosen = {};
  for (const route of ROUTE_NAMES) {
    const picked = answered.filter(r => r.result.route === route);
    if (route === 'chat') {
      chosen.chat = 0;
      const wrong = picked.filter(r => r.case.expected.route !== 'chat').length;
      perRoute.chat = { threshold: 0, predicted: picked.length, executed: picked.length, wrongExecuted: wrong, wrongRate: round(ratio(wrong, picked.length)), fallback: 0, note: 'chat is the fallback, so it always runs' };
      continue;
    }
    const candidates = [...new Set(picked.map(r => r.result.confidence))].sort((a, b) => a - b);
    let best = null;
    for (const t of candidates) {
      const exec = picked.filter(r => r.result.confidence >= t);
      const wrong = exec.filter(r => r.case.expected.route !== route).length;
      if (exec.length && wrong / exec.length <= target) { best = { t, exec: exec.length, wrong }; break; }
    }
    if (!best) {
      chosen[route] = null;
      perRoute[route] = { threshold: null, predicted: picked.length, executed: 0, wrongExecuted: 0, wrongRate: null, fallback: picked.length, note: picked.length ? `no threshold keeps wrong-route runs at or under ${target * 100}%; never run` : 'never predicted' };
      continue;
    }
    chosen[route] = best.t;
    const notes = [];
    if (best.exec < minExecuted) notes.push(`only ${best.exec} executed; too few to trust`);
    perRoute[route] = {
      threshold: round(best.t),
      predicted: picked.length,
      executed: best.exec,
      wrongExecuted: best.wrong,
      wrongRate: round(best.wrong / best.exec),
      wrongRateUpper95: round(wilsonUpper(best.wrong, best.exec)),
      fallback: picked.length - best.exec,
      note: notes.join('; '),
    };
  }
  let executed = 0;
  let wrongExecuted = 0;
  let fellBack = 0;
  let fellBackRight = 0;
  for (const r of rows) {
    const route = r.result.route;
    const t = chosen[route];
    const answeredRow = !r.result.fallback && typeof r.result.confidence === 'number';
    const runs = answeredRow && route !== 'chat' && t !== null && t !== undefined && r.result.confidence >= t;
    if (runs) {
      executed++;
      if (r.case.expected.route !== route) wrongExecuted++;
    } else if (route !== 'chat' || r.result.fallback) {
      fellBack++;
      if (r.case.expected.route === 'chat') fellBackRight++;
    }
  }
  return {
    target,
    perRoute,
    overall: {
      total: rows.length,
      executedNonChat: executed,
      wrongExecuted,
      wrongExecutedRate: round(ratio(wrongExecuted, executed)),
      fellBackToChat: fellBack,
      fellBackRate: round(ratio(fellBack, rows.length)),
      fellBackWhereChatWasRight: fellBackRight,
    },
  };
}

function currentPolicy(rows) {
  const counts = { run: 0, 'run-notice': 0, chat: 0 };
  let executed = 0;
  let wrongExecuted = 0;
  let riskyMissed = 0;
  for (const r of rows) {
    const d = RT.decide(r.result);
    counts[d.action] = (counts[d.action] || 0) + 1;
    if (d.action !== 'chat' && d.route !== 'chat') {
      executed++;
      if (d.route !== r.case.expected.route) wrongExecuted++;
    }
    if (d.route === 'code' && d.permissionMode && d.permissionMode !== 'default' && r.case.expected.risky_edit) riskyMissed++;
  }
  return { thresholds: { ...RT.THRESHOLDS }, actions: counts, executedNonChat: executed, wrongExecuted, wrongExecutedRate: round(ratio(wrongExecuted, executed)), riskyCodeRunInAcceptEdits: riskyMissed };
}

function costOf(rows) {
  let input = 0;
  let output = 0;
  let calls = 0;
  const models = {};
  for (const r of rows) {
    for (const u of r.usage || []) {
      calls++;
      input += Number(u.input_tokens) || 0;
      output += Number(u.output_tokens) || 0;
      if (u.model) models[u.model] = (models[u.model] || 0) + (Number(u.input_tokens) || 0);
    }
  }
  const names = Object.keys(models);
  const priced = names.length > 0 && names.every(m => PRICING[m]);
  let usd = null;
  if (priced) {
    usd = 0;
    for (const m of names) usd += (models[m] / 1e6) * PRICING[m].inputPerMtok;
  }
  return {
    calls,
    inputTokens: input,
    outputTokens: output,
    models: names,
    usd: usd === null ? null : round(usd, 6),
    usdPerMessage: usd === null || !rows.length ? null : round(usd / rows.length, 8),
    pricing: priced ? names.map(m => ({ model: m, ...PRICING[m] })) : null,
    note: priced ? '' : names.length ? `no price known for ${names.filter(m => !PRICING[m]).join(', ')}; token totals only` : 'no usage reported',
  };
}

function breakdown(rows, keyOf) {
  const out = {};
  for (const r of rows) {
    const k = keyOf(r);
    if (!out[k]) out[k] = { n: 0, routeCorrect: 0 };
    out[k].n++;
    if (r.judged.routeOk) out[k].routeCorrect++;
  }
  for (const v of Object.values(out)) v.routeAccuracy = round(v.routeCorrect / v.n);
  return out;
}

function applyTimeout(rows, timeoutMs) {
  return rows.map(r => {
    const late = !r.result.fallback && Number(r.result.latencyMs) > timeoutMs;
    if (!late) return r;
    return { ...r, result: { route: 'chat', fallback: 'timeout', latencyMs: timeoutMs, probabilities: null, confidence: null, project: null, loreKind: null, needsFresh: null, riskyEdit: null, model: '' } };
  });
}

function score(rows, meta = {}) {
  const judged = rows.map(r => ({ ...r, judged: judge(r.case, r.result) }));
  const n = judged.length;
  const answered = judged.filter(r => !r.result.fallback);
  const fallbacks = judged.filter(r => r.result.fallback);
  const reasons = {};
  for (const r of fallbacks) reasons[r.result.fallback] = (reasons[r.result.fallback] || 0) + 1;
  const code = judged.filter(r => r.case.expected.route === 'code');
  const codeAnswered = code.filter(r => !r.result.fallback);
  const nonCode = judged.filter(r => r.case.expected.route !== 'code' && r.result.project);
  const lore = judged.filter(r => r.case.expected.route === 'lore' && r.case.expected.lore_kind && !r.result.fallback);
  const confRows = answered.filter(r => typeof r.result.confidence === 'number');
  const calibration = bucketize(confRows, CALIBRATION_EDGES, r => r.result.confidence, r => r.judged.routeOk);
  const latencies = judged.filter(r => !r.result.fallback || r.result.fallback === 'timeout').map(r => Number(r.result.latencyMs));
  const riskyCode = code.filter(r => r.case.expected.risky_edit && typeof r.result.riskyEdit === 'number');
  const wrongCases = judged.filter(r => r.judged.wrong.length).map(r => ({
    id: r.case.id,
    text: r.case.text,
    difficulty: r.case.difficulty,
    wrong: r.judged.wrong,
    expected: r.case.expected,
    got: {
      route: r.result.route,
      confidence: r.result.confidence,
      probabilities: r.result.probabilities,
      project: predictedProject(r.result),
      projectProbability: r.result.project ? r.result.project.probability : null,
      loreKind: r.result.loreKind,
      needsFresh: r.result.needsFresh,
      riskyEdit: r.result.riskyEdit,
      fallback: r.result.fallback || null,
    },
    unsure: r.case.unsure || null,
  }));
  const nouls = {};
  for (const x of NOULS) nouls[x.key] = noulMetrics(judged, x.key, x.field);
  return {
    meta,
    count: n,
    route: {
      accuracy: round(ratio(judged.filter(r => r.judged.routeOk).length, n)),
      accuracyAnswered: round(ratio(answered.filter(r => r.judged.routeOk).length, answered.length)),
      byDifficulty: breakdown(judged, r => r.case.difficulty),
      byExpected: breakdown(judged, r => r.case.expected.route),
      ...confusion(judged),
    },
    project: {
      codeCases: code.length,
      answered: codeAnswered.length,
      accuracyStrict: round(ratio(codeAnswered.filter(r => r.judged.projectStrict).length, codeAnswered.length)),
      accuracyLenient: round(ratio(codeAnswered.filter(r => r.judged.projectLenient).length, codeAnswered.length)),
      nonCodeWithAProject: nonCode.filter(r => predictedProject(r.result) !== RT.NO_PROJECT).length,
      nonCodeAnswered: nonCode.length,
    },
    loreKind: { n: lore.length, accuracy: round(ratio(lore.filter(r => r.judged.loreKindOk).length, lore.length)) },
    nouls,
    riskyOnCode: {
      riskyCodeCases: riskyCode.length,
      missedAt05: riskyCode.filter(r => r.result.riskyEdit < 0.5).length,
      missedIds: riskyCode.filter(r => r.result.riskyEdit < 0.5).map(r => r.case.id),
    },
    calibration: { buckets: calibration, ece: expectedCalibrationError(calibration, confRows.length) },
    latency: { n: latencies.filter(Number.isFinite).length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
    fallback: { count: fallbacks.length, rate: round(ratio(fallbacks.length, n)), reasons },
    retries: judged.reduce((s, r) => s + Math.max(0, (r.attempts || 1) - 1), 0),
    cost: costOf(judged),
    currentPolicy: currentPolicy(judged),
    thresholds: recommendThresholds(judged),
    wrongCases,
  };
}

function pct(v) {
  return v === null || v === undefined ? '-' : `${Math.round(v * 1000) / 10}%`;
}

function num(v) {
  return v === null || v === undefined ? '-' : String(v);
}

function table(header, rows) {
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const r of rows) lines.push(`| ${r.map(x => String(x).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
  return lines.join('\n');
}

function short(text, max = 70) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function toMarkdown(s) {
  const out = [];
  const m = s.meta || {};
  out.push(`# Router eval ${m.startedAt || ''}`.trim(), '');
  out.push(`- cases: **${s.count}**, model: ${m.model || '-'}, timeout: ${num(m.timeoutMs)} ms, concurrency: ${num(m.concurrency)}`);
  out.push(`- route accuracy: **${pct(s.route.accuracy)}** (fallbacks count as chat), ${pct(s.route.accuracyAnswered)} on answered calls`);
  out.push(`- project pick on code cases: **${pct(s.project.accuracyLenient)}** lenient, ${pct(s.project.accuracyStrict)} strict (${s.project.answered} answered)`);
  out.push(`- lore.kind on lore cases: ${pct(s.loreKind.accuracy)} (${s.loreKind.n})`);
  out.push(`- fallback: **${pct(s.fallback.rate)}** (${s.fallback.count})${Object.keys(s.fallback.reasons).length ? ': ' + Object.entries(s.fallback.reasons).map(([k, v]) => `${k} ${v}`).join(', ') : ''}; retries on 429/529: ${s.retries}`);
  out.push(`- latency: p50 ${num(s.latency.p50)} ms, p95 ${num(s.latency.p95)} ms, p99 ${num(s.latency.p99)} ms`);
  if (s.production) {
    const p = s.production;
    out.push(`- at the production timeout (${p.timeoutMs} ms): route accuracy **${pct(p.routeAccuracy)}**, fallback ${pct(p.fallback.rate)} (${p.fallback.count}), ${pct(p.thresholds.fellBackRate)} fall back with the recommended thresholds`);
  }
  const c = s.cost;
  out.push(`- cost: ${c.usd === null ? `${c.inputTokens} input / ${c.outputTokens} output tokens (${c.note})` : `$${c.usd} for ${c.inputTokens} input tokens ($${c.usdPerMessage} per message)`}`);
  out.push('');
  out.push('## Route accuracy by difficulty', '');
  out.push(table(['difficulty', 'n', 'accuracy'], Object.entries(s.route.byDifficulty).map(([k, v]) => [k, v.n, pct(v.routeAccuracy)])));
  out.push('', '## Per route', '');
  out.push(table(['route', 'support', 'predicted', 'precision', 'recall', 'f1'], s.route.labels.map(r => { const v = s.route.perRoute[r]; return [r, v.support, v.predicted, pct(v.precision), pct(v.recall), num(v.f1)]; })));
  out.push('', '## Confusion matrix (rows expected, columns predicted)', '');
  out.push(table(['expected \\ got', ...s.route.labels], s.route.labels.map(e => [e, ...s.route.labels.map(p => s.route.matrix[e][p] || 0)])));
  out.push('', '## Nouls', '');
  out.push(table(['noul', 'n', 'positives', 'AUROC', 'acc@0.5', 'precision@0.5', 'recall@0.5', 'brier'], Object.entries(s.nouls).map(([k, v]) => [k, v.n, v.positives, num(v.auroc), pct(v.accuracyAt05), pct(v.precisionAt05), pct(v.recallAt05), num(v.brier)])));
  out.push('', `risky code requests below 0.5 (would start in acceptEdits): **${s.riskyOnCode.missedAt05} of ${s.riskyOnCode.riskyCodeCases}**${s.riskyOnCode.missedIds.length ? ' (' + s.riskyOnCode.missedIds.join(', ') + ')' : ''}`);
  for (const [k, v] of Object.entries(s.nouls)) {
    out.push('', `### ${k} calibration`, '');
    out.push(table(['p bucket', 'n', 'mean p', 'observed yes'], v.calibration.map(b => [b.bucket, b.n, num(b.meanValue), pct(b.observed)])));
  }
  out.push('', '## Route calibration (confidence vs accuracy)', '');
  out.push(table(['confidence', 'n', 'mean confidence', 'accuracy'], s.calibration.buckets.map(b => [b.bucket, b.n, num(b.meanValue), pct(b.observed)])));
  out.push('', `ECE: ${num(s.calibration.ece)}`);
  const cp = s.currentPolicy;
  out.push('', '## Current policy (THRESHOLDS in bridge/router.js)', '');
  out.push(`run ${cp.actions.run || 0}, run-notice ${cp.actions['run-notice'] || 0}, chat ${cp.actions.chat || 0}; wrong route among non-chat runs: **${cp.wrongExecuted} of ${cp.executedNonChat} (${pct(cp.wrongExecutedRate)})**; risky code requests that would start in acceptEdits: ${cp.riskyCodeRunInAcceptEdits}`);
  const th = s.thresholds;
  out.push('', `## Recommended execute thresholds (wrong-route runs <= ${th.target * 100}% per route)`, '');
  out.push(table(['route', 'threshold', 'predicted', 'run', 'wrong', 'wrong rate', '95% upper', 'fall back', 'note'], ROUTE_NAMES.map(r => { const v = th.perRoute[r]; return [r, v.threshold === null ? 'never' : num(v.threshold), v.predicted, v.executed, v.wrongExecuted, pct(v.wrongRate), pct(v.wrongRateUpper95), v.fallback, v.note || '']; })));
  out.push('', `With these thresholds: ${th.overall.executedNonChat} non-chat runs, ${th.overall.wrongExecuted} wrong (${pct(th.overall.wrongExecutedRate)}); **${th.overall.fellBackToChat} of ${th.overall.total} messages (${pct(th.overall.fellBackRate)}) fall back to chat** (${th.overall.fellBackWhereChatWasRight} of them were chat anyway).`);
  out.push('', `## Wrong cases (${s.wrongCases.length})`, '');
  out.push(table(['id', 'diff', 'wrong', 'text', 'expected', 'got', 'conf', 'route probabilities', 'fresh', 'risky'], s.wrongCases.map(w => [
    w.id, w.difficulty, w.wrong.join(','), short(w.text),
    `${w.expected.route}${w.expected.route === 'code' ? '/' + w.expected.project : ''}${w.expected.lore_kind ? '/' + w.expected.lore_kind : ''}`,
    `${w.got.route}${w.got.fallback ? ' (' + w.got.fallback + ')' : ''}${w.got.project && w.got.project !== 'none' ? '/' + w.got.project + ' ' + num(w.got.projectProbability) : ''}${w.got.loreKind && w.expected.route === 'lore' ? '/' + w.got.loreKind : ''}`,
    num(w.got.confidence),
    w.got.probabilities ? Object.entries(w.got.probabilities).filter(([, v]) => v >= 0.01).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') : '-',
    `${w.expected.needs_fresh ? 'Y' : 'N'}/${num(w.got.needsFresh)}`,
    `${w.expected.risky_edit ? 'Y' : 'N'}/${num(w.got.riskyEdit)}`,
  ])));
  return out.join('\n') + '\n';
}

module.exports = {
  ROUTE_NAMES, LORE_KIND_NAMES, DIFFICULTIES, NOULS, PRICING, TARGET_WRONG_RATE, MIN_EXECUTED_FOR_TRUST,
  judge, confusion, auroc, bucketize, noulMetrics, wilsonUpper, recommendThresholds, currentPolicy, costOf, applyTimeout, score, toMarkdown, percentile,
};
