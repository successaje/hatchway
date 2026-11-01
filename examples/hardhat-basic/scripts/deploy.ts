import { network } from "hardhat";

// With `hatchway hardhat`, getSigners() returns your browser wallet's account and every
// transaction below is shown for review and approved in the wallet.
const { ethers } = await network.connect();
const [deployer] = await ethers.getSigners();
console.log(`Deployer: ${deployer.address}`);

const token = await ethers.deployContract("HatchToken", [
  "Hatch Token",
  "HATCH",
  ethers.parseEther("1000000"),
]);
await token.waitForDeployment();
console.log(`HatchToken deployed at ${await token.getAddress()}`);

const counter = await ethers.deployContract("Counter");
await counter.waitForDeployment();
const tx = await counter.setNumber(7);
await tx.wait();
console.log(
  `Counter deployed at ${await counter.getAddress()} (number = ${await counter.number()})`,
);
