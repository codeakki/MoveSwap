import { ethers } from 'hardhat';
import dotenv from 'dotenv';

dotenv.config();

// Network-specific configuration
const getNetworkConfig = (networkName: string) => {
    const configs: { [key: string]: { oneInchLimitOrderProtocol: string } } = {
        sepolia: {
            oneInchLimitOrderProtocol: "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch Limit Order Protocol address on Sepolia
        },
        base: {
            oneInchLimitOrderProtocol: "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch Limit Order Protocol address on Base (verify this address)
        },
        baseSepolia: {
            oneInchLimitOrderProtocol: "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch Limit Order Protocol address on Base Sepolia (verify this address)
        }
    };
    
    return configs[networkName] || configs.sepolia;
};

async function deployContracts() {
    console.log("Deploying contracts...");

    // Get the current network
    const network = await ethers.provider.getNetwork();
    const networkName = network.name === 'unknown' ? 'hardhat' : network.name;
    console.log(`Deploying to network: ${networkName} (chainId: ${network.chainId})`);

    // Get network-specific configuration
    const config = getNetworkConfig(networkName);
    console.log(`Using 1inch protocol address: ${config.oneInchLimitOrderProtocol}`);

    // Get the signer from Hardhat
    const [deployer] = await ethers.getSigners();
    
    if (!deployer) {
        throw new Error("No deployer account found. Make sure ETH_PRIVATE_KEY is set in .env file.");
    }
    
    const deployerAddress = await deployer.getAddress();
    console.log(`Deploying from: ${deployerAddress}`);

    // Check deployer balance
    const balance = await ethers.provider.getBalance(deployerAddress);
    console.log(`Deployer balance: ${ethers.formatEther(balance)} ETH`);

    // Deploy HTLC contract
    console.log("Deploying HTLC contract...");
    const HTLCFactory = await ethers.getContractFactory("HTLC");
    const htlcContract = await HTLCFactory.deploy();
    await htlcContract.waitForDeployment();
    const htlcAddress = await htlcContract.getAddress();
    console.log(`HTLC contract deployed at: ${htlcAddress}`);

    // Deploy OneInchIntegration contract
    console.log("Deploying OneInchIntegration contract...");
    const OneInchIntegrationFactory = await ethers.getContractFactory("OneInchIntegration");
    const oneInchIntegration = await OneInchIntegrationFactory.deploy(
        config.oneInchLimitOrderProtocol,
        htlcAddress
    );
    await oneInchIntegration.waitForDeployment();
    const oneInchIntegrationAddress = await oneInchIntegration.getAddress();
    console.log(`OneInchIntegration contract deployed at: ${oneInchIntegrationAddress}`);

    // Set the 1inch integration in HTLC contract
    console.log("Setting 1inch integration in HTLC contract...");
    const setIntegrationTx = await htlcContract.setOneInchIntegration(oneInchIntegrationAddress);
    await setIntegrationTx.wait();
    console.log(`1inch integration set: ${setIntegrationTx.hash}`);

    // Verify contracts
    console.log("\n=== Deployment Summary ===");
    console.log(`HTLC Contract: ${htlcAddress}`);
    console.log(`OneInchIntegration Contract: ${oneInchIntegrationAddress}`);
    console.log(`1inch Limit Order Protocol: ${config.oneInchLimitOrderProtocol}`);

    // Save deployment addresses to config file
    const deploymentConfig = {
        network: networkName,
        chainId: Number(network.chainId),
        htlcAddress: htlcAddress,
        oneInchIntegrationAddress: oneInchIntegrationAddress,
        oneInchLimitOrderProtocol: config.oneInchLimitOrderProtocol,
        deployedAt: new Date().toISOString(),
        deployer: deployerAddress
    };

    const fs = require('fs');
    fs.writeFileSync('deployment.json', JSON.stringify(deploymentConfig, null, 2));
    console.log("\nDeployment configuration saved to deployment.json");

    return {
        htlcAddress: htlcAddress,
        oneInchIntegrationAddress: oneInchIntegrationAddress
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
