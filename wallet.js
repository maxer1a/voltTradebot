// wallet.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

class WalletService {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.ETH_RPC);
  }

  createWallet() {
    const wallet = ethers.Wallet.createRandom();
    return { address: wallet.address, privateKey: wallet.privateKey };
  }

  async getBalance(address) {
    return await this.provider.getBalance(address);
  }
}

export const walletService = new WalletService();
