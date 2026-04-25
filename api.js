import express from "express";
import cors from "cors";
import { db } from "./db.js";
import { tradeService } from "./trade.js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", (req, res, next) => {
  const key = req.headers["x-admin-key"];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/api/stats", async (req, res) => {
  const ethPrice = await tradeService.getEthPrice();
  const totalFees = db.getTotalFees();
  const fees24h = db.getFeesLast24h();
  res.json({
    totalUsers: db.getTotalUsers(),
    totalTrades: db.getTotalTrades(),
    totalFeesEth: totalFees.toFixed(6),
    totalFeesUsd: (totalFees * ethPrice).toFixed(2),
    fees24hEth: fees24h.toFixed(6),
    fees24hUsd: (fees24h * ethPrice).toFixed(2),
    ethPrice: ethPrice.toFixed(2),
  });
});

const PORT = process.env.DASHBOARD_PORT || 3002;
app.listen(PORT, () => console.log(`📊 Dashboard API on :${PORT}`));
