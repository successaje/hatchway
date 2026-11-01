import { network } from "hardhat";

// Message and typed-data signatures are approved in the wallet too. Nothing is sent on-chain.
const { ethers } = await network.connect();
const [signer] = await ethers.getSigners();
const message = "Hatchway example: proving control of this address";
const signature = await signer.signMessage(message);
console.log(`Signature: ${signature}`);
console.log(`Recovered: ${ethers.verifyMessage(message, signature)}`);
