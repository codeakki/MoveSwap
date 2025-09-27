import { ethers } from 'ethers';
import { JsonRpcProvider } from '@ethersproject/providers';
import dotenv from 'dotenv';

dotenv.config();

async function testCompilation() {
    console.log("Testing contract compilation...");

    try {
        // Test if we can create contract factories
        const HTLCFactory = await ethers.getContractFactory("HTLC");
        console.log("✓ HTLC contract compiled successfully");

        const OneInchIntegrationFactory = await ethers.getContractFactory("OneInchIntegration");
        console.log("✓ OneInchIntegration contract compiled successfully");

        console.log("\n✅ All contracts compiled successfully!");
        console.log("The stack too deep error has been resolved.");

    } catch (error) {
        console.error("❌ Compilation failed:", error);
        process.exit(1);
    }
}

async function main() {
    await testCompilation();
}

if (require.main === module) {
    main().catch(console.error);
}

export { testCompilation };
