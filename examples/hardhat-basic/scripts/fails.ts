import { network } from "hardhat";

// Calls a function that always reverts. ethers estimates gas first, so the revert is caught
// before anything reaches the wallet.
const { ethers } = await network.connect();
const faulty = await ethers.deployContract("Faulty", [false]);
await faulty.waitForDeployment();
await faulty.boom();
