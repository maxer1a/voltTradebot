import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../data/db.json");

// Ensure data dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { users: {}, positions: {}, snipes: {}, fees: [], states: {} };
  }
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

class DB {
  // ─── Users ────────────────────────────────────────────────────────────────
  createUser(userId, username, address, privateKey) {
    const data = load();
    const user = {
      userId, username, address, privateKey,
      settings: { defaultBuy: "0.1", slippage: 5, gasBoost: 1.5, snipeAmount: "0.1" },
      totalTrades: 0, totalFees: 0,
      referredBy: null, referralCode: userId,
      createdAt: Date.now(),
    };
    data.users[userId] = user;
    save(data);
    return user;
  }

  getUser(userId) {
    return load().users[userId] || null;
  }

  updateUser(userId, updates) {
    const data = load();
    if (!data.users[userId]) return;
    data.users[userId] = { ...data.users[userId], ...updates };
    save(data);
  }

  updateSettings(userId, settings) {
    const data = load();
    if (!data.users[userId]) return;
    data.users[userId].settings = { ...data.users[userId].settings, ...settings };
    save(data);
  }

  // ─── State machine ────────────────────────────────────────────────────────
  setUserState(userId, state) {
    const data = load();
    data.states[userId] = state;
    save(data);
  }

  getUserState(userId) {
    return load().states[userId] || null;
  }

  clearUserState(userId) {
    const data = load();
    delete data.states[userId];
    save(data);
  }

  // ─── Positions ────────────────────────────────────────────────────────────
  addPosition(userId, position) {
    const data = load();
    if (!data.positions[userId]) data.positions[userId] = [];
    const pos = { ...position, id: Date.now().toString(), userId, openedAt: Date.now() };
    data.positions[userId].push(pos);
    data.users[userId].totalTrades = (data.users[userId].totalTrades || 0) + 1;
    save(data);
    return pos;
  }

  getPositions(userId) {
    return load().positions[userId] || [];
  }

  getPosition(positionId) {
    const data = load();
    for (const uid in data.positions) {
      const found = data.positions[uid].find(p => p.id === positionId);
      if (found) return found;
    }
    return null;
  }

  removePosition(positionId) {
    const data = load();
    for (const uid in data.positions) {
      data.positions[uid] = data.positions[uid].filter(p => p.id !== positionId);
    }
    save(data);
  }

  // ─── Snipes ───────────────────────────────────────────────────────────────
  addSnipe(userId, tokenAddress) {
    const data = load();
    if (!data.snipes[userId]) data.snipes[userId] = [];
    data.snipes[userId].push({ tokenAddress, addedAt: Date.now(), executed: false });
    save(data);
  }

  getAllSnipes() {
    const data = load();
    const all = [];
    for (const uid in data.snipes) {
      data.snipes[uid].filter(s => !s.executed).forEach(s => all.push({ userId: uid, ...s }));
    }
    return all;
  }

  markSnipeExecuted(userId, tokenAddress) {
    const data = load();
    if (data.snipes[userId]) {
      const s = data.snipes[userId].find(s => s.tokenAddress === tokenAddress);
      if (s) s.executed = true;
    }
    save(data);
  }

  // ─── Fees ─────────────────────────────────────────────────────────────────
  recordFee(userId, feeEth) {
    const data = load();
    data.fees.push({ userId, amount: feeEth, ts: Date.now() });
    if (data.users[userId]) {
      data.users[userId].totalFees = (data.users[userId].totalFees || 0) + feeEth;
    }
    save(data);
  }

  getTotalFees() {
    return load().fees.reduce((sum, f) => sum + f.amount, 0);
  }

  getFeesLast24h() {
    const cutoff = Date.now() - 86_400_000;
    return load().fees.filter(f => f.ts > cutoff).reduce((sum, f) => sum + f.amount, 0);
  }

  getTotalUsers() {
    return Object.keys(load().users).length;
  }

  getTotalTrades() {
    return load().fees.length;
  }

  // ─── Referrals ────────────────────────────────────────────────────────────
  getReferralCount(userId) {
    const data = load();
    return Object.values(data.users).filter(u => u.referredBy === userId).length;
  }

  getReferralEarnings(userId) {
    // 20% of fees from referred users
    const data = load();
    const referredIds = Object.values(data.users)
      .filter(u => u.referredBy === userId)
      .map(u => u.userId);
    return data.fees
      .filter(f => referredIds.includes(f.userId))
      .reduce((sum, f) => sum + f.amount * 0.2, 0);
  }
}

export const db = new DB();
