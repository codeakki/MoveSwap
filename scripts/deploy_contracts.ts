import { ethers } from 'ethers';
import { JsonRpcProvider } from '@ethersproject/providers';
import dotenv from 'dotenv';

dotenv.config();

// Configuration
const config = {
    ethereumRPC: "https://ethereum-sepolia-rpc.publicnode.com",
    ethereumPrivateKey: process.env.ETH_PRIVATE_KEY,
    oneInchLimitOrderProtocol: "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch Limit Order Protocol address on Sepolia
};

async function deployContracts() {
    console.log("Deploying contracts...");

    // Setup provider and wallet
    const provider = new JsonRpcProvider(config.ethereumRPC);
    const wallet = new ethers.Wallet(config.ethereumPrivateKey!, provider);

    console.log(`Deploying from: ${wallet.address}`);

    // Deploy HTLC contract
    console.log("Deploying HTLC contract...");
    const HTLCFactory = await ethers.getContractFactory("HTLC");
    const htlcContract = await HTLCFactory.deploy();
    await htlcContract.deployed();
    console.log(`HTLC contract deployed at: ${htlcContract.address}`);

    // Deploy OneInchIntegration contract
    console.log("Deploying OneInchIntegration contract...");
    const OneInchIntegrationFactory = await ethers.getContractFactory("OneInchIntegration");
    const oneInchIntegration = await OneInchIntegrationFactory.deploy(
        config.oneInchLimitOrderProtocol,
        htlcContract.address
    );
    await oneInchIntegration.deployed();
    console.log(`OneInchIntegration contract deployed at: ${oneInchIntegration.address}`);

    // Set the 1inch integration in HTLC contract
    console.log("Setting 1inch integration in HTLC contract...");
    const setIntegrationTx = await htlcContract.setOneInchIntegration(oneInchIntegration.address);
    await setIntegrationTx.wait();
    console.log(`1inch integration set: ${setIntegrationTx.hash}`);

    // Verify contracts
    console.log("\n=== Deployment Summary ===");
    console.log(`HTLC Contract: ${htlcContract.address}`);
    console.log(`OneInchIntegration Contract: ${oneInchIntegration.address}`);
    console.log(`1inch Limit Order Protocol: ${config.oneInchLimitOrderProtocol}`);

    // Save deployment addresses to config file
    const deploymentConfig = {
        network: "sepolia",
        htlcAddress: htlcContract.address,
        oneInchIntegrationAddress: oneInchIntegration.address,
        oneInchLimitOrderProtocol: config.oneInchLimitOrderProtocol,
        deployedAt: new Date().toISOString(),
        deployer: wallet.address
    };

    const fs = require('fs');
    fs.writeFileSync('deployment.json', JSON.stringify(deploymentConfig, null, 2));
    console.log("\nDeployment configuration saved to deployment.json");

    return {
        htlcAddress: htlcContract.address,
        oneInchIntegrationAddress: oneInchIntegration.address
    };
}

async function main() {
    try {
        await deployContracts();
        console.log("\nDeployment completed successfully!");
    } catch (error) {
        console.error("Deployment failed:", error);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

export { deployContracts };
