#!/usr/bin/env node
/**
 * Quick TS/QI autoscale snapshot printer (no jq required).
 * Mirrors the two runbook probes:
 *   - required QI scale: 0.9 / zeta_raw
 *   - servo glance: TS, timing, QI raw, window, tsAS, qiAS, rhoSource
 */

const bases = [
  process.env.API_BASE,
  process.env.HELIX_API_BASE,
  process.env.API_PROXY_TARGET,
  process.env.VITE_API_BASE,
  "http://localhost:5173",
].filter(Boolean);

const base = bases[0].replace(/\/+$/, "");
const url = `${base}/api/helix/pipeline`;

const fetchJson = async (target) => {
  const res = await fetch(target);
  if (!res.ok) {
    throw new Error(`GET ${target} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
};

const tauNs = (lc) => {
  if (!lc) return { tauLC_ns: null, tauPulse_ns: null };
  const tauLC_ns = typeof lc.tauLC_ms === "number" ? lc.tauLC_ms * 1e6 : null;
  let tauPulse_ns = null;
  if (typeof lc.burst_ns === "number") tauPulse_ns = lc.burst_ns;
  else if (typeof lc.burst_ms === "number") tauPulse_ns = lc.burst_ms * 1e6;
  return { tauLC_ns, tauPulse_ns };
};

const formatNumber = (v, digits = 3) =>
  typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(digits)) : null;

const main = async () => {
  try {
    const data = await fetchJson(url);
    const lc = data.lightCrossing || {};
    const qi = data.qiGuardrail || {};

    const zetaRaw = Number(qi.marginRatioRaw);
    const s_QI_target = zetaRaw > 0 ? 0.9 / zetaRaw : 1;

    const { tauLC_ns, tauPulse_ns } = tauNs(lc);

    const snapshot = {
      api: url,
      s_QI_target: formatNumber(s_QI_target, 6),
      TS: data.ts?.TS_ratio ?? data.TS_ratio ?? null,
      tauLC_ns: formatNumber(tauLC_ns, 3),
      tauPulse_ns: formatNumber(tauPulse_ns, 3),
      QI_raw: formatNumber(zetaRaw, 6),
      sumWindowDt: formatNumber(qi.sumWindowDt, 6),
      rhoSource: qi.rhoSource ?? null,
      tsAS: data.tsAutoscale ?? data.ts?.autoscale ?? null,
      qiAS: data.qiAutoscale ?? null,
    };

    console.log(JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.error(`[helix-autoscale-check] ${err.message}`);
    process.exitCode = 1;
  }
};

main();
