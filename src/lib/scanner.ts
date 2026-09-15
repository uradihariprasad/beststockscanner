/**
 * Two-stage scanning engine.
 *
 * STAGE 1 — fast, market-wide metrics from real Upstox quotes + 1-min candles.
 * STAGE 2 — deep structure: dynamic price S/R, option-chain S/R, confluence
 *           zones, trade setups with real entry/SL/targets and R:R.
 *
 * DATA INTEGRITY: every number is derived from actual Upstox responses.
 * When an input is missing the metric is `null` and the UI renders N/A —
 * no synthetic or estimated values are ever produced.
 */

import type { Candle, ChainStrike, Quote } from "@/lib/upstox";
import type { ScannerConfig } from "@/lib/config";
import {
  atr,
  consolidationZones,
  countTouches,
  lastEma,
  resample,
  swings,
  vwapFromCandles,
} from "@/lib/indicators";
import { minuteOfDayIST } from "@/lib/market";
import type { DataStatus } from "@/lib/market";

// ================================================================== types

export type Direction = "LONG" | "SHORT";
export type Trend = "BULLISH" | "BEARISH" | "NEUTRAL";
export type Momentum = "EARLY" | "CONFIRMED" | "NONE";
export type SetupState =
  | "LONG"
  | "SHORT"
  | "WAIT_FOR_BREAKOUT"
  | "WAIT_FOR_BREAKDOWN"
  | "WAIT_FOR_RETEST"
  | "NO_TRADE";
export type Buildup = "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING" | "NONE";

export interface NiftySnapshot {
  ltp: number | null;
  prevClose: number | null;
  open: number | null;
  changePct: number | null;
  candles1m: Candle[] | null;
  trend5m: Trend | null;
  aboveVwap: boolean | null;
  status: DataStatus;
}

export interface Stage1Row {
  symbol: string;
  name: string | null;
  ltp: number | null;
  prevClose: number | null;
  open: number | null;
  changePct: number | null;
  ret5m: number | null;
  ret15m: number | null;
  accel: number | null; // ret5m − prev 5m ret (price acceleration, % pts)
  volume: number | null;
  turnoverCr: number | null;
  rvol: number | null; // time-of-day-adjusted relative volume
  rs: number | null; // stock − NIFTY (% points)
  rsAccel: number | null; // change in RS over last 15 min (% points)
  sectorRs: number | null; // N/A — sector feeds not provided by Upstox
  vwap: number | null;
  aboveVwap: boolean | null;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  trend5m: Trend | null;
  structure: "HH_HL" | "LH_LL" | "MIXED" | null;
  futLtp: number | null;
  futChangePct: number | null;
  futOi: number | null;
  futOiChange: number | null;
  futOiChangePct: number | null;
  basis: number | null; // futures − spot
  buildup: Buildup | null;
  liquidityOk: boolean | null;
  scoreLong: number | null;
  scoreShort: number | null;
  dir: Direction | null;
  score: number | null; // directional momentum score 0-100
  status: DataStatus;
  momentum: Momentum;
  flags: string[]; // e.g. RVOL↑ RS↑ ACC↑
  scannedAt: number;
}

export type LevelKind =
  | "PDH"
  | "PDL"
  | "PDC"
  | "OPEN"
  | "ORH"
  | "ORL"
  | "SWING_H"
  | "SWING_L"
  | "CONSOL"
  | "VWAP"
  | "CE_OI"
  | "PE_OI";

export interface ZoneSource {
  kind: LevelKind;
  price: number;
  oi: number | null;
  oiChg: number | null;
  optVol: number | null;
  share: number | null; // OI share within chain window (0-1)
  strikeScore: number | null;
}

export interface Zone {
  id: string;
  low: number;
  high: number;
  mid: number;
  kinds: LevelKind[];
  sources: ZoneSource[];
  touches: number;
  lastTouchAgoMin: number | null;
  strength: number; // 0-100 confluence score
  hasOption: boolean;
  optionLabel: string | null; // e.g. "PE OI 2.4L @ 24,500"
  acceptedAbove: boolean;
  acceptedBelow: boolean;
  flipped: "UP" | "DOWN" | null;
  retested: boolean;
  side: "SUPPORT" | "RESISTANCE";
  distancePct: number;
}

export interface StrikeInfo {
  strike: number;
  score: number; // 0-100
  oi: number | null;
  oiChg: number | null;
  vol: number | null;
  share: number;
  concentration: number;
}

export interface LevelsResult {
  zones: Zone[];
  supports: Zone[];
  resistances: Zone[];
  optionSupport: StrikeInfo | null;
  optionResistance: StrikeInfo | null;
  chainExpiry: string | null;
  maxCeOi: StrikeInfo | null;
  maxPeOi: StrikeInfo | null;
}

export interface TradeSetup {
  state: SetupState;
  direction: Direction | null;
  entryLow: number | null;
  entryHigh: number | null;
  entryType: "BREAKOUT" | "BREAKDOWN" | "RETEST" | "CONTINUATION" | "ZONE" | null;
  stop: number | null;
  stopBasis: string | null; // structural invalidation description
  t1: number | null;
  t2: number | null;
  t3: number | null;
  risk: number | null;
  rr1: number | null;
  rr2: number | null;
  rrOk: boolean | null;
  reasons: string[];
  insufficientData: boolean;
}

export interface Explanation {
  headline: string;
  whyNow: string;
  confirms: string[];
  invalidates: string[];
}

export interface TradeCard {
  symbol: string;
  name: string | null;
  direction: Direction | null;
  finalScore: number | null;
  setupState: SetupState;
  setup: TradeSetup;
  ltp: number | null;
  changePct: number | null;
  support: Zone | null;
  resistance: Zone | null;
  optionSupport: StrikeInfo | null;
  optionResistance: StrikeInfo | null;
  rvol: number | null;
  rs: number | null;
  rsAccel: number | null;
  trend5m: Trend | null;
  futuresLabel: string | null;
  optionsLabel: string | null;
  status: DataStatus;
  momentum: Momentum;
  vwap: number | null;
  turnoverCr: number | null;
  fut: {
    ltp: number | null;
    oi: number | null;
    oiChange: number | null;
    oiChangePct: number | null;
    basis: number | null;
    expiry: string | null;
    buildup: Buildup | null;
  };
  explanation: Explanation;
  paused: boolean; // market closed / stale → suggestions frozen
  scannedAt: number;
}

// ================================================================== helpers

const nn = (x: number | null | undefined): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

const r2 = (x: number): number => Math.round(x * 100) / 100;
export const fmt = (x: number | null, d = 2): string => (x == null ? "N/A" : x.toFixed(d));

function scoreClamp(x: number): number {
  return Math.max(0, Math.min(100, x));
}

/** Combine sub-scores with weights, re-normalising when some are unavailable. */
function weightedScore(
  parts: Array<{ weight: number; score: number | null }>,
): number | null {
  let wSum = 0;
  let acc = 0;
  for (const p of parts) {
    if (p.score == null) continue;
    wSum += p.weight;
    acc += p.weight * p.score;
  }
  if (wSum <= 0) return null;
  return scoreClamp(acc / wSum);
}

function pct(a: number, b: number): number {
  return ((a - b) / b) * 100;
}

/** Return close of the candle at or before `targetTs`. */
function closeAt(candles: Candle[], targetTs: number): number | null {
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.t <= targetTs) best = c;
    else break;
  }
  return best ? best.c : null;
}

// ================================================================== STAGE 1

export interface Stage1Input {
  symbol: string;
  name: string | null;
  quote: Quote | null;
  futQuote: Quote | null;
  candles1m: Candle[] | null;
  volProfile: Map<number, number> | null; // minuteOfDay -> avg cumulative session volume
  nifty: NiftySnapshot | null;
  futOiBaseline: number | null;
  cfg: ScannerConfig;
  isOpen: boolean;
  nowMs: number;
}

export function computeStage1(inp: Stage1Input): Omit<Stage1Row, "momentum"> & { earlyDir: Direction | null } {
  const { cfg } = inp;
  const candles = inp.candles1m && inp.candles1m.length > 0 ? inp.candles1m : null;
  const lastCandle = candles ? candles[candles.length - 1] : null;

  const ltp = nn(inp.quote?.ltp) ?? (lastCandle ? lastCandle.c : null);
  const prevClose = nn(inp.quote?.prevClose);
  const open = nn(inp.quote?.open) ?? (candles ? candles[0].o : null);
  const changePct = ltp != null && prevClose != null && prevClose > 0 ? pct(ltp, prevClose) : null;

  // --- momentum windows from real 1-min bars
  let ret5m: number | null = null;
  let ret15m: number | null = null;
  let accel: number | null = null;
  if (candles && candles.length >= 7) {
    const tLast = candles[candles.length - 1].t;
    const c5 = closeAt(candles, tLast - 5 * 60_000);
    const c10 = closeAt(candles, tLast - 10 * 60_000);
    const c15 = closeAt(candles, tLast - 15 * 60_000);
    const cNow = candles[candles.length - 1].c;
    if (c5 && c5 > 0) ret5m = pct(cNow, c5);
    if (c15 && c15 > 0) ret15m = pct(cNow, c15);
    if (c5 && c10 && c10 > 0 && c5 > 0) accel = pct(cNow, c5) - pct(c5, c10);
  }

  // --- volume / liquidity
  const dayVolume =
    nn(inp.quote?.volume) ??
    (candles ? candles.reduce((a, c) => a + c.v, 0) : null);
  const turnoverCr = dayVolume != null && ltp != null ? (dayVolume * ltp) / 1e7 : null;
  const liquidityOk = turnoverCr != null ? turnoverCr >= cfg.minTurnoverCr : null;

  // --- RVOL (time-of-day adjusted)
  let rvol: number | null = null;
  if (dayVolume != null && inp.volProfile && lastCandle) {
    const minute = minuteOfDayIST(lastCandle.t);
    const expected = inp.volProfile.get(minute) ?? inp.volProfile.get(minuteOfDayIST(Date.now()));
    if (expected != null && expected > 0) rvol = r2(dayVolume / expected);
  }

  // --- relative strength vs NIFTY (session return vs NIFTY session return,
  //     both from real 1-min candles; falls back to quote day-change)
  let sessionRet: number | null = null;
  if (candles && candles.length >= 2) {
    const o = candles[0].o;
    const cLast = ltp ?? candles[candles.length - 1].c;
    if (o > 0 && cLast != null) sessionRet = pct(cLast, o);
  }
  let niftySessionRet: number | null = null;
  const ncArr = inp.nifty?.candles1m;
  if (ncArr && ncArr.length >= 2) {
    const no = ncArr[0].o;
    const nl = ncArr[ncArr.length - 1].c;
    if (no > 0) niftySessionRet = pct(nl, no);
  }
  const niftyChg = nn(inp.nifty?.changePct);
  const stockRet = sessionRet ?? changePct;
  const niftyRet = niftySessionRet ?? niftyChg;
  const rs = stockRet != null && niftyRet != null ? r2(stockRet - niftyRet) : null;

  // --- RS acceleration: RS now vs RS 15 minutes ago, candle-based
  let rsAccel: number | null = null;
  if (candles && candles.length >= 20 && inp.nifty?.candles1m && inp.nifty.candles1m.length >= 20) {
    const so = open;
    const nc = inp.nifty.candles1m;
    const no = nc[0].o;
    if (so && no) {
      const tLast = candles[candles.length - 1].t;
      const sNow = closeAt(candles, tLast);
      const sPrev = closeAt(candles, tLast - 15 * 60_000);
      const nNow = closeAt(nc, tLast);
      const nPrev = closeAt(nc, tLast - 15 * 60_000);
      if (sNow && sPrev && nNow && nPrev) {
        const rsNow = pct(sNow, so) - pct(nNow, no);
        const rsPrev = pct(sPrev, so) - pct(nPrev, no);
        rsAccel = r2(rsNow - rsPrev);
      }
    }
  }

  // --- VWAP (Upstox average trade price preferred; else candle-derived)
  const vwap = nn(inp.quote?.averagePrice) ?? (candles ? vwapFromCandles(candles) : null);
  const aboveVwap = ltp != null && vwap != null && vwap > 0 ? ltp > vwap : null;

  // --- 5-min trend structure
  let ema9v: number | null = null;
  let ema20v: number | null = null;
  let ema50v: number | null = null;
  let trend5m: Trend | null = null;
  let structure: Stage1Row["structure"] = null;
  if (candles && candles.length >= 40) {
    const c5 = resample(candles, 5);
    const closes = c5.map((c) => c.c);
    ema9v = lastEma(closes, 9);
    ema20v = lastEma(closes, 20);
    ema50v = lastEma(closes, 50);
    const sw = swings(c5, 2, 2);
    const hh = sw.highs.length >= 2 && sw.highs[sw.highs.length - 1].price > sw.highs[sw.highs.length - 2].price;
    const hl = sw.lows.length >= 2 && sw.lows[sw.lows.length - 1].price > sw.lows[sw.lows.length - 2].price;
    const lh = sw.highs.length >= 2 && sw.highs[sw.highs.length - 1].price < sw.highs[sw.highs.length - 2].price;
    const ll = sw.lows.length >= 2 && sw.lows[sw.lows.length - 1].price < sw.lows[sw.lows.length - 2].price;
    if (hh && hl) structure = "HH_HL";
    else if (lh && ll) structure = "LH_LL";
    else structure = "MIXED";
    const bullStack = ema9v != null && ema20v != null && ema9v > ema20v && (ema50v == null || ema20v > ema50v);
    const bearStack = ema9v != null && ema20v != null && ema9v < ema20v && (ema50v == null || ema20v < ema50v);
    const last5 = closes[closes.length - 1];
    if (bullStack && structure === "HH_HL" && (ema9v == null || last5 > ema9v * 0.999)) trend5m = "BULLISH";
    else if (bearStack && structure === "LH_LL" && (ema9v == null || last5 < ema9v * 1.001)) trend5m = "BEARISH";
    else if (bullStack) trend5m = aboveVwap === true ? "BULLISH" : "NEUTRAL";
    else if (bearStack) trend5m = aboveVwap === false ? "BEARISH" : "NEUTRAL";
    else trend5m = "NEUTRAL";
  }

  // --- futures confirmation (price + OI + volume together)
  const futLtp = nn(inp.futQuote?.ltp);
  const futPrev = nn(inp.futQuote?.prevClose);
  const futChangePct = futLtp != null && futPrev != null && futPrev > 0 ? pct(futLtp, futPrev) : null;
  const futOi = nn(inp.futQuote?.oi);
  const futOiChange =
    futOi != null && inp.futOiBaseline != null ? futOi - inp.futOiBaseline : null;
  const futOiChangePct =
    futOiChange != null && inp.futOiBaseline != null && inp.futOiBaseline > 0
      ? r2((futOiChange / inp.futOiBaseline) * 100)
      : null;
  const basis = futLtp != null && ltp != null ? r2(futLtp - ltp) : null;
  let buildup: Buildup | null = null;
  if (futChangePct != null && futOiChange != null) {
    const pUp = futChangePct > 0.05;
    const pDown = futChangePct < -0.05;
    const oiUp = futOiChange > 0;
    if (Math.abs(futOiChange) > 0 && (pUp || pDown)) {
      if (pUp && oiUp) buildup = "LONG_BUILDUP";
      else if (pDown && oiUp) buildup = "SHORT_BUILDUP";
      else if (pUp && !oiUp) buildup = "SHORT_COVERING";
      else if (pDown && !oiUp) buildup = "LONG_UNWINDING";
      else buildup = "NONE";
    } else buildup = "NONE";
  }

  // --- data status
  let status: DataStatus = "UNAVAILABLE";
  if (ltp != null) {
    const age = inp.quote?.ts != null ? inp.nowMs - inp.quote.ts : 0;
    if (!inp.isOpen) status = candles ? "STALE" : "PARTIAL";
    else if (age != null && age >= 0 && age < 60_000) status = candles ? "LIVE" : "PARTIAL";
    else if (age != null && age >= 0 && age < 5 * 60_000) status = "RECENT";
    else status = "STALE";
  }

  // --- sub-scores (0-100); null when the underlying data is unavailable
  const rvolScore =
    rvol != null ? scoreClamp(((rvol - 1) / Math.max(0.0001, cfg.rvolHigh - 1)) * 100) : null;
  const longRsScore = rs != null ? scoreClamp(((rs + 1) / (cfg.rsHigh + 1)) * 100) : null;
  const shortRsScore = rs != null ? scoreClamp(((1 - rs) / (cfg.rsHigh + 1)) * 100) : null;
  const longAccelScore = rsAccel != null ? scoreClamp(50 + rsAccel * 66) : null;
  const shortAccelScore = rsAccel != null ? scoreClamp(50 - rsAccel * 66) : null;
  const longTrendScore = trend5m != null ? (trend5m === "BULLISH" ? 100 : trend5m === "NEUTRAL" ? 45 : 0) : null;
  const shortTrendScore = trend5m != null ? (trend5m === "BEARISH" ? 100 : trend5m === "NEUTRAL" ? 45 : 0) : null;
  const longVwapScore = aboveVwap != null ? (aboveVwap ? 100 : 20) : null;
  const shortVwapScore = aboveVwap != null ? (aboveVwap ? 20 : 100) : null;
  const futLongScore =
    buildup != null
      ? buildup === "LONG_BUILDUP"
        ? 100
        : buildup === "SHORT_COVERING"
          ? 65
          : buildup === "LONG_UNWINDING"
            ? 15
            : buildup === "SHORT_BUILDUP"
              ? 0
              : 50
      : null;
  const futShortScore =
    buildup != null
      ? buildup === "SHORT_BUILDUP"
        ? 100
        : buildup === "LONG_UNWINDING"
          ? 65
          : buildup === "SHORT_COVERING"
            ? 15
            : buildup === "LONG_BUILDUP"
              ? 0
              : 50
      : null;
  const liqScore =
    turnoverCr != null ? scoreClamp((Math.log10(1 + turnoverCr) / Math.log10(1 + cfg.minTurnoverCr * 40)) * 100) : null;

  const w = cfg.stage1Weights;
  const scoreLong = weightedScore([
    { weight: w.rvol, score: rvolScore },
    { weight: w.relativeStrength, score: longRsScore },
    { weight: w.rsAcceleration, score: longAccelScore },
    { weight: w.trend5m, score: longTrendScore },
    { weight: w.vwap, score: longVwapScore },
    { weight: w.futures, score: futLongScore },
    { weight: w.liquidity, score: liqScore },
  ]);
  const scoreShort = weightedScore([
    { weight: w.rvol, score: rvolScore },
    { weight: w.relativeStrength, score: shortRsScore },
    { weight: w.rsAcceleration, score: shortAccelScore },
    { weight: w.trend5m, score: shortTrendScore },
    { weight: w.vwap, score: shortVwapScore },
    { weight: w.futures, score: futShortScore },
    { weight: w.liquidity, score: liqScore },
  ]);

  let dir: Direction | null = null;
  if (scoreLong != null && scoreShort != null) dir = scoreLong >= scoreShort ? "LONG" : "SHORT";
  const score = dir === "LONG" ? scoreLong : scoreShort;

  // --- EARLY momentum flags (1-minute detection)
  const flags: string[] = [];
  if (rvol != null && rvol >= cfg.rvolMin) flags.push("RVOL↑");
  if (rs != null && rs > 0) flags.push("RS+");
  if (rs != null && rs < 0) flags.push("RS-");
  if (rsAccel != null && rsAccel > 0.1) flags.push("ACC↑");
  if (rsAccel != null && rsAccel < -0.1) flags.push("ACC↓");
  if (aboveVwap === true) flags.push(">VWAP");
  if (aboveVwap === false) flags.push("<VWAP");

  let earlyDir: Direction | null = null;
  const earlyLong =
    rvol != null &&
    rvol >= cfg.rvolMin &&
    rs != null &&
    rs > 0 &&
    (rsAccel == null || rsAccel > 0) &&
    aboveVwap === true &&
    (ret5m == null || ret5m > 0);
  const earlyShort =
    rvol != null &&
    rvol >= cfg.rvolMin &&
    rs != null &&
    rs < 0 &&
    (rsAccel == null || rsAccel < 0) &&
    aboveVwap === false &&
    (ret5m == null || ret5m < 0);
  if (earlyLong && !earlyShort) earlyDir = "LONG";
  else if (earlyShort && !earlyLong) earlyDir = "SHORT";

  return {
    symbol: inp.symbol,
    name: inp.name,
    ltp,
    prevClose,
    open,
    changePct: changePct != null ? r2(changePct) : null,
    ret5m: ret5m != null ? r2(ret5m) : null,
    ret15m: ret15m != null ? r2(ret15m) : null,
    accel: accel != null ? r2(accel) : null,
    volume: dayVolume,
    turnoverCr: turnoverCr != null ? r2(turnoverCr) : null,
    rvol,
    rs,
    rsAccel,
    sectorRs: null, // sector index data is not provided by Upstox → N/A
    vwap: vwap != null ? r2(vwap) : null,
    aboveVwap,
    ema9: ema9v != null ? r2(ema9v) : null,
    ema20: ema20v != null ? r2(ema20v) : null,
    ema50: ema50v != null ? r2(ema50v) : null,
    trend5m,
    structure,
    futLtp,
    futChangePct: futChangePct != null ? r2(futChangePct) : null,
    futOi,
    futOiChange,
    futOiChangePct,
    basis,
    buildup,
    liquidityOk,
    scoreLong: scoreLong != null ? r2(scoreLong) : null,
    scoreShort: scoreShort != null ? r2(scoreShort) : null,
    dir,
    score: score != null ? r2(score) : null,
    status,
    flags,
    scannedAt: Date.now(),
    earlyDir,
  };
}

// ================================================================== STAGE 2 — levels

const KIND_WEIGHT: Record<LevelKind, number> = {
  PDH: 16,
  PDL: 16,
  PDC: 10,
  OPEN: 8,
  ORH: 10,
  ORL: 10,
  SWING_H: 8,
  SWING_L: 8,
  CONSOL: 10,
  VWAP: 12,
  CE_OI: 0,
  PE_OI: 0,
};

export interface DeepInputs {
  ltp: number;
  candles1m: Candle[];
  candles5m: Candle[];
  prevDay: Candle | null;
  vwap: number | null;
  chain: ChainStrike[] | null;
  chainOiBaseline: Map<number, { ce: number | null; pe: number | null }> | null;
  chainExpiry: string | null;
}

function strikeScores(
  chain: ChainStrike[] | null,
  spot: number,
  windowPct: number,
  baseline: Map<number, { ce: number | null; pe: number | null }> | null,
): { ce: StrikeInfo[]; pe: StrikeInfo[] } {
  const empty = { ce: [] as StrikeInfo[], pe: [] as StrikeInfo[] };
  if (!chain || chain.length === 0 || !(spot > 0)) return empty;
  const win = chain.filter(
    (s) => Math.abs(s.strike - spot) / spot <= windowPct / 100,
  );
  if (win.length === 0) return empty;
  const maxCeOi = Math.max(...win.map((s) => s.ceOi ?? 0), 1);
  const maxPeOi = Math.max(...win.map((s) => s.peOi ?? 0), 1);
  const maxCeVol = Math.max(...win.map((s) => s.ceVol ?? 0), 1);
  const maxPeVol = Math.max(...win.map((s) => s.peVol ?? 0), 1);
  let maxCeChg = 1;
  let maxPeChg = 1;
  if (baseline) {
    for (const s of win) {
      const b = baseline.get(s.strike);
      if (!b) continue;
      if (s.ceOi != null && b.ce != null) maxCeChg = Math.max(maxCeChg, Math.abs(s.ceOi - b.ce));
      if (s.peOi != null && b.pe != null) maxPeChg = Math.max(maxPeChg, Math.abs(s.peOi - b.pe));
    }
  }

  const build = (side: "ce" | "pe"): StrikeInfo[] => {
    return win.map((s, i) => {
      const oi = side === "ce" ? s.ceOi : s.peOi;
      const vol = side === "ce" ? s.ceVol : s.peVol;
      const maxOi = side === "ce" ? maxCeOi : maxPeOi;
      const maxVol = side === "ce" ? maxCeVol : maxPeVol;
      const neighbors: number[] = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(win.length - 1, i + 2); j++) {
        if (j === i) continue;
        const noi = side === "ce" ? win[j].ceOi : win[j].peOi;
        if (noi != null) neighbors.push(noi);
      }
      const avgN = neighbors.length ? neighbors.reduce((a, b) => a + b, 0) / neighbors.length : 0;
      const share = oi != null ? oi / maxOi : 0;
      const concentration = avgN > 0 && oi != null ? oi / avgN : 1;
      let oiChg: number | null = null;
      const b = baseline?.get(s.strike);
      if (b) {
        const bb = side === "ce" ? b.ce : b.pe;
        if (oi != null && bb != null) oiChg = oi - bb;
      }
      const maxChg = side === "ce" ? maxCeChg : maxPeChg;
      const dist = Math.abs(s.strike - spot) / spot;
      const distScore = dist <= 0.005 ? 10 : dist <= 0.01 ? 8 : dist <= 0.02 ? 5 : dist <= 0.05 ? 2 : 0;
      const score = scoreClamp(
        share * 45 +
          Math.min(1, Math.max(0, (concentration - 1) / 1.5)) * 15 +
          (vol != null ? (vol / maxVol) * 15 : 0) +
          (oiChg != null ? (Math.abs(oiChg) / maxChg) * 15 : 0) +
          distScore,
      );
      return { strike: s.strike, score: r2(score), oi, oiChg, vol, share: r2(share * 100) / 100, concentration: r2(concentration * 100) / 100 };
    });
  };

  const ce = build("ce").sort((a, b) => b.score - a.score);
  const pe = build("pe").sort((a, b) => b.score - a.score);
  return { ce, pe };
}

export function buildLevels(inp: DeepInputs, cfg: ScannerConfig): LevelsResult {
  const spot = inp.ltp;
  const atr5 = atr(inp.candles5m, 14);
  const tol = Math.max((spot * cfg.zoneTolerancePct) / 100, atr5 != null ? atr5 * 0.5 : spot * 0.002);

  const sources: ZoneSource[] = [];
  const push = (kind: LevelKind, price: number | null, extra?: Partial<ZoneSource>) => {
    if (price == null || !(price > 0)) return;
    sources.push({
      kind,
      price,
      oi: extra?.oi ?? null,
      oiChg: extra?.oiChg ?? null,
      optVol: extra?.optVol ?? null,
      share: extra?.share ?? null,
      strikeScore: extra?.strikeScore ?? null,
    });
  };

  // ---- previous day levels
  if (inp.prevDay) {
    push("PDH", inp.prevDay.h);
    push("PDL", inp.prevDay.l);
    push("PDC", inp.prevDay.c);
  }

  // ---- opening structure
  if (inp.candles1m.length > 0) {
    push("OPEN", inp.candles1m[0].o);
    const orEnd = inp.candles1m[0].t + cfg.openingRangeMinutes * 60_000;
    const orBars = inp.candles1m.filter((c) => c.t <= orEnd);
    if (orBars.length >= Math.min(5, cfg.openingRangeMinutes)) {
      push("ORH", Math.max(...orBars.map((c) => c.h)));
      push("ORL", Math.min(...orBars.map((c) => c.l)));
    }
  }

  // ---- intraday swings (5-min fractals)
  const sw = swings(inp.candles5m, 2, 2);
  for (const s of sw.highs.slice(-6)) push("SWING_H", s.price);
  for (const s of sw.lows.slice(-6)) push("SWING_L", s.price);

  // ---- consolidation / volume-at-price zones
  const consol = consolidationZones(inp.candles1m, 0.25)
    .sort((a, b) => b.timeCount - a.timeCount)
    .slice(0, 3);
  const totalV = inp.candles1m.reduce((a, c) => a + c.v, 0);
  for (const z of consol) {
    push("CONSOL", z.mid, { share: totalV > 0 ? z.volume / totalV : null });
  }

  // ---- VWAP
  push("VWAP", inp.vwap);

  // ---- option chain strikes
  const { ce, pe } = strikeScores(inp.chain, spot, cfg.chainWindowPct, inp.chainOiBaseline);
  for (const info of ce.slice(0, 3)) {
    push("CE_OI", info.strike, { oi: info.oi, oiChg: info.oiChg, optVol: info.vol, share: info.share, strikeScore: info.score });
  }
  for (const info of pe.slice(0, 3)) {
    push("PE_OI", info.strike, { oi: info.oi, oiChg: info.oiChg, optVol: info.vol, share: info.share, strikeScore: info.score });
  }

  // ---- cluster into zones
  const sorted = [...sources].sort((a, b) => a.price - b.price);
  const clusters: ZoneSource[][] = [];
  for (const s of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur) {
      const cMax = Math.max(...cur.map((x) => x.price));
      const cMin = Math.min(...cur.map((x) => x.price));
      const mid = (cMax + cMin) / 2;
      if (Math.max(s.price, cMax) - Math.min(s.price, cMin) <= tol * 2) {
        cur.push(s);
        void mid;
        continue;
      }
    }
    clusters.push([s]);
  }

  const now = Date.now();
  const zones: Zone[] = [];
  for (let zi = 0; zi < clusters.length; zi++) {
    const cl = clusters[zi];
    const low = Math.min(...cl.map((s) => s.price));
    const high = Math.max(...cl.map((s) => s.price));
    const mid = (low + high) / 2;
    const kinds = [...new Set(cl.map((s) => s.kind))];
    const { touches, lastTouchT } = countTouches(inp.candles1m, mid, cfg.zoneTolerancePct / 2);

    // option part
    const optSources = cl.filter((s) => s.kind === "CE_OI" || s.kind === "PE_OI");
    const bestOpt = optSources.reduce<ZoneSource | null>(
      (acc, s) => (acc == null || (s.strikeScore ?? 0) > (acc.strikeScore ?? 0) ? s : acc),
      null,
    );

    // structure part (distinct kinds only)
    const structPart = Math.min(
      35,
      kinds.filter((k) => k !== "CE_OI" && k !== "PE_OI").reduce((a, k) => a + KIND_WEIGHT[k], 0),
    );
    const touchPart = Math.min(20, touches * 5);
    const optPart = Math.min(
      25,
      bestOpt?.strikeScore != null ? bestOpt.strikeScore * 0.25 : 0,
    );
    const consolSrc = cl.find((s) => s.kind === "CONSOL");
    const volPart = Math.min(10, (consolSrc?.share ?? 0) * 60);

    // breakout / acceptance detection on 5-min closes
    let firstAbove = -1;
    let firstBelow = -1;
    for (let i = 0; i < inp.candles5m.length; i++) {
      const c = inp.candles5m[i];
      if (firstAbove < 0 && c.c > high) firstAbove = i;
      if (firstBelow < 0 && c.c < low) firstBelow = i;
    }
    const closes = inp.candles5m.map((c) => c.c);
    const lastC = closes[closes.length - 1] ?? spot;
    const recent = inp.candles5m.slice(-10);
    let acceptedAbove = false;
    let acceptedBelow = false;
    if (firstAbove >= 0) {
      const after = closes.slice(firstAbove);
      acceptedAbove = after.filter((c) => c > high).length >= 2 && lastC > mid;
    }
    if (firstBelow >= 0) {
      const after = closes.slice(firstBelow);
      acceptedBelow = after.filter((c) => c < low).length >= 2 && lastC < mid;
    }
    let retested = false;
    if (firstAbove >= 0) {
      for (const c of recent) {
        if (c.l <= mid && c.c >= mid) retested = true;
      }
    }
    if (firstBelow >= 0) {
      for (const c of recent) {
        if (c.h >= mid && c.c <= mid) retested = true;
      }
    }

    const recencyPart =
      lastTouchT != null
        ? now - lastTouchT < 20 * 60_000
          ? 8
          : now - lastTouchT < 60 * 60_000
            ? 5
            : 2
        : 0;
    const breakoutPart = (acceptedAbove || acceptedBelow ? 6 : 0) + (retested ? 4 : 0);

    const strength = scoreClamp(structPart + touchPart + optPart + volPart + recencyPart + breakoutPart);

    const optLabel = bestOpt
      ? `${bestOpt.kind === "CE_OI" ? "CE" : "PE"} OI ${bestOpt.oi != null ? compactNum(bestOpt.oi) : "N/A"} @ ${trimNum(bestOpt.price)}`
      : null;

    zones.push({
      id: `z${zi}`,
      low: r2(low),
      high: r2(high),
      mid: r2(mid),
      kinds,
      sources: cl,
      touches,
      lastTouchAgoMin: lastTouchT != null ? Math.round((now - lastTouchT) / 60000) : null,
      strength: Math.round(strength),
      hasOption: optSources.length > 0,
      optionLabel: optLabel,
      acceptedAbove,
      acceptedBelow,
      flipped: acceptedAbove ? "UP" : acceptedBelow ? "DOWN" : null,
      retested,
      side: mid >= spot ? "RESISTANCE" : "SUPPORT",
      distancePct: r2(Math.abs(mid - spot) / spot * 100),
    });
  }

  const supports = zones
    .filter((z) => z.mid < spot)
    .sort((a, b) => b.strength * decay(b.distancePct) - a.strength * decay(a.distancePct));
  const resistances = zones
    .filter((z) => z.mid >= spot)
    .sort((a, b) => b.strength * decay(b.distancePct) - a.strength * decay(a.distancePct));

  // option-only S/R: top scored strikes near spot on each side
  const optionResistance = ce.find((s) => s.strike >= spot) ?? ce[0] ?? null;
  const optionSupport = pe.filter((s) => s.strike < spot).sort((a, b) => b.strike - a.strike)[0] ?? pe[0] ?? null;

  return {
    zones: zones.sort((a, b) => a.low - b.low),
    supports,
    resistances,
    optionSupport,
    optionResistance,
    chainExpiry: inp.chainExpiry,
    maxCeOi: ce[0] ?? null,
    maxPeOi: pe[0] ?? null,
  };
}

function decay(distPct: number): number {
  return 1 / (1 + distPct * 0.9);
}

export function compactNum(n: number): string {
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export function trimNum(n: number): string {
  return n % 1 === 0 ? n.toLocaleString("en-IN") : n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// ================================================================== STAGE 2 — setups

export function buildSetup(
  dir: Direction,
  ltp: number,
  levels: LevelsResult,
  cfg: ScannerConfig,
): TradeSetup {
  const reasons: string[] = [];
  const buf = cfg.breakoutBufferBps / 10_000;
  const slBuf = cfg.slBufferBps / 10_000;

  const empty: TradeSetup = {
    state: "NO_TRADE",
    direction: dir,
    entryLow: null,
    entryHigh: null,
    entryType: null,
    stop: null,
    stopBasis: null,
    t1: null,
    t2: null,
    t3: null,
    risk: null,
    rr1: null,
    rr2: null,
    rrOk: null,
    reasons,
    insufficientData: false,
  };

  const strong = (z: Zone) => z.strength >= cfg.levelMinStrength;
  const supports = levels.supports.filter(strong);
  const resistances = levels.resistances.filter(strong);

  if (supports.length === 0 && resistances.length === 0) {
    empty.reasons.push("INSUFFICIENT DATA — no dynamic S/R zones identified");
    empty.insufficientData = true;
    return empty;
  }

  const S = supports[0] ?? null; // nearest strong support (strength×distance ranked)
  const R = resistances[0] ?? null;

  const pickTargets = (list: Zone[], entry: number, above: boolean): number[] => {
    return list
      .map((z) => z.mid)
      .filter((p) => (above ? p > entry * 1.001 : p < entry * 0.999))
      .sort((a, b) => (above ? a - b : b - a))
      .slice(0, 3);
  };

  const finalize = (
    state: SetupState,
    entry: number,
    entryLow: number,
    entryHigh: number,
    entryType: TradeSetup["entryType"],
    stop: number,
    stopBasis: string,
  ): TradeSetup => {
    const longSide = dir === "LONG";
    const targets = pickTargets(longSide ? resistances : supports, entry, longSide);
    const risk = longSide ? entry - stop : stop - entry;
    const rr1 = risk > 0 && targets[0] != null ? Math.abs(targets[0] - entry) / risk : null;
    const rr2 = risk > 0 && targets[1] != null ? Math.abs(targets[1] - entry) / risk : null;
    const rrOk = rr1 != null ? rr1 >= cfg.minRR : null;
    if (risk <= 0) {
      empty.reasons.push("Stop placement not beyond entry — structure invalid");
      return empty;
    }
    if (rr1 == null) {
      empty.reasons.push(`No measurable ${longSide ? "resistance" : "support"} beyond entry — cannot compute R:R`);
      empty.insufficientData = true;
      return empty;
    }
    if (rr1 < cfg.minRR) {
      empty.reasons.push(`R:R ${rr1.toFixed(1)} below required ${cfg.minRR.toFixed(1)}`);
      return empty;
    }
    return {
      state,
      direction: dir,
      entryLow: r2(entryLow),
      entryHigh: r2(entryHigh),
      entryType,
      stop: r2(stop),
      stopBasis,
      t1: targets[0] != null ? r2(targets[0]) : null,
      t2: targets[1] != null ? r2(targets[1]) : null,
      t3: targets[2] != null ? r2(targets[2]) : null,
      risk: r2(risk),
      rr1: rr1 != null ? r2(rr1) : null,
      rr2: rr2 != null ? r2(rr2) : null,
      rrOk,
      reasons,
      insufficientData: false,
    };
  };

  if (dir === "LONG") {
    // 1) retest of a broken resistance (flipped up + retest) → LONG at the shelf
    const flipped = levels.supports.find((z) => z.flipped === "UP");
    if (flipped && flipped.retested && spotNear(ltp, flipped.high, 0.6)) {
      const entry = flipped.high * (1 + buf);
      const stop = flipped.low * (1 - slBuf);
      return finalize("LONG", entry, flipped.mid, entry, "RETEST", stop, `broken resistance ₹${trimNum(flipped.low)}–₹${trimNum(flipped.high)} reclaimed as support`);
    }
    if (flipped && !flipped.retested) {
      const entry = flipped.high * (1 + buf);
      const stop = flipped.low * (1 - slBuf);
      return finalize("WAIT_FOR_RETEST", entry, flipped.mid, entry, "RETEST", stop, `retest shelf ₹${trimNum(flipped.low)}–₹${trimNum(flipped.high)}`);
    }
    // 2) parked under resistance → wait for breakout
    if (R && nearPct(ltp, R, cfg.breakoutProximityPct)) {
      const entry = R.high * (1 + buf);
      const stopBase = Math.max(R.low, S ? S.low : R.low);
      const stop = stopBase * (1 - slBuf);
      return finalize("WAIT_FOR_BREAKOUT", entry, R.mid, entry, "BREAKOUT", stop, `structure below breakout zone ₹${trimNum(stopBase)}`);
    }
    // 3) continuation above strong support
    if (S) {
      if (!R) {
        // clear air above — but need a measurable target; use 2R projection ONLY as T1? No: integrity — no synthetic target.
        const stop = S.low * (1 - slBuf);
        const risk = ltp - stop;
        if (risk > 0) {
          empty.reasons.push("INSUFFICIENT DATA — no resistance above to target");
          empty.insufficientData = true;
        }
        return empty;
      }
      const stop = S.low * (1 - slBuf);
      return finalize("LONG", ltp, Math.min(ltp, (S.high + ltp) / 2), ltp, "CONTINUATION", stop, `dynamic support ₹${trimNum(S.low)}–₹${trimNum(S.high)} (strength ${S.strength}/100)`);
    }
    empty.reasons.push("No strong dynamic support below price");
    return empty;
  }

  // SHORT — mirror
  const flippedDown = levels.resistances.find((z) => z.flipped === "DOWN");
  if (flippedDown && flippedDown.retested && spotNear(ltp, flippedDown.low, 0.6)) {
    const entry = flippedDown.low * (1 - buf);
    const stop = flippedDown.high * (1 + slBuf);
    return finalize("SHORT", entry, entry, flippedDown.mid, "RETEST", stop, `broken support ₹${trimNum(flippedDown.low)}–₹${trimNum(flippedDown.high)} flipped to resistance`);
  }
  if (flippedDown && !flippedDown.retested) {
    const entry = flippedDown.low * (1 - buf);
    const stop = flippedDown.high * (1 + slBuf);
    return finalize("WAIT_FOR_RETEST", entry, entry, flippedDown.low, "RETEST", stop, `retest lid ₹${trimNum(flippedDown.low)}–₹${trimNum(flippedDown.high)}`);
  }
  if (S && nearSupport(ltp, S, cfg.breakoutProximityPct)) {
    const entry = S.low * (1 - buf);
    const stopBase = Math.min(S.high, R ? R.high : S.high);
    const stop = stopBase * (1 + slBuf);
    return finalize("WAIT_FOR_BREAKDOWN", entry, entry, S.mid, "BREAKDOWN", stop, `structure above breakdown zone ₹${trimNum(stopBase)}`);
  }
  if (R) {
    if (!S) {
      empty.reasons.push("INSUFFICIENT DATA — no support below to target");
      empty.insufficientData = true;
      return empty;
    }
    const stop = R.high * (1 + slBuf);
    return finalize("SHORT", ltp, ltp, Math.max(ltp, (R.low + ltp) / 2), "CONTINUATION", stop, `dynamic resistance ₹${trimNum(R.low)}–₹${trimNum(R.high)} (strength ${R.strength}/100)`);
  }
  empty.reasons.push("No strong dynamic resistance above price");
  return empty;
}

function nearPct(ltp: number, z: Zone, pctRange: number): boolean {
  // price parked just under resistance
  return z.low >= ltp * 0.997 && ((z.low - ltp) / ltp) * 100 <= pctRange + 0.3;
}
function nearSupport(ltp: number, z: Zone, pctRange: number): boolean {
  return z.high <= ltp * 1.003 && ((ltp - z.high) / ltp) * 100 <= pctRange + 0.3;
}
function spotNear(ltp: number, price: number, pctRange: number): boolean {
  return Math.abs(ltp - price) / price <= pctRange / 100;
}

// ================================================================== STAGE 2 — final score + explanation

export function finalScore(
  row: Pick<Stage1Row, "rvol" | "rs" | "rsAccel" | "trend5m" | "buildup">,
  setup: TradeSetup,
  levels: LevelsResult,
  dir: Direction,
  cfg: ScannerConfig,
): number | null {
  const rvolScore = row.rvol != null ? scoreClamp(((row.rvol - 1) / Math.max(0.0001, cfg.rvolHigh - 1)) * 100) : null;
  const rsScore = row.rs != null ? scoreClamp(50 + (dir === "LONG" ? row.rs : -row.rs) * 25) : null;
  const accScore = row.rsAccel != null ? scoreClamp(50 + (dir === "LONG" ? row.rsAccel : -row.rsAccel) * 66) : null;
  const trendScore =
    row.trend5m != null
      ? (dir === "LONG" ? row.trend5m === "BULLISH" : row.trend5m === "BEARISH")
        ? 100
        : row.trend5m === "NEUTRAL"
          ? 40
          : 0
      : null;
  const usedZones = [setup.state.includes("BREAK") || setup.entryType === "BREAKOUT" || setup.entryType === "BREAKDOWN"
    ? levels.resistances[0]
    : levels.supports[0], dir === "LONG" ? levels.supports[0] : levels.resistances[0]]
    .filter(Boolean) as Zone[];
  const structScore = usedZones.length ? usedZones.reduce((a, z) => a + z.strength, 0) / usedZones.length : null;
  const srQuality = usedZones.length ? Math.min(100, usedZones.reduce((a, z) => a + z.strength, 0) / usedZones.length + (levels.zones.length >= 3 ? 10 : 0)) : null;
  const optConf =
    levels.optionSupport || levels.optionResistance
      ? Math.max(levels.optionSupport?.score ?? 0, levels.optionResistance?.score ?? 0) +
        (usedZones.some((z) => z.hasOption) ? 15 : 0)
      : null;
  const futScore =
    row.buildup != null
      ? dir === "LONG"
        ? row.buildup === "LONG_BUILDUP"
          ? 100
          : row.buildup === "SHORT_COVERING"
            ? 60
            : 20
        : row.buildup === "SHORT_BUILDUP"
          ? 100
          : row.buildup === "LONG_UNWINDING"
            ? 60
            : 20
      : null;
  const rrScore =
    setup.rr1 != null ? scoreClamp(((setup.rr1 - 1) / Math.max(0.0001, cfg.rrFullScore - 1)) * 100) : null;

  const w = cfg.stage2Weights;
  return weightedScore([
    { weight: w.priceStructure, score: structScore },
    { weight: w.rvol, score: rvolScore },
    { weight: w.relativeStrength, score: rsScore },
    { weight: w.rsAcceleration, score: accScore },
    { weight: w.srQuality, score: srQuality != null ? scoreClamp(srQuality) : null },
    { weight: w.optionConfluence, score: optConf != null ? scoreClamp(optConf) : null },
    { weight: w.futures, score: futScore },
    { weight: w.trend5m, score: trendScore },
    { weight: w.riskReward, score: rrScore },
  ]);
}

export function buildExplanation(
  symbol: string,
  dir: Direction,
  setup: TradeSetup,
  levels: LevelsResult,
  row: Pick<Stage1Row, "rvol" | "rs" | "rsAccel" | "trend5m" | "aboveVwap" | "buildup" | "futOiChangePct" | "ret5m" | "structure">,
): Explanation {
  const confirms: string[] = [];
  const invalidates: string[] = [];
  if (row.rvol != null) {
    if (row.rvol >= 1.5) confirms.push(`RVOL ${row.rvol.toFixed(1)}× time-of-day average volume`);
    else if (row.rvol < 1) invalidates.push(`RVOL only ${row.rvol.toFixed(2)}× — thin participation`);
  }
  if (row.rs != null) {
    if (dir === "LONG" && row.rs > 0) confirms.push(`outperforming NIFTY by +${row.rs.toFixed(2)}%`);
    else if (dir === "SHORT" && row.rs < 0) confirms.push(`underperforming NIFTY by ${row.rs.toFixed(2)}%`);
    else if (Math.abs(row.rs) > 0.3) invalidates.push(`RS ${row.rs >= 0 ? "+" : ""}${row.rs.toFixed(2)}% works against the direction`);
  }
  if (row.rsAccel != null) {
    if ((dir === "LONG" && row.rsAccel > 0.1) || (dir === "SHORT" && row.rsAccel < -0.1)) {
      confirms.push(`RS ${dir === "LONG" ? "accelerating" : "decaying"} (${row.rsAccel > 0 ? "+" : ""}${row.rsAccel.toFixed(2)} pts / 15 min)`);
    } else if ((dir === "LONG" && row.rsAccel < -0.2) || (dir === "SHORT" && row.rsAccel > 0.2)) {
      invalidates.push("relative strength is deteriorating");
    }
  }
  if (row.trend5m != null) {
    if ((dir === "LONG" && row.trend5m === "BULLISH") || (dir === "SHORT" && row.trend5m === "BEARISH")) {
      confirms.push(`5-minute trend ${row.trend5m.toLowerCase()} (${row.structure === "HH_HL" ? "higher highs / higher lows" : row.structure === "LH_LL" ? "lower highs / lower lows" : "EMA structure"})`);
    } else if (row.trend5m === "NEUTRAL") {
      invalidates.push("5-minute trend is not aligned");
    }
  }
  if (row.aboveVwap != null && ((dir === "LONG" && row.aboveVwap) || (dir === "SHORT" && !row.aboveVwap))) {
    confirms.push(`price ${row.aboveVwap ? "above" : "below"} VWAP`);
  }
  if (row.buildup && row.buildup !== "NONE") {
    const label =
      row.buildup === "LONG_BUILDUP" ? "long buildup" : row.buildup === "SHORT_BUILDUP" ? "short buildup" : row.buildup === "SHORT_COVERING" ? "short covering" : "long unwinding";
    const oiTxt = row.futOiChangePct != null ? ` (OI ${row.futOiChangePct > 0 ? "+" : ""}${row.futOiChangePct}%)` : "";
    const aligned = (dir === "LONG" && (row.buildup === "LONG_BUILDUP" || row.buildup === "SHORT_COVERING")) || (dir === "SHORT" && (row.buildup === "SHORT_BUILDUP" || row.buildup === "LONG_UNWINDING"));
    if (aligned) confirms.push(`futures show ${label}${oiTxt}`);
    else invalidates.push(`futures show ${label}${oiTxt} — contradicatory positioning`);
  }
  const optS = levels.optionSupport;
  const optR = levels.optionResistance;
  if (dir === "LONG" && optS?.oi != null) {
    confirms.push(`put writing base ${compactNum(optS.oi)} PE OI @ ${trimNum(optS.strike)}${optS.oiChg != null && optS.oiChg > 0 ? " (adding)" : ""}`);
  }
  if (dir === "SHORT" && optR?.oi != null) {
    confirms.push(`call writing ${compactNum(optR.oi)} CE OI @ ${trimNum(optR.strike)}${optR.oiChg != null && optR.oiChg > 0 ? " (adding)" : ""}`);
  }
  if (dir === "LONG" && optR != null && levels.resistances[0] && Math.abs(optR.strike - levels.resistances[0].mid) / levels.resistances[0].mid < 0.004) {
    confirms.push(`resistance zone overlaps the heaviest call strike ${trimNum(optR.strike)} — confluence`);
  }
  if (dir === "SHORT" && optS != null && levels.supports[0] && Math.abs(optS.strike - levels.supports[0].mid) / levels.supports[0].mid < 0.004) {
    confirms.push(`support zone overlaps the heaviest put strike ${trimNum(optS.strike)} — confluence`);
  }
  for (const r of setup.reasons) invalidates.push(r);

  const S = levels.supports[0];
  const R = levels.resistances[0];
  let headline: string;
  if (setup.state === "LONG" || setup.state === "SHORT") {
    headline = `${symbol} ${setup.state} — ${setup.entryType === "RETEST" ? "retest hold" : "continuation"} from ${dir === "LONG" && S ? `support ₹${trimNum(S.low)}–₹${trimNum(S.high)} (${S.strength}/100)` : dir === "SHORT" && R ? `resistance ₹${trimNum(R.low)}–₹${trimNum(R.high)} (${R.strength}/100)` : "dynamic structure"}.`;
  } else if (setup.state === "WAIT_FOR_BREAKOUT" && R) {
    headline = `${symbol} parked under resistance ₹${trimNum(R.low)}–₹${trimNum(R.high)} (${R.strength}/100) — breakout trigger armed.`;
  } else if (setup.state === "WAIT_FOR_BREAKDOWN" && S) {
    headline = `${symbol} sitting on support ₹${trimNum(S.low)}–₹${trimNum(S.high)} (${S.strength}/100) — breakdown trigger armed.`;
  } else if (setup.state === "WAIT_FOR_RETEST") {
    headline = `${symbol} broke the level — waiting for a successful retest before entry.`;
  } else {
    headline = `${symbol} filtered out — ${setup.reasons[0] ?? "structure does not support a quality trade"}.`;
  }

  let whyNow: string;
  switch (setup.entryType) {
    case "BREAKOUT":
      whyNow = `Price is compressing under ${trimNum(R?.high ?? 0)} after ${R?.touches ?? "N/A"} touches; a 5-min acceptance above the zone with volume completes the trigger at ₹${fmt(setup.entryHigh)}.`;
      break;
    case "BREAKDOWN":
      whyNow = `Price is pressing into ${trimNum(S?.low ?? 0)} after ${S?.touches ?? "N/A"} touches; a 5-min acceptance below the zone completes the trigger at ₹${fmt(setup.entryLow)}.`;
      break;
    case "RETEST":
      whyNow = "The level already broke and price is revisiting it; order-flow acceptance at the shelf is the live trigger.";
      break;
    case "CONTINUATION":
      whyNow = `Directional flow is already established (5-min ret ${row.ret5m != null ? `${row.ret5m > 0 ? "+" : ""}${row.ret5m}%` : "n/a"}) and next measured objective offers ≥ ${setup.rr1 != null ? setup.rr1.toFixed(1) : "?"}R.`;
      break;
    default:
      whyNow = "No immediate trigger — waiting for structure.";
  }

  if (setup.stop != null) {
    invalidates.unshift(
      `5-min close ${dir === "LONG" ? "below" : "above"} ₹${trimNum(setup.stop)}${setup.stopBasis ? ` — ${setup.stopBasis}` : ""}`,
    );
  }

  return {
    headline,
    whyNow,
    confirms: confirms.slice(0, 6),
    invalidates: invalidates.slice(0, 6),
  };
}

export function buildupLabel(b: Buildup | null): string | null {
  if (b == null) return null;
  return b === "LONG_BUILDUP"
    ? "Long buildup"
    : b === "SHORT_BUILDUP"
      ? "Short buildup"
      : b === "SHORT_COVERING"
        ? "Short covering"
        : b === "LONG_UNWINDING"
          ? "Long unwinding"
          : "Flat";
}
