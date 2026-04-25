import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const V2_ROUTER_ABI = [
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

class TradeService {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.ETH_RPC);
  }

  // ─── Buy token with ETH ─────────────────────────────────────────────────────
  async buy(user, tokenAddress, ethAmount) {
    const wallet = new ethers.Wallet(user.privateKey, this.provider);
    const router = new ethers.Contract(UNISWAP_V2_ROUTER, V2_ROUTER_ABI, wallet);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);

    const symbol = await token.symbol().catch(() => "UNKNOWN");
    const decimals = await token.decimals().catch(() => 18n);

    const amountIn = ethers.parseEther(ethAmount.toString());
    const path = [WETH, tokenAddress];

    // Get expected output
    const amountsOut = await router.getAmountsOut(amountIn, path);
    const slippage = user.settings?.slippage || 5;
    const amountOutMin = amountsOut[1] * BigInt(100 - slippage) / 100n;

    // Gas price boost
    const feeData = await this.provider.getFeeData();
    const gasBoost = BigInt(Math.round((user.settings?.gasBoost || 1.5) * 10));
    const gasPrice = feeData.gasPrice * gasBoost / 10n;

    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min

    const tx = await router.swapExactETHForTokens(
      amountOutMin,
      path,
      wallet.address,
      deadline,
      {
        value: amountIn,
        gasPrice,
        gasLimit: 300_000n,
      }
    );

    const receipt = await tx.wait();
    const gasUsed = ethers.formatEther(receipt.gasUsed * gasPrice);

    // Get tokens received
    const balance = await token.balanceOf(wallet.address);
    const tokensReceived = ethers.formatUnits(balance, decimals);

    // Price per token in ETH
    const pricePerToken = ethAmount / parseFloat(tokensReceived);

    return {
      txHash: receipt.hash,
      tokensReceived: parseFloat(tokensReceived).toFixed(4),
      tokenSymbol: symbol,
      pricePerToken,
      gasUsed,
    };
  }

  // ─── Sell tokens for ETH ────────────────────────────────────────────────────
  async sell(user, position) {
    const wallet = new ethers.Wallet(user.privateKey, this.provider);
    const router = new ethers.Contract(UNISWAP_V2_ROUTER, V2_ROUTER_ABI, wallet);
    const token = new ethers.Contract(position.tokenAddress, ERC20_ABI, wallet);

    const decimals = await token.decimals().catch(() => 18n);
    const balance = await token.balanceOf(wallet.address);

    // Approve router
    const allowance = await token.allowance(wallet.address, UNISWAP_V2_ROUTER);
    if (allowance < balance) {
      const approveTx = await token.approve(UNISWAP_V2_ROUTER, ethers.MaxUint256);
      await approveTx.wait();
    }

    const path = [position.tokenAddress, WETH];
    const amountsOut = await router.getAmountsOut(balance, path);
    const slippage = user.settings?.slippage || 5;
    const amountOutMin = amountsOut[1] * BigInt(100 - slippage) / 100n;

    const feeData = await this.provider.getFeeData();
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const tx = await router.swapExactTokensForETH(
      balance,
      amountOutMin,
      path,
      wallet.address,
      deadline,
      { gasPrice: feeData.gasPrice, gasLimit: 300_000n }
    );

    const receipt = await tx.wait();
    const ethReceived = parseFloat(ethers.formatEther(amountsOut[1]));

    return { txHash: receipt.hash, ethReceived };
  }

  // ─── Collect fee to your wallet ─────────────────────────────────────────────
  async collectFee(user, feeEth) {
    if (!process.env.FEE_WALLET || feeEth < 0.0001) return; // skip dust

    try {
      const wallet = new ethers.Wallet(user.privateKey, this.provider);
      const feeData = await this.provider.getFeeData();
      const value = ethers.parseEther(feeEth.toFixed(6));

      const tx = await wallet.sendTransaction({
        to: process.env.FEE_WALLET,
        value,
        gasPrice: feeData.gasPrice,
        gasLimit: 21000n,
      });
      await tx.wait();
    } catch (e) {
      console.error("Fee collection failed:", e.message);
      // Don't throw — don't let fee failure break the trade
    }
  }

  // ─── Get ETH price from Chainlink ───────────────────────────────────────────
  async getEthPrice() {
    try {
      const feed = new ethers.Contract(
        "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
        ["function latestAnswer() view returns (int256)"],
        this.provider
      );
      const price = await feed.latestAnswer();
      return Number(price) / 1e8;
    } catch {
      return 3400; // fallback
    }
  }

  // ─── Get token price via Uniswap ────────────────────────────────────────────
  async getTokenPrice(tokenAddress) {
    try {
      const router = new ethers.Contract(UNISWAP_V2_ROUTER, V2_ROUTER_ABI, this.provider);
      const amountsOut = await router.getAmountsOut(
        ethers.parseEther("1"),
        [WETH, tokenAddress]
      );
      const ethPrice = await this.getEthPrice();
      const tokensPerEth = parseFloat(ethers.formatUnits(amountsOut[1], 18));
      return ethPrice / tokensPerEth;
    } catch {
      return null;
    }
  }
}

export const tradeService = new TradeService();
