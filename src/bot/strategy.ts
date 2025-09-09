/**
 * عند تسجيل صفقة شراء، احفظ سعر الدخول والهدف وأضف أمر بيع pending
 */
import { writeJsonFile } from './helpers';
import { extractTradeMeta } from '../utils/tradeMeta';
import { unifiedBuy, unifiedSell } from '../tradeSources';
import fs from 'fs';
const fsp = fs.promises;
import path from 'path';
// listener-only guard to avoid disk I/O in hot paths
const LISTENER_ONLY_MODE = String(process.env.LISTENER_ONLY_MODE ?? process.env.LISTENER_ONLY ?? 'true').toLowerCase() === 'true';

export async function registerBuyWithTarget(user: any, token: any, buyResult: any, targetPercent = 10) {
  // تأكد من وجود معرف المستخدم داخل الكائن
  const userId = user.id || user.userId || user.telegramId;
  if (!user.id && userId) user.id = userId;
  // إذا لم يوجد معرف، استخدم معرف من السياق أو المفتاح
  if (!user.id && typeof token === 'object' && token.userId) user.id = token.userId;
  // إذا لم يوجد معرف، حاول جلبه من السياق الخارجي (مثلاً من ctx)
  // إذا لم يوجد معرف بعد كل المحاولات، أوقف التنفيذ
  if (!user.id || user.id === 'undefined') {
    console.warn('[registerBuyWithTarget] Invalid userId, skipping trade record.');
    return;
  }
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  const userFile = path.join(sentTokensDir, `${userId}.json`);
  let userTrades: any[] = [];
  try {
    // In listener-only mode, prefer in-memory store; otherwise read from disk
    if (LISTENER_ONLY_MODE) {
      try {
        if (!(global as any).__inMemorySentTokens) (global as any).__inMemorySentTokens = new Map<string, any[]>();
        const store: Map<string, any[]> = (global as any).__inMemorySentTokens;
        userTrades = store.get(userId) || [];
      } catch (e) { userTrades = []; }
    } else {
      const stat = await fsp.stat(userFile).catch(() => false);
      if (stat) {
        const data = await fsp.readFile(userFile, 'utf8');
        userTrades = JSON.parse(data || '[]');
      }
    }
  } catch {}
  // تعريف نوع موحد للتداول
  type TradeEntry = {
    id: string;
    mode: 'buy' | 'sell';
    token: string;
    amount: number;
    tx?: string;
    entryPrice?: number;
    targetPercent?: number;
    targetPrice?: number;
    stopLossPercent?: number;
    stopLossPrice?: number;
    status: 'success' | 'fail' | 'pending';
    linkedBuyTx?: string;
    time: number;
    stage?: number | string;
    strategy?: any;
    note?: string;
    error?: string;
  fee?: number | null;
  slippage?: number | null;
    summary?: string;
  };

  // دالة توليد معرف فريد
  function genId() {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  const entryPrice = token.price || token.entryPrice || null;
  const amount = user.strategy.buyAmount || 0.01;
  const tx = buyResult?.tx;
  const { fee: buyFee, slippage: buySlippage } = extractTradeMeta(buyResult, 'buy');
  // سجل صفقة الشراء
  const buyTrade: TradeEntry = {
    id: genId(),
    mode: 'buy',
    token: token.address,
    amount,
    tx,
    entryPrice,
    time: Date.now(),
    status: tx ? 'success' : 'fail',
    strategy: { ...user.strategy },
  summary: `Buy ${token.address} | ${amount} SOL | ${tx ? 'Tx: ' + tx : 'No Tx'}`,
  fee: buyFee,
  slippage: buySlippage,
  };
  userTrades.push(buyTrade);

  // سجل أوامر البيع التلقائية (هدف1، هدف2، وقف خسارة)
  if (tx && entryPrice) {
    // هدف 1
    const target1 = user.strategy.target1 || 10;
    const sellPercent1 = user.strategy.sellPercent1 || 50;
    const targetPrice1 = entryPrice * (1 + target1 / 100);
    userTrades.push({
      id: genId(),
      mode: 'sell',
      token: token.address,
      amount: amount * (sellPercent1 / 100),
      entryPrice,
      targetPercent: target1,
      targetPrice: targetPrice1,
      status: 'pending',
      linkedBuyTx: tx,
      time: Date.now(),
      stage: 1,
      strategy: { ...user.strategy },
      summary: `AutoSell1 ${token.address} | ${sellPercent1}% | Target: ${targetPrice1}`,
    });
    // هدف 2
    const target2 = user.strategy.target2 || 20;
    const sellPercent2 = user.strategy.sellPercent2 || 50;
    const targetPrice2 = entryPrice * (1 + target2 / 100);
    userTrades.push({
      id: genId(),
      mode: 'sell',
      token: token.address,
      amount: amount * (sellPercent2 / 100),
      entryPrice,
      targetPercent: target2,
      targetPrice: targetPrice2,
      status: 'pending',
      linkedBuyTx: tx,
      time: Date.now(),
      stage: 2,
      strategy: { ...user.strategy },
      summary: `AutoSell2 ${token.address} | ${sellPercent2}% | Target: ${targetPrice2}`,
    });
    // وقف الخسارة
    const stopLoss = user.strategy.stopLoss;
    if (stopLoss && stopLoss > 0) {
      const stopLossPrice = entryPrice * (1 - stopLoss / 100);
      userTrades.push({
        id: genId(),
        mode: 'sell',
        token: token.address,
        amount: amount * ((100 - sellPercent1 - sellPercent2) / 100),
        entryPrice,
        stopLossPercent: stopLoss,
        stopLossPrice,
        status: 'pending',
        linkedBuyTx: tx,
        time: Date.now(),
        stage: 'stopLoss',
        strategy: { ...user.strategy },
        summary: `StopLoss ${token.address} | ${stopLoss}% | Price: ${stopLossPrice}`,
      });
    }
  }
  // persist trades using queued async writer. In listener-only mode, update in-memory store only.
  try {
    if (LISTENER_ONLY_MODE) {
      try {
        if (!(global as any).__inMemorySentTokens) (global as any).__inMemorySentTokens = new Map<string, any[]>();
        const store: Map<string, any[]> = (global as any).__inMemorySentTokens;
        store.set(userId, userTrades.slice(-500));
      } catch (e) {}
    } else {
      await writeJsonFile(userFile, userTrades).catch(() => {});
    }
  } catch {}
}
/**
 * مراقبة صفقات الشراء للمستخدم وتنفيذ البيع تلقائياً عند تحقق الشروط
 * @param user بيانات المستخدم
 * @param tokens قائمة العملات الحالية (مع الأسعار)
 * @param priceField اسم الحقل الذي يحتوي على السعر الحالي في token (مثلاً 'price')
 */
export async function monitorAndAutoSellTrades(user: any, tokens: any[], priceField = 'price') {
  const userId = user.id || user.userId || user.telegramId;
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  const userFile = path.join(sentTokensDir, `${userId}.json`);
  try {
    const stat = await fsp.stat(userFile).catch(() => false);
    if (!stat) return;
  } catch { return; }
  let userTrades: any[] = [];
  try { const data = await fsp.readFile(userFile, 'utf8'); userTrades = JSON.parse(data || '[]'); } catch {}
  // إيجاد أوامر البيع pending المرتبطة بصفقات شراء ناجحة
  const pendingSells = userTrades.filter(t => t.mode === 'sell' && t.status === 'pending' && t.linkedBuyTx);
  for (const sell of pendingSells) {
    const token = tokens.find(t => t.address === sell.token);
    if (!token || !token[priceField]) continue;
    const currentPrice = token[priceField];
    let shouldSell = false;
    // تحقق من أهداف الربح
    if (sell.targetPrice && currentPrice >= sell.targetPrice) shouldSell = true;
    // تحقق من وقف الخسارة
    if (sell.stopLossPrice && currentPrice <= sell.stopLossPrice) shouldSell = true;
    if (shouldSell) {
      try {
  const result = await unifiedSell(token.address, sell.amount, user.secret /*, { slippage: user.strategy.slippage }*/);
        const { fee, slippage } = extractTradeMeta(result, 'sell');
        // حدث حالة الأمر من pending إلى success
        sell.status = result?.tx ? 'success' : 'fail';
        sell.tx = result?.tx;
        sell.fee = fee;
        sell.slippage = slippage;
    sell.executedTime = Date.now();
  try { await writeJsonFile(userFile, userTrades); } catch {}
      } catch (e) {
        sell.status = 'fail';
        sell.error = (e instanceof Error ? e.message : String(e));
        sell.executedTime = Date.now();
  try { await writeJsonFile(userFile, userTrades); } catch {}
      }
    }
  }
}
// (imports consolidated at top)
/**
 * تنفيذ صفقات متعددة (شراء أو بيع) للمستخدم على قائمة عملات
 * @param user بيانات المستخدم
 * @param tokens قائمة العملات
 * @param mode 'buy' أو 'sell'
 * @param delayMs تأخير بين كل صفقة (ms)
 */
export async function executeBatchTradesForUser(user: any, tokens: any[], mode: 'buy' | 'sell' = 'buy', delayMs = 2000) {
  if (!user || !user.wallet || !user.secret || !user.strategy) return;
  const userId = user.id || user.userId || user.telegramId;
  const sentTokensDir = path.join(process.cwd(), 'sent_tokens');
  const userFile = path.join(sentTokensDir, `${userId}.json`);
  try { await fsp.mkdir(sentTokensDir, { recursive: true }); } catch {}
  let userTrades: any[] = [];
  try { const stat = await fsp.stat(userFile).catch(() => false); if (stat) { const data = await fsp.readFile(userFile, 'utf8'); userTrades = JSON.parse(data || '[]'); } } catch {}
  for (const token of tokens) {
    try {
      let result, amount, tx = null;
      if (mode === 'buy') {
        amount = user.strategy.buyAmount || 0.01;
        result = await unifiedBuy(token.address, amount, user.secret /*, { slippage }*/);
        tx = result?.tx;
      } else {
        const sellPercent = user.strategy.sellPercent1 || 100;
        const balance = token.balance || 0;
        amount = (balance * sellPercent) / 100;
        result = await unifiedSell(token.address, amount, user.secret /*, { slippage }*/);
        tx = result?.tx;
      }
      const { fee, slippage } = extractTradeMeta(result, mode);
      userTrades.push({
        mode,
        token: token.address,
        amount,
        tx,
        fee,
        slippage,
        time: Date.now(),
        status: tx ? 'success' : 'fail',
      });
  try { await writeJsonFile(userFile, userTrades); } catch {}
    } catch (e) {
      userTrades.push({
        mode,
        token: token.address,
        error: (e instanceof Error ? e.message : String(e)),
        time: Date.now(),
        status: 'fail',
      });
  try { await writeJsonFile(userFile, userTrades); } catch {}
    }
    if (delayMs > 0) await new Promise(res => setTimeout(res, delayMs));
  }
}
import type { Strategy } from './types';
import { HELIUS_BATCH_SIZE, HELIUS_BATCH_DELAY_MS, ONCHAIN_FRESHNESS_TIMEOUT_MS } from '../config';
import { autoFilterTokensVerbose } from '../utils/tokenUtils';

// Enrichment metrics for selective enrichment
const __strategy_enrich_metrics: { attempts: number; successes: number; failures: number; enrichedTokens: number } = { attempts: 0, successes: 0, failures: 0, enrichedTokens: 0 };

export function getStrategyEnrichMetrics() {
  return { ...__strategy_enrich_metrics };
}

/**
 * Filters a list of tokens based on the user's strategy settings.
 * All comments and variable names are in English for clarity.
 */
export async function filterTokensByStrategy(tokens: any[], strategy: Strategy, opts?: { preserveSources?: boolean, fastOnly?: boolean }): Promise<any[]> {
  if (!strategy || !Array.isArray(tokens)) return [];
  // If the caller passed tokens that look like they originate from the listener
  // (they contain a sourceProgram field), prefer preserving those sources so
  // we don't merge arbitrary realtime candidates into the caller-supplied list.
  try {
    if (!opts) opts = {};
    if (opts.preserveSources === undefined && tokens.length > 0) {
      const allHaveSource = tokens.every(t => t && (t.sourceProgram || t.sourceSignature));
      if (allHaveSource) opts.preserveSources = true;
    }
  } catch (e) {}
  // If caller requested to preserve sources (listener path) and the strategy has no
  // numeric constraints (minMarketCap/minLiquidity/minVolume/minAge are all zero/undefined),
  // treat listener-provided tokens as authoritative and bypass further filtering/enrichment.
  try {
    // Treat small numeric minAge (0/1/2) as seconds (not minutes) and do not
    // consider them a "numeric constraint" for the purposes of bypassing the
    // listener-preserve fast path. Any minAge > 2 (or non-numeric/string values)
    // is considered a numeric constraint.
    const numericKeys = ['minMarketCap', 'minLiquidity', 'minVolume'];
    const hasOtherNumericConstraint = numericKeys.some(k => {
      const v = (strategy as any)?.[k];
      return v !== undefined && v !== null && Number(v) > 0;
    });
    let maxAgeIsConstraint = false;
    try {
      const ma = (strategy as any)?.maxAgeSec ?? (strategy as any)?.minAge;
      if (ma !== undefined && ma !== null) {
        const num = Number(ma);
        if (!isNaN(num) && num > 0) maxAgeIsConstraint = true;
      }
    } catch (e) {}
    const hasNumericConstraint = hasOtherNumericConstraint || maxAgeIsConstraint;
    if ((opts && opts.preserveSources) && !hasNumericConstraint) {
      const looksLikeListener = tokens.length > 0 && tokens.every(t => t && (t.sourceProgram || t.sourceSignature || t.sourceCandidates || (t.sourceTags && Array.isArray(t.sourceTags) && t.sourceTags.some((s: string) => /helius|listener|ws|dexscreener/i.test(s) ))));
      if (looksLikeListener) {
        try { console.log('[filterTokensByStrategy] bypassing filter for listener-provided tokens (no numeric constraints)'); } catch(_) {}
        // Respect user's maxTrades when returning bypassed listener tokens.
        const maxTrades = strategy && (strategy as any).maxTrades ? Math.max(1, Number((strategy as any).maxTrades)) : undefined;
        return (typeof maxTrades === 'number') ? tokens.slice(0, maxTrades) : tokens.slice();
      }
    }

    // If caller requested to preserve sources but the only numeric constraint is minAge,
    // we can do a fast per-mint age check to avoid a full enrichment pass. This keeps
    // listener speed while honoring per-user second-level minAge requirements.
      try {
      if ((opts && opts.preserveSources) && !hasOtherNumericConstraint) {
  const maRaw = (strategy as any)?.maxAgeSec ?? (strategy as any)?.minAge;
  const maxAgeSeconds = maRaw !== undefined && maRaw !== null ? Number(maRaw) : undefined;
  // interpret provided age as seconds (maximum allowed age)
  if (!isNaN(maxAgeSeconds) && maxAgeSeconds > 0) {
            // helper: normalize various timestamp representations to ms epoch
            const tsToMs = (v: any) => {
              try{
                const n = Number(v);
                if (!n || isNaN(n)) return null;
                // values > 1e12 are likely already ms epoch
                if (n > 1e12) return n;
                // values > 1e9 are likely epoch seconds -> convert to ms
                if (n > 1e9) return n * 1000;
                return null;
              }catch(e){return null;}
            };
          // Attempt to accept tokens quickly if they already have on-chain age fields
          const fastAccepted: any[] = [];
          const fastRejected: any[] = [];
          // prepare fast probe helper (prefer local fastTokenFetcher if available)
          let ff: any = null;
          try { ff = await import('../fastTokenFetcher'); } catch (e) { try { ff = require('../dist/src/fastTokenFetcher'); } catch(_) { ff = null; } }
          for (const tkn of tokens) {
            try {
              // prefer canonical/computed fields
              const ageKnown = (tkn && (tkn._canonicalAgeSeconds || tkn.ageSeconds || tkn.firstBlockTime || tkn.poolOpenTimeMs));
              if (ageKnown) {
                let ageSec = Number(tkn._canonicalAgeSeconds || tkn.ageSeconds || 0);
                if ((!ageSec || ageSec === 0) && tkn.firstBlockTime) {
                  const fbMs = tsToMs(tkn.firstBlockTime);
                  if (fbMs) ageSec = (Date.now() - fbMs) / 1000;
                }
                if ((!ageSec || ageSec === 0) && tkn.poolOpenTimeMs) ageSec = (Date.now() - Number(tkn.poolOpenTimeMs)) / 1000;
                if (!isNaN(ageSec) && ageSec <= maxAgeSeconds) {
                  fastAccepted.push(tkn);
                  continue;
                }
              }
              // if we have a fast fetcher, probe for first signature/blockTime
              if (ff && typeof ff.fetchFirstSignatureForMint === 'function') {
                const probe = await ff.fetchFirstSignatureForMint(tkn.tokenAddress || tkn.mint || tkn.address).catch(() => null);
                if (probe && probe.firstBlockTime) {
                  const fbMs = tsToMs(probe.firstBlockTime);
                  const ageSec = fbMs ? (Date.now() - fbMs) / 1000 : null;
                  // Accept tokens younger or equal than the maxAgeSeconds
                  if (ageSec !== null && ageSec <= maxAgeSeconds) { fastAccepted.push({...tkn, firstBlockTime: fbMs || probe.firstBlockTime, _canonicalAgeSeconds: ageSec}); continue; }
                  else { fastRejected.push(tkn); continue; }
                }
              }
              // fallback: keep token for full path (don't accept immediately)
              fastRejected.push(tkn);
            } catch (e) { fastRejected.push(tkn); }
          }
          // return accepted up to maxTrades. Per strict policy (Option B) we must
          // reject tokens that do not have a known on-chain age when minAgeSeconds > 0.
          const maxTrades = strategy && (strategy as any).maxTrades ? Math.max(1, Number((strategy as any).maxTrades)) : undefined;
          const res = (typeof maxTrades === 'number') ? fastAccepted.slice(0, maxTrades) : fastAccepted.slice();
          // Strict policy: always return the fastAccepted set (possibly empty) and do not
          // defer tokens lacking age info to full enrichment. This enforces minAge > 0
          // as a hard on-chain requirement.
          return res;
        }
      }
    } catch (e) {}
  } catch (e) {}
  // Integrated enrichment: attempt to enrich tokens with on-chain timestamps and freshness
  // using Helius (RPC/parse/websocket), Solscan and RPC fallbacks. This improves age
  // detection and allows downstream freshness scoring to be used in filters.
  // If caller requested a fast-only pass, skip merging realtime sources and any enrichment.
  // If caller passes opts.preserveSources = true, do NOT merge realtime sources
  if (tokens.length > 0 && !(opts && opts.fastOnly) && !(opts && opts.preserveSources)) {
    try {
      const utils = await import('../utils/tokenUtils');
      // Merge realtime sources (Helius WS buffer, DexScreener top, Helius parse-history) so filters
      // operate on a richer, corroborated set. Use existing fastTokenFetcher helper to gather latest candidates.
      try {
        const ff = await import('../fastTokenFetcher');
        const latest = await ff.fetchLatest5FromAllSources(10).catch(() => null);
        if (latest) {
          const extras: any[] = [];
          const pushAddr = (a: any) => { if (!a) return; const s = String(a); if (!s) return; extras.push({ address: s, tokenAddress: s, mint: s, sourceCandidates: true }); };
          (latest.heliusEvents || []).forEach(pushAddr);
          (latest.dexTop || []).forEach(pushAddr);
          (latest.heliusHistory || []).forEach(pushAddr);
          // merge extras into a local copy so we don't mutate caller's array
          const localTokens = tokens.slice();
          const seen = new Set(localTokens.map(t => (t.tokenAddress || t.address || t.mint || '').toString()));
          for (const ex of extras) {
            const key = ex.tokenAddress || ex.address || ex.mint || '';
            if (!key) continue;
            if (!seen.has(key)) {
              localTokens.push(ex);
              seen.add(key);
            }
          }
          tokens = localTokens;
          try { console.log('[filterTokensByStrategy] merged realtime sources; extraCandidates=', extras.length); } catch {}
        }
      } catch (e) {
        try { console.warn('[filterTokensByStrategy] failed to fetch realtime candidates', e && e.message ? e.message : e); } catch {}
      }

      const enrichPromise = utils.enrichTokenTimestamps(tokens, {
        batchSize: Number(HELIUS_BATCH_SIZE || 6),
        delayMs: Number(HELIUS_BATCH_DELAY_MS || 300)
      });
      // Start enrichment in background (non-blocking) so filtering remains responsive.
      // Log outcome for diagnostics but do not block the caller.
      enrichPromise
        .then(() => { try { console.log('[filterTokensByStrategy] background enrichment completed'); } catch (_) {} })
        .catch((err: any) => { try { console.warn('[filterTokensByStrategy] background enrichment failed:', err && err.message ? err.message : err); } catch (_) {} });
    } catch (e: any) {
      console.warn('[filterTokensByStrategy] enrichment failed or timed out:', e?.message || e);
    }
  }
  // Use helpers from tokenUtils for robust field extraction and fast filtering
  const utils = require('../utils/tokenUtils');
  const { getField, autoFilterTokens, parseDuration } = utils;

  // 1) Fast pass: use `autoFilterTokensVerbose` for the simple numeric checks (marketCap, liquidity, volume, basic age rules)
  const prelimVerbose = autoFilterTokensVerbose(tokens, strategy);
  const prelim = Array.isArray(prelimVerbose) ? prelimVerbose : (prelimVerbose && prelimVerbose.passed ? prelimVerbose.passed : tokens);

  // Selective enrichment: when the strategy requires strict numeric/on-chain checks,
  // enrich a small set of top candidates (bounded concurrency) to obtain liquidity/volume/age fields
  try {
  const needStrictNumeric = (strategy.minLiquidity !== undefined || strategy.minVolume !== undefined || (strategy as any).maxAgeSec !== undefined || strategy.minAge !== undefined || (strategy as any).requireOnchain === true);
  // If caller requested a fast-only pass, skip selective on-chain enrichment to remain responsive.
  if (!(opts && opts.fastOnly) && needStrictNumeric && Array.isArray(prelim) && prelim.length > 0) {
      const tu = require('../utils/tokenUtils');
      const candidateLimit = Number(process.env.STRATEGY_ENRICH_CANDIDATES || 8);
      const concurrency = Math.max(1, Number(process.env.STRATEGY_ENRICH_CONCURRENCY || 3));
      const timeoutMs = Number(process.env.STRATEGY_ENRICH_TIMEOUT_MS || 2000);
      const candidates = prelim.slice(0, Math.min(candidateLimit, prelim.length));
      // filter out tokens that are outside listener enrichment window
      const filteredCandidates = candidates.filter(t => !(t && t.enrichAllowed === false));
      const finalCandidates = filteredCandidates.length ? filteredCandidates : candidates;
      if (candidates.length) {
        let idx = 0;
          const worker = async () => {
          while (true) {
            const i = idx++;
            if (i >= candidates.length) break;
            const tok = candidates[i];
            try {
              __strategy_enrich_metrics.attempts++;
              // Skip heavy enrichment when token explicitly disallows enrichment (listener window expired)
              const tokenObj = tok as any;
              if (tokenObj && tokenObj.enrichAllowed === false) {
                // treat as skipped
                __strategy_enrich_metrics.failures++;
                continue;
              }
              // officialEnrich mutates the token in-place with poolOpenTimeMs, liquidity, volume, freshnessScore
              await tu.officialEnrich(tokenObj, { amountUsd: Number(strategy.buyAmount) || undefined, timeoutMs });
              // heuristics: consider enrichment successful if we obtained any of these fields
              if (tokenObj && (tokenObj.poolOpenTimeMs || tokenObj.liquidity || tokenObj.volume || tokenObj._canonicalAgeSeconds)) {
                __strategy_enrich_metrics.successes++;
                __strategy_enrich_metrics.enrichedTokens++;
              } else {
                __strategy_enrich_metrics.failures++;
              }
            } catch (e) {
              __strategy_enrich_metrics.failures++;
              // ignore per-token enrichment errors
            }
          }
        };
        const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker());
        try { await Promise.all(workers); } catch (e) {}
        // merge enriched candidates back into prelim by canonical address
        try {
          const keyOf = (t: any) => String(t && (t.tokenAddress || t.address || t.mint || '')).toLowerCase();
          const enrichedMap: Record<string, any> = {};
          for (const e of finalCandidates) {
            const k = keyOf(e);
            if (k) enrichedMap[k] = e;
          }
          for (let i = 0; i < prelim.length; i++) {
            try {
              const k = keyOf(prelim[i]);
              if (k && enrichedMap[k]) prelim[i] = enrichedMap[k];
            } catch (e) {}
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    // non-fatal: continue with existing prelim if enrichment fails
  }

  // 2) Apply the remaining, more expensive or strict checks on the pre-filtered list
  const filtered = prelim.filter(token => {
    // Price checks (optional)
    const price = Number(getField(token, 'priceUsd', 'price', 'priceNative', 'baseToken.priceUsd', 'baseToken.price')) || 0;
    if (strategy.minPrice !== undefined && price < strategy.minPrice) return false;
    if (strategy.maxPrice !== undefined && price > strategy.maxPrice) return false;

    // Holders check (may not be covered by autoFilterTokens depending on STRATEGY_FIELDS)
    const holders = Number(getField(token, 'holders', 'totalAmount', 'baseToken.holders', 'baseToken.totalAmount')) || 0;
    if (strategy.minHolders !== undefined && holders < strategy.minHolders) return false;

    // Age checks: compute age in seconds with no integer-flooring to preserve fractional minutes/seconds
  let ageSeconds: number | undefined = undefined;
    // Prefer capture-based age when available (listener capture time). This reflects "age since collectFreshMints".
    if (token && token.ageSinceCaptureSec !== undefined && token.ageSinceCaptureSec !== null) {
      ageSeconds = Number(token.ageSinceCaptureSec);
    } else if (token && token.collectedAtMs) {
      try {
        const collectedMs = Number(token.collectedAtMs);
        if (!isNaN(collectedMs) && collectedMs > 0) ageSeconds = (Date.now() - collectedMs) / 1000;
      } catch (e) { /* ignore */ }
    } else if (token && token._canonicalAgeSeconds !== undefined && token._canonicalAgeSeconds !== null) {
      ageSeconds = Number(token._canonicalAgeSeconds);
    }
    const ageVal = getField(token,
      'ageSeconds', 'ageMinutes', 'age', 'createdAt', 'created_at', 'creation_date', 'created',
      'poolOpenTime', 'poolOpenTimeMs', 'listed_at', 'listedAt', 'genesis_date', 'published_at',
      'time', 'timestamp', 'first_trade_time', 'baseToken.createdAt', 'baseToken.published_at'
    );
    if (ageVal !== undefined && ageVal !== null) {
      if (typeof ageVal === 'number') {
        if (ageVal > 1e12) { // ms timestamp
          ageSeconds = (Date.now() - ageVal) / 1000;
        } else if (ageVal > 1e9) { // s timestamp
          ageSeconds = (Date.now() - ageVal * 1000) / 1000;
      } else {
        // treat plain numeric age values as seconds (consistent input semantics)
        ageSeconds = Number(ageVal);
        }
      } else if (typeof ageVal === 'string') {
        // try numeric string
        const n = Number(ageVal);
        if (!isNaN(n)) {
          if (n > 1e9) ageSeconds = (Date.now() - n * 1000) / 1000;
          else ageSeconds = n; // numeric string treated as seconds
        } else {
          // try duration parse (parseDuration returns seconds)
          const parsed = parseDuration(ageVal);
          if (parsed !== undefined) ageSeconds = parsed;
          else {
            const parsedDate = Date.parse(ageVal);
            if (!isNaN(parsedDate)) ageSeconds = (Date.now() - parsedDate) / 1000;
          }
        }
      }
    } else if (typeof token.ageSeconds === 'number') {
      ageSeconds = token.ageSeconds;
    } else if (typeof token.ageMinutes === 'number') {
      ageSeconds = token.ageMinutes * 60;
    }

    // If strategy specifies a maximum allowed age (maxAgeSec), enforce it.
    // `maxAgeSec` is expected to be seconds. Reject tokens older than maxAgeSec.
    const maxAgeSec = (strategy as any)?.maxAgeSec !== undefined ? Number((strategy as any).maxAgeSec) : undefined;
    if (maxAgeSec !== undefined && !isNaN(maxAgeSec)) {
      if (ageSeconds === undefined || isNaN(ageSeconds)) {
        // Require known age when a maxAgeSec > 0 is requested (prefer capture-based age)
        if (maxAgeSec > 0) return false;
      } else {
        if (ageSeconds > maxAgeSec) return false;
      }
    }

    // Freshness / on-chain requirement checks
    try {
      const minFresh = (strategy as any)?.minFreshnessScore !== undefined ? Number((strategy as any).minFreshnessScore) : undefined;
      if (!isNaN(Number(minFresh)) && typeof token.freshnessScore === 'number') {
        if ((token.freshnessScore || 0) < Number(minFresh)) return false;
      }
      if ((strategy as any)?.requireOnchain) {
        const onChainTs = token?.freshnessDetails?.onChainTs || token?.freshnessDetails?.firstTxMs || null;
        if (!onChainTs) return false;
      }
    } catch (e) {
      // ignore scoring errors and proceed
    }

    // Enforce strict onlyReal tokens when requested by strategy
    if ((strategy as any)?.onlyReal === true) {
      const hasOnchain = !!(token?.freshnessDetails?.onChainTs || token?.freshnessDetails?.firstTxMs || token.poolOpenTimeMs || token.firstBlockTime || token.metadataExists);
      // If no on-chain evidence or metadata, reject as likely noise/memo
      if (!hasOnchain) return false;
    }

    // Verification
    const verified = getField(token, 'verified', 'baseToken.verified') === true || getField(token, 'verified', 'baseToken.verified') === 'true';
    if (strategy.onlyVerified === true && !verified) return false;

    // Strategy enabled check
    if (strategy.enabled === false) return false;

    return true;
  });
  return filtered;
}