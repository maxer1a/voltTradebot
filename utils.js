import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC);

export function formatEth(wei) {
  if (!wei) return "0.0000";
  return parseFloat(ethers.formatEther(wei)).toFixed(4);
}

export function shortAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export async function getTokenInfo(tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (pair) {
      return {
        symbol: pair.baseToken?.symbol || "UNKNOWN",
        name: pair.baseToken?.name || "Unknown Token",
        price: parseFloat(pair.priceUsd) || 0,
        liquidity: pair.liquidity?.usd || 0,
        volume24h: pair.volume?.h24 || 0,
        priceChange24h: pair.priceChange?.h24 || 0,
        verified: true,
      };
    }
  } catch {}

  try {
    const token = new ethers.Contract(tokenAddress, [
      "function symbol() view returns (string)",
      "function name() view returns (string)",
    ], provider);
    const [symbol, name] = await Promise.all([token.symbol(), token.name()]);
    return { symbol, name, price: null, liquidity: null, volume24h: null, verified: false };
  } catch {
    return { symbol: "UNKNOWN", name: "Unknown", price: null, liquidity: null, volume24h: null, verified: false };
  }
}
