import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Deploy HTLC
  const HTLC = await ethers.getContractFactory("HTLC");
  const htlc = await HTLC.deploy();
  await htlc.waitForDeployment();

  console.log("HTLC deployed to:", await htlc.getAddress());

  // Deploy LimitOrderEscrow if it exists
  try {
    const LimitOrderEscrow = await ethers.getContractFactory("LimitOrderEscrow");
    const limitOrderEscrow = await LimitOrderEscrow.deploy();
    await limitOrderEscrow.waitForDeployment();

    console.log("LimitOrderEscrow deployed to:", await limitOrderEscrow.getAddress());
  } catch (error) {
    console.log("LimitOrderEscrow contract not found, skipping deployment");
  }

  console.log("Deployment completed!");
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
