import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatIgnitionEthers from "@nomicfoundation/hardhat-ignition-ethers";
import { configVariable, defineConfig } from "hardhat/config";
import hatchway from "hatchway/hardhat";

export default defineConfig({
  plugins: [hardhatEthers, hardhatIgnitionEthers, hatchway],
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // No `accounts` here: with Hatchway your browser wallet is the signer.
    localhost: {
      type: "http",
      url: process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545",
    },
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
    },
  },
});
