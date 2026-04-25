import TelegramBot from "node-telegram-bot-api";
import { ethers } from "ethers";
import dotenv from "dotenv";
import { db } from "./db.js";
import { tradeService } from "./trade.js";
import { walletService } from "./wallet.js";
import { formatEth, shortAddr, getTokenInfo } from "./utils.js";

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
export { bot };

// ─── Fee config ───────────────────────────────────────────────────────────────
export const FEE_BPS = 50; // 0.5%
export const FEE_WALLET = process.env.FEE_WALLET; // your ETH address

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id.toString();
  const username = msg.from.username || msg.from.first_name;

  let user = db.getUser(userId);
  if (!user) {
    const wallet = walletService.createWallet();
    user = db.createUser(userId, username, wallet.address, wallet.privateKey);
  }

  const balance = await walletService.getBalance(user.address);

  await bot.sendMessage(msg.chat.id, `
⚡ *Welcome to VoltBot* ⚡
_The fastest Ethereum trading bot_

👛 *Your Wallet*
\`${user.address}\`

💰 *Balance:* ${formatEth(balance)} ETH

━━━━━━━━━━━━━━━
*Quick Commands:*
/buy — Buy a token
/sell — Sell a token  
/snipe — Snipe new launches
/wallet — Wallet & balance
/positions — Open positions
/settings — Bot settings
/referral — Earn by referring
/help — All commands
━━━━━━━━━━━━━━━

⚠️ _Deposit ETH to your wallet above to start trading._
  `, {
    parse_mode: "Markdown",
    reply_markup: mainMenu()
  });
});

// ─── /wallet ──────────────────────────────────────────────────────────────────
bot.onText(/\/wallet/, async (msg) => {
  const userId = msg.from.id.toString();
  const user = db.getUser(userId);
  if (!user) return startFirst(msg);

  const balance = await walletService.getBalance(user.address);
  const ethPrice = await tradeService.getEthPrice();
  const usdVal = (parseFloat(formatEth(balance)) * ethPrice).toFixed(2);

  await bot.sendMessage(msg.chat.id, `
💼 *Your Wallet*

📬 Address:
\`${user.address}\`

💰 Balance: *${formatEth(balance)} ETH*
💵 ≈ $${usdVal} USD

📈 Total Trades: ${user.totalTrades || 0}
💸 Total Fees Paid: ${formatEth(user.totalFees || 0)} ETH

━━━━━━━━━━━━━
_Tap to copy your address and deposit ETH_
  `, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Copy Address", callback_data: "copy_address" }],
        [{ text: "📤 Export Private Key", callback_data: "export_key" }],
        [{ text: "🔄 Refresh Balance", callback_data: "refresh_balance" }],
      ]
    }
  });
});

// ─── /buy ─────────────────────────────────────────────────────────────────────
bot.onText(/\/buy(.*)/, async (msg, match) => {
  const userId = msg.from.id.toString();
  const user = db.getUser(userId);
  if (!user) return startFirst(msg);

  const tokenAddress = match[1]?.trim();

  if (!tokenAddress) {
    await bot.sendMessage(msg.chat.id, `
🟢 *Buy Token*

Send me a token contract address to buy.

Example:
\`/buy 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\`

Or paste any Ethereum token address below 👇
    `, { parse_mode: "Markdown" });

    db.setUserState(userId, "awaiting_buy_address");
    return;
  }

  await processBuyRequest(msg.chat.id, userId, tokenAddress);
});

// ─── /sell ────────────────────────────────────────────────────────────────────
bot.onText(/\/sell(.*)/, async (msg, match) => {
  const userId = msg.from.id.toString();
  const user = db.getUser(userId);
  if (!user) return startFirst(msg);

  const positions = db.getPositions(userId);
  if (!positions.length) {
    return bot.sendMessage(msg.chat.id, "❌ You have no open positions to sell.", { parse_mode: "Markdown" });
  }

  const buttons = positions.map(p => ([{
    text: `${p.tokenSymbol} — ${p.amount} tokens`,
    callback_data: `sell_position_${p.id}`
  }]));

  await bot.sendMessage(msg.chat.id, "📉 *Select position to sell:*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons }
  });
});

// ─── /snipe ───────────────────────────────────────────────────────────────────
bot.onText(/\/snipe(.*)/, async (msg, match) => {
  const userId = msg.from.id.toString();
  const user = db.getUser(userId);
  if (!user) return startFirst(msg);

  const tokenAddress = match[1]?.trim();

  if (!tokenAddress) {
    await bot.sendMessage(msg.chat.id, `
🎯 *Token Sniper*

Send me a token address to snipe. VoltBot will buy instantly when liquidity is added.

Usage: \`/snipe <token_address>\`

*Snipe settings:*
• Amount: ${user.settings?.snipeAmount || "0.1"} ETH
• Slippage: ${user.settings?.slippage || "15"}%
• Gas boost: ${user.settings?.gasBoost || "2"}x

Change in /settings
    `, { parse_mode: "Markdown" });
    return;
  }

  db.addSnipe(userId, tokenAddress);
  await bot.sendMessage(msg.chat.id, `
✅ *Snipe Set!*

Token: \`${tokenAddress}\`
Amount: ${user.settings?.snipeAmount || "0.1"} ETH
Slippage: ${user.settings?.slippage || "15"}%

VoltBot is watching for liquidity. You'll be notified when the snipe executes.
  `, { parse_mode: "Markdown" });
});

// ─── /positions ───────────────────────────────────────────────────────────────
bot.onText(/\/positions/, async (msg) => {
  const userId = msg.from.id.toString();
  const user = db.getUser(userId);
  if (!user) return startFirst(msg);

  const positions = db.getPositions(userId);

  if (!positions.length) {
    return bot.sendMessage(msg.chat.id, "📭 No open positions.\n\nUse /buy to start trading.", { parse_mode: "Markdown" });
  }

  let text = "📊 *Your Positions*\n\n";
  for (const p of positions) {
    try {
      const currentPrice = await tradeService.getTokenPrice(p.tokenAddress);
      const pnl = ((currentPrice - p.buyPrice) / p.buyPrice * 100).toFixed(1);
      const pnlEmoji = pnl >= 0 ? "🟢" : "🔴";
      text += `${pnlEmoji} *${p.tokenSymbol}*\n`;
      text += `   Amount: ${p.amount}\n`;
      text += `   Buy: $${p.buyPrice?.toFixed(6)} | Now: $${currentPrice?.toFixed(6)}\n`;
      text += `   PnL: ${pnl >= 0 ? "+" : ""}${pnl}%\n\n`;
    } catch {
      text += `⚪ *${p.tokenSymbol}*\n   Amount: ${p.amount}\n\n`;
    }
  }

  await bot.sendMessage(msg.chat.id, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "refresh_positions" }]]
    }
  });
});

// ─── /settings ────────────────────────────────────────────────────────────────
bot.onText(/\/settings/, async (msg) => {
  const userId = msg.from.id.toString();
  const user = db.getUser(userId);
  if (!user) return startFirst(msg);

  const s = user.settings || {};

  await bot.sendMessage(msg.chat.id, `
⚙️ *Bot Settings*

💰 Default Buy Amount: *${s.defaultBuy || "0.1"} ETH*
📉 Slippage: *${s.slippage || "5"}%*
⛽ Gas Multiplier: *${s.gasBoost || "1.5"}x*
🎯 Snipe Amount: *${s.snipeAmount || "0.1"} ETH*
🛑 Auto Stop-Loss: *${s.stopLoss || "off"}*
🎯 Auto Take-Profit: *${s.takeProfit || "off"}*
  `, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💰 Set Buy Amount", callback_data: "set_default_buy" }],
        [{ text: "📉 Set Slippage", callback_data: "set_slippage" }],
        [{ text: "⛽ Set Gas Boost", callback_data: "set_gas" }],
        [{ text: "🛑 Stop-Loss / Take-Profit", callback_data: "set_sl_tp" }],
      ]
    }
  });
});

// ─── /referral ────────────────────────────────────────────────────────────────
bot.onText(/\/referral/, async (msg) => {
  const userId = msg.from.id.toString();
  const user = db.getUser(userId);
  if (!user) return startFirst(msg);

  const refCount = db.getReferralCount(userId);
  const refEarnings = db.getReferralEarnings(userId);
  const botUsername = process.env.BOT_USERNAME || "VoltTradeBot";

  await bot.sendMessage(msg.chat.id, `
🤝 *Referral Program*

Share your link and earn *20%* of fees from everyone you refer — forever.

🔗 Your Link:
\`https://t.me/${botUsername}?start=ref_${userId}\`

📊 Stats:
• Referrals: ${refCount}
• Total Earned: ${formatEth(refEarnings)} ETH

💡 _Share in trading groups, Twitter, Discord for best results._
  `, { parse_mode: "Markdown" });
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `
⚡ *VoltBot Commands*

*Trading*
/buy \`<address>\` — Buy a token
/sell — Sell from positions
/snipe \`<address>\` — Snipe a token launch
/positions — View open positions

*Wallet*
/wallet — View wallet & balance
/deposit — Get deposit address

*Settings & Tools*
/settings — Configure bot
/referral — Referral program
/help — This message

*Tips*
• Always check token on Dexscreener first
• Use /snipe for new launches
• Set stop-loss to protect gains
  `, { parse_mode: "Markdown" });
});

// ─── Text message handler (state machine) ─────────────────────────────────────
bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  const userId = msg.from.id.toString();
  const state = db.getUserState(userId);

  if (state === "awaiting_buy_address") {
    const address = msg.text?.trim();
    if (!ethers.isAddress(address)) {
      return bot.sendMessage(msg.chat.id, "❌ Invalid address. Please send a valid Ethereum token address.");
    }
    db.clearUserState(userId);
    await processBuyRequest(msg.chat.id, userId, address);
  }

  if (state?.startsWith("awaiting_buy_amount_")) {
    const tokenAddress = state.replace("awaiting_buy_amount_", "");
    const amount = parseFloat(msg.text?.trim());
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(msg.chat.id, "❌ Invalid amount. Enter a number like: 0.1");
    }
    db.clearUserState(userId);
    await executeBuy(msg.chat.id, userId, tokenAddress, amount);
  }
});

// ─── Callback query handler ───────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const userId = query.from.id.toString();
  const data = query.data;
  const chatId = query.message.chat.id;

  await bot.answerCallbackQuery(query.id);

  if (data === "refresh_balance") {
    const user = db.getUser(userId);
    const balance = await walletService.getBalance(user.address);
    await bot.sendMessage(chatId, `💰 Balance: *${formatEth(balance)} ETH*`, { parse_mode: "Markdown" });
  }

  if (data === "export_key") {
    const user = db.getUser(userId);
    await bot.sendMessage(chatId, `
🔐 *Private Key*
\`${user.privateKey}\`

⚠️ *NEVER share this with anyone. Delete this message after saving.*
    `, { parse_mode: "Markdown" });
  }

  if (data === "copy_address") {
    const user = db.getUser(userId);
    await bot.sendMessage(chatId, `\`${user.address}\``, { parse_mode: "Markdown" });
  }

  if (data.startsWith("buy_amount_")) {
    const [, , tokenAddress, amount] = data.split("_");
    await executeBuy(chatId, userId, tokenAddress, parseFloat(amount));
  }

  if (data.startsWith("sell_position_")) {
    const positionId = data.replace("sell_position_", "");
    await executeSell(chatId, userId, positionId);
  }

  if (data === "set_default_buy") {
    db.setUserState(userId, "awaiting_default_buy");
    await bot.sendMessage(chatId, "💰 Enter default buy amount in ETH (e.g. 0.1):");
  }

  if (data === "set_slippage") {
    db.setUserState(userId, "awaiting_slippage");
    await bot.sendMessage(chatId, "📉 Enter slippage % (e.g. 5):");
  }

  if (data.startsWith("confirm_sell_")) {
    const posId = data.replace("confirm_sell_", "");
    await executeSell(chatId, userId, posId, true);
  }
});

// ─── Core buy flow ────────────────────────────────────────────────────────────
async function processBuyRequest(chatId, userId, tokenAddress) {
  const loadMsg = await bot.sendMessage(chatId, "🔍 Fetching token info...");

  try {
    const tokenInfo = await getTokenInfo(tokenAddress);
    const user = db.getUser(userId);
    const balance = await walletService.getBalance(user.address);
    const balEth = parseFloat(ethers.formatEther(balance));

    await bot.editMessageText(`
🟢 *Buy ${tokenInfo.symbol}*

📋 Token: \`${tokenAddress}\`
💲 Price: $${tokenInfo.price?.toFixed(8) || "N/A"}
💧 Liquidity: $${tokenInfo.liquidity?.toLocaleString() || "N/A"}
📊 24h Vol: $${tokenInfo.volume24h?.toLocaleString() || "N/A"}
🔒 Verified: ${tokenInfo.verified ? "✅" : "⚠️ Unverified"}

💼 Your balance: ${balEth.toFixed(4)} ETH

*Select amount to buy:*
    `, {
      chat_id: chatId, message_id: loadMsg.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "0.05 ETH", callback_data: `buy_amount_${tokenAddress}_0.05` },
            { text: "0.1 ETH", callback_data: `buy_amount_${tokenAddress}_0.1` },
            { text: "0.5 ETH", callback_data: `buy_amount_${tokenAddress}_0.5` },
          ],
          [
            { text: "1 ETH", callback_data: `buy_amount_${tokenAddress}_1` },
            { text: "Custom", callback_data: `buy_custom_${tokenAddress}` },
          ],
        ]
      }
    });
  } catch (e) {
    await bot.editMessageText("❌ Could not fetch token info. Check the address and try again.", {
      chat_id: chatId, message_id: loadMsg.message_id
    });
  }
}

async function executeBuy(chatId, userId, tokenAddress, ethAmount) {
  const user = db.getUser(userId);
  const balance = await walletService.getBalance(user.address);
  const balEth = parseFloat(ethers.formatEther(balance));

  if (balEth < ethAmount) {
    return bot.sendMessage(chatId, `❌ Insufficient balance.\n\nYou have ${balEth.toFixed(4)} ETH, need ${ethAmount} ETH.\n\nDeposit to: \`${user.address}\``, { parse_mode: "Markdown" });
  }

  const msg = await bot.sendMessage(chatId, "⏳ Executing trade...");

  try {
    const result = await tradeService.buy(user, tokenAddress, ethAmount);

    // Collect fee
    const fee = ethAmount * (FEE_BPS / 10000);
    await tradeService.collectFee(user, fee);
    db.recordFee(userId, fee);

    // Save position
    db.addPosition(userId, {
      tokenAddress,
      tokenSymbol: result.tokenSymbol,
      amount: result.tokensReceived,
      buyPrice: result.pricePerToken,
      ethSpent: ethAmount,
      txHash: result.txHash,
    });

    await bot.editMessageText(`
✅ *Buy Successful!*

🪙 ${result.tokensReceived} *${result.tokenSymbol}*
💸 Spent: ${ethAmount} ETH
⛽ Gas: ${result.gasUsed} ETH
💰 Fee: ${fee.toFixed(6)} ETH (0.5%)
🔗 [View on Etherscan](https://etherscan.io/tx/${result.txHash})

_Position added. Use /positions to track._
    `, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown", disable_web_page_preview: true });
  } catch (e) {
    await bot.editMessageText(`❌ Trade failed: ${e.message}`, {
      chat_id: chatId, message_id: msg.message_id
    });
  }
}

async function executeSell(chatId, userId, positionId, confirmed = false) {
  const position = db.getPosition(positionId);
  if (!position) return bot.sendMessage(chatId, "❌ Position not found.");

  if (!confirmed) {
    const currentPrice = await tradeService.getTokenPrice(position.tokenAddress).catch(() => null);
    return bot.sendMessage(chatId, `
📉 *Sell ${position.tokenSymbol}?*

Amount: ${position.amount} tokens
Buy price: $${position.buyPrice?.toFixed(8) || "N/A"}
${currentPrice ? `Current: $${currentPrice.toFixed(8)}` : ""}
Est. receive: ~${(position.ethSpent * 0.98).toFixed(4)} ETH (after fee + slippage)
    `, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm Sell", callback_data: `confirm_sell_${positionId}` },
            { text: "❌ Cancel", callback_data: "cancel" }
          ]
        ]
      }
    });
  }

  const msg = await bot.sendMessage(chatId, "⏳ Executing sell...");
  const user = db.getUser(userId);

  try {
    const result = await tradeService.sell(user, position);
    const fee = result.ethReceived * (FEE_BPS / 10000);
    await tradeService.collectFee(user, fee);
    db.recordFee(userId, fee);
    db.removePosition(positionId);

    await bot.editMessageText(`
✅ *Sell Successful!*

🪙 Sold: ${position.amount} ${position.tokenSymbol}
💰 Received: ${result.ethReceived.toFixed(6)} ETH
💸 Fee: ${fee.toFixed(6)} ETH
🔗 [View on Etherscan](https://etherscan.io/tx/${result.txHash})
    `, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown", disable_web_page_preview: true });
  } catch (e) {
    await bot.editMessageText(`❌ Sell failed: ${e.message}`, {
      chat_id: chatId, message_id: msg.message_id
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🟢 Buy", callback_data: "open_buy" }, { text: "🔴 Sell", callback_data: "open_sell" }],
      [{ text: "🎯 Snipe", callback_data: "open_snipe" }, { text: "📊 Positions", callback_data: "open_positions" }],
      [{ text: "💼 Wallet", callback_data: "open_wallet" }, { text: "⚙️ Settings", callback_data: "open_settings" }],
    ]
  };
}

function startFirst(msg) {
  return bot.sendMessage(msg.chat.id, "Please use /start first to create your wallet.");
}

console.log("⚡ VoltBot is running...");
