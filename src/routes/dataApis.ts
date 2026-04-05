/**
 * Sprint 21.1 — First-party x402-gated data APIs
 *
 * GET /api/weather?city=         — current weather (Open-Meteo, free)
 * GET /api/crypto/price?symbol=  — crypto price (CoinGecko, free)
 * GET /api/fx?from=USD&to=NGN    — FX rate (exchangerate-api, free)
 * GET /api/geocode?address=      — lat/lng (Nominatim, free)
 *
 * Each endpoint is protected by x402Paywall — callers must pay 1,000 µUSDC
 * ($0.001) per call via an Algorand MandateContract. These serve as dogfood
 * for the seller SDK and seed listings #1–4 in the API registry.
 *
 * Prices (all in micro-USDC):
 *   weather:      1,000
 *   crypto price: 1,000
 *   fx rate:      2,000
 *   geocode:      1,000
 */

import { Router, type Request, type Response } from "express";
import { makeX402Paywall } from "../middleware/x402.js";

const router = Router();

const TREASURY = process.env["X402_PAY_TO_ADDRESS"] ?? "";

// ── Helpers ────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Upstream error: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ── GET /api/weather ──────────────────────────────────────────────────────

router.get(
  "/weather",
  makeX402Paywall({ priceMicro: 1_000, payTo: TREASURY, description: "weather lookup" }),
  async (req: Request, res: Response) => {
    const city = (req.query["city"] as string | undefined)?.trim();
    if (!city) {
      res.status(400).json({ error: "city query parameter required" });
      return;
    }

    // Geocode city → lat/lon via Nominatim, then fetch Open-Meteo
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
    const geoData = await fetchJson<Array<{ lat: string; lon: string; display_name: string }>>(geoUrl);
    if (!geoData.length) {
      res.status(404).json({ error: `City not found: ${city}` });
      return;
    }
    const { lat, lon, display_name } = geoData[0]!;
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&wind_speed_unit=ms`;
    const w = await fetchJson<{
      current: {
        temperature_2m: number;
        relative_humidity_2m: number;
        weather_code: number;
        wind_speed_10m: number;
      };
    }>(weatherUrl);

    res.json({
      city:        display_name,
      temperature: `${w.current.temperature_2m}°C`,
      humidity:    `${w.current.relative_humidity_2m}%`,
      wind_speed:  `${w.current.wind_speed_10m} m/s`,
      conditions:  wmoDescription(w.current.weather_code),
      source:      "Open-Meteo (open-meteo.com)",
    });
  },
);

// ── GET /api/crypto/price ─────────────────────────────────────────────────

router.get(
  "/crypto/price",
  makeX402Paywall({ priceMicro: 1_000, payTo: TREASURY, description: "crypto price lookup" }),
  async (req: Request, res: Response) => {
    const symbol = (req.query["symbol"] as string | undefined)?.toUpperCase().trim();
    if (!symbol) {
      res.status(400).json({ error: "symbol query parameter required" });
      return;
    }

    // CoinGecko free tier — map common symbols to IDs
    const id = COINGECKO_IDS[symbol] ?? symbol.toLowerCase();
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`;
    const data = await fetchJson<Record<string, { usd: number; usd_24h_change: number }>>(url);

    if (!data[id]) {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
      return;
    }

    res.json({
      symbol,
      price_usd:       data[id]!.usd,
      change_24h_pct:  Number(data[id]!.usd_24h_change.toFixed(2)),
      source:          "CoinGecko (coingecko.com)",
    });
  },
);

// ── GET /api/fx ───────────────────────────────────────────────────────────

router.get(
  "/fx",
  makeX402Paywall({ priceMicro: 2_000, payTo: TREASURY, description: "fx rate lookup" }),
  async (req: Request, res: Response) => {
    const from = (req.query["from"] as string | undefined)?.toUpperCase().trim();
    const to   = (req.query["to"]   as string | undefined)?.toUpperCase().trim();
    if (!from || !to) {
      res.status(400).json({ error: "from and to query parameters required" });
      return;
    }

    const url = `https://open.er-api.com/v6/latest/${from}`;
    const data = await fetchJson<{
      result: string;
      rates:  Record<string, number>;
    }>(url);

    if (data.result !== "success" || !data.rates[to]) {
      res.status(404).json({ error: `FX pair not found: ${from}/${to}` });
      return;
    }

    res.json({
      from,
      to,
      rate:   data.rates[to],
      source: "ExchangeRate-API (exchangerate-api.com)",
    });
  },
);

// ── GET /api/geocode ──────────────────────────────────────────────────────

router.get(
  "/geocode",
  makeX402Paywall({ priceMicro: 1_000, payTo: TREASURY, description: "geocode lookup" }),
  async (req: Request, res: Response) => {
    const address = (req.query["address"] as string | undefined)?.trim();
    if (!address) {
      res.status(400).json({ error: "address query parameter required" });
      return;
    }

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&addressdetails=1`;
    const data = await fetchJson<Array<{
      lat:          string;
      lon:          string;
      display_name: string;
      address:      Record<string, string>;
    }>>(url);

    if (!data.length) {
      res.status(404).json({ error: `Address not found: ${address}` });
      return;
    }

    const { lat, lon, display_name } = data[0]!;
    res.json({
      address: display_name,
      lat:     Number(lat),
      lon:     Number(lon),
      source:  "Nominatim / OpenStreetMap (nominatim.openstreetmap.org)",
    });
  },
);

// ── Well-known x402 metadata (for registry verification) ──────────────────

router.get(
  "/:endpoint/.well-known/x402",
  (_req: Request, res: Response) => {
    res.json({
      payment_methods: ["https://www.x402.org/"],
      network:         "algorand-mainnet",
      asset:           "USDC (ASA 31566704)",
      pay_to:          TREASURY,
    });
  },
);

// ── WMO weather code descriptions ─────────────────────────────────────────

function wmoDescription(code: number): string {
  if (code === 0)  return "Clear sky";
  if (code <= 3)   return "Partly cloudy";
  if (code <= 9)   return "Overcast";
  if (code <= 19)  return "Fog";
  if (code <= 29)  return "Drizzle";
  if (code <= 39)  return "Rain";
  if (code <= 49)  return "Snow";
  if (code <= 59)  return "Rain showers";
  if (code <= 69)  return "Snow showers";
  if (code <= 79)  return "Thunderstorm";
  if (code <= 89)  return "Heavy thunderstorm";
  return "Severe weather";
}

const COINGECKO_IDS: Record<string, string> = {
  BTC:   "bitcoin",
  ETH:   "ethereum",
  SOL:   "solana",
  ALGO:  "algorand",
  USDC:  "usd-coin",
  MATIC: "matic-network",
  ADA:   "cardano",
  XRP:   "ripple",
};

export default router;
