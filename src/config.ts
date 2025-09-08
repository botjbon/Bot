import dotenv from 'dotenv';
dotenv.config();

// Centralized config & env parsing for the project.
// Export well-typed constants and helpers so other modules don't read process.env directly.
import { Connection } from "@solana/web3.js";

export const BIRDEYE_API_URL = process.env.BIRDEYE_API_URL || "https://public-api.birdeye.so/defi/price";
export const REQUEST_HEADER = { accept: "application/json", "x-api-key": process.env.BIRDEYE_API_KEY || "" };

export const DEXSCREENER_API_TYPE = process.env.DEXSCREENER_API_TYPE || "boosts";
export const DEXSCREENER_API_ENDPOINT_BOOSTS = process.env.DEXSCREENER_API_ENDPOINT_BOOSTS;
export const DEXSCREENER_API_ENDPOINT_SEARCH = process.env.DEXSCREENER_API_ENDPOINT_SEARCH;
export const DEXSCREENER_API_ENDPOINT_TOKEN_PAIRS = process.env.DEXSCREENER_API_ENDPOINT_TOKEN_PAIRS;
export const DEXSCREENER_API_ENDPOINT_PAIR_DETAILS = process.env.DEXSCREENER_API_ENDPOINT_PAIR_DETAILS;
export const DEXSCREENER_API_ENDPOINT_ORDERS = process.env.DEXSCREENER_API_ENDPOINT_ORDERS;
export const DEXSCREENER_API_ENDPOINT_BOOSTS_TOP = process.env.DEXSCREENER_API_ENDPOINT_BOOSTS_TOP;

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID;
export const BOT_WALLET_ADDRESS = process.env.BOT_WALLET_ADDRESS;
export const TOKEN_MINT = process.env.TOKEN_MINT;
export const PRIVATE_KEY = process.env.PRIVATE_KEY;
export const NETWORK = process.env.NETWORK || "mainnet";

// RPC / endpoints
export const MAINNET_RPC = process.env.MAINNET_RPC || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
export const RPC_WEBSOCKET_ENDPOINT = process.env.RPC_WEBSOCKET_ENDPOINT || process.env.WS_ENDPOINT || '';

export const JUPITER_QUOTE_API = process.env.JUPITER_QUOTE_API;
export const JUPITER_SWAP_API = process.env.JUPITER_SWAP_API;

// Support rotating keys for Solscan and Jupiter (comma-separated env vars)
export const SOLSCAN_API_KEYS: string[] = (process.env.SOLSCAN_API_KEYS || '')
	.split(',')
	.map(s => s.trim())
	.filter(Boolean);
export const JUPITER_API_KEYS: string[] = (process.env.JUPITER_API_KEYS || '')
	.split(',')
	.map(s => s.trim())
	.filter(Boolean);

let __solscanKeyIndex = 0;
let __jupiterKeyIndex = 0;

export function getSolscanApiKey(rotate = true): string | null {
	try {
		if (SOLSCAN_API_KEYS && SOLSCAN_API_KEYS.length) {
			const k = SOLSCAN_API_KEYS[__solscanKeyIndex % SOLSCAN_API_KEYS.length];
			if (rotate) __solscanKeyIndex = (__solscanKeyIndex + 1) % SOLSCAN_API_KEYS.length;
			return k;
		}
	} catch (e) {}
	return null;
}

export function getJupiterApiKey(rotate = true): string | null {
	try {
		if (JUPITER_API_KEYS && JUPITER_API_KEYS.length) {
			const k = JUPITER_API_KEYS[__jupiterKeyIndex % JUPITER_API_KEYS.length];
			if (rotate) __jupiterKeyIndex = (__jupiterKeyIndex + 1) % JUPITER_API_KEYS.length;
			return k;
		}
	} catch (e) {}
	return null;
}

export const RESERVE_WALLET = process.env.RESERVE_WALLET || "11111111111111111111111111111111";

// Helius specific envs
export const HELIUS_API_KEY = process.env.HELIUS_API_KEY || process.env.HELIUS_KEY || '';
// Support multiple Helius API keys via comma-separated env var HELIUS_API_KEYS
export const HELIUS_API_KEYS: string[] = (process.env.HELIUS_API_KEYS || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

// Internal rotating index (module-scoped)
let __heliusKeyIndex = 0;

/**
 * Get a Helius API key. If multiple keys are configured via HELIUS_API_KEYS,
 * this function returns keys in a round-robin fashion. If no keys are
 * configured, it falls back to HELIUS_API_KEY.
 *
 * @param rotate whether to advance the rotation index (default: true)
 */
export function getHeliusApiKey(rotate = true): string {
	try {
		if (Array.isArray(HELIUS_API_KEYS) && HELIUS_API_KEYS.length > 0) {
			const key = HELIUS_API_KEYS[__heliusKeyIndex % HELIUS_API_KEYS.length];
			if (rotate) __heliusKeyIndex = (__heliusKeyIndex + 1) % HELIUS_API_KEYS.length;
			return key;
		}
	} catch (e) {}
	return HELIUS_API_KEY;
}
// Utility to partially mask API keys for safe logging
export function maskKey(k: string | null | undefined): string {
	if (!k) return '';
	try {
		const s = String(k);
		if (s.length <= 8) return s.replace(/.(?=.{2})/g, '*');
		return s.slice(0, 4) + '...' + s.slice(-4);
	} catch (e) { return '***'; }
}
export const HELIUS_WS_URL_RAW = process.env.HELIUS_WEBSOCKET_URL || process.env.HELIUS_FAST_RPC_URL || '';
export const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || process.env.MAINNET_RPC || '';
export const HELIUS_PARSE_HISTORY_URL = process.env.HELIUS_PARSE_HISTORY_URL || process.env.HELIUS_PARSE_TX_URL || '';
export const HELIUS_USE_WEBSOCKET = (process.env.HELIUS_USE_WEBSOCKET || 'false').toLowerCase() === 'true';
export const HELIUS_SUBSCRIBE_METADATA = (process.env.HELIUS_SUBSCRIBE_METADATA || 'true').toLowerCase() === 'true';
export const HELIUS_SUBSCRIBE_SPLTOKEN = (process.env.HELIUS_SUBSCRIBE_SPLTOKEN || 'true').toLowerCase() === 'true';
// Additional Helius tuning envs
export const HELIUS_CACHE_TTL_MS = Number(process.env.HELIUS_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
export const HELIUS_RETRY_MAX_ATTEMPTS = Number(process.env.HELIUS_RETRY_MAX_ATTEMPTS || 1);
export const HELIUS_RETRY_BASE_MS = Number(process.env.HELIUS_RETRY_BASE_MS || 500);
export const HELIUS_RETRY_JITTER_MS = Number(process.env.HELIUS_RETRY_JITTER_MS || 300);
export const HELIUS_FALLBACK_ENABLED = (process.env.HELIUS_FALLBACK_ENABLED || 'true').toLowerCase() === 'true';
export const HELIUS_SIG_LIMIT = Number(process.env.HELIUS_SIG_LIMIT || 20);
export const HELIUS_RPC_CONCURRENCY = Number(process.env.HELIUS_RPC_CONCURRENCY || 2);
export const HELIUS_BATCH_SIZE = Number(process.env.HELIUS_BATCH_SIZE || 4);
export const HELIUS_BATCH_DELAY_MS = Number(process.env.HELIUS_BATCH_DELAY_MS || 400);
export const HELIUS_ENRICH_LIMIT = Number(process.env.HELIUS_ENRICH_LIMIT || 8);
// Solscan and on-chain freshness toggles
export const SOLSCAN_API_URL = process.env.SOLSCAN_API_URL || '';
export const SOLSCAN_FALLBACK_ENABLED = (process.env.SOLSCAN_FALLBACK_ENABLED || 'true').toLowerCase() === 'true';
export const ENABLE_ONCHAIN_FRESHNESS = (process.env.ENABLE_ONCHAIN_FRESHNESS || 'true').toLowerCase() === 'true';
export const ONCHAIN_FRESHNESS_TIMEOUT_MS = Number(process.env.ONCHAIN_FRESHNESS_TIMEOUT_MS || 3000);
export const FRESHNESS_MAX_AGE_MINUTES = Number(process.env.FRESHNESS_MAX_AGE_MINUTES || 60 * 24 * 7);
export const FRESHNESS_SCORE_TIMEOUT_MS = Number(process.env.FRESHNESS_SCORE_TIMEOUT_MS || 2000);

// Build Helius WebSocket URL (append API key if needed)
export function getHeliusWebsocketUrl(): string {
	let base = HELIUS_WS_URL_RAW || '';
	if (!base) return '';
	try {
		const u = new URL(base);
		// If api key is not provided in query, append as x-api-key or api-key if present
		// prefer rotating key(s) when available
		const heliusKey = getHeliusApiKey();
		if (heliusKey && !u.searchParams.get('api-key') && !u.searchParams.get('x-api-key') && !u.searchParams.get('key')) {
				u.searchParams.set('x-api-key', heliusKey);
		}
		return u.toString();
	} catch (e) {
		// not a full URL, try to append query
		if (HELIUS_API_KEY && base.indexOf('?') === -1) return `${base}?x-api-key=${HELIUS_API_KEY}`;
		if (HELIUS_API_KEY) return `${base}&x-api-key=${HELIUS_API_KEY}`;
		return base;
	}
}

// Shared connection exported for reuse
export const private_connection = new Connection(MAINNET_RPC);
export const connection = private_connection;
