import { ethers } from 'ethers';
import { JsonRpcProvider } from '@ethersproject/providers';
import * as crypto from 'crypto';
import { SuiClient, SuiTransactionBlockResponse } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { getFullnodeUrl } from '@mysten/sui/client';
import { bcs } from '@mysten/sui/bcs';
import dotenv from 'dotenv';

dotenv.config();


// Configuration
const config = {
    // Ethereum (Sepolia) Configuration
    ethereumRPC: "https://ethereum-sepolia-rpc.publicnode.com",
    htlcAddress: "0x239f06e80631C1347876FE256Cc43BA79641e53F",
    ethereumPrivateKey: process.env.ETH_PRIVATE_KEY,
    
    // Sui Configuration
    suiPackageId: "0x5d4356c8b1d54fa4ff50afe4702ca2329cf7884eb8edb48399ffce907ecd14b0",
    suiPrivateKey: process.env.SUI_PRIVATE_KEY,
    
    // Timelock Configuration (in seconds)
    ethTimelockDuration: 7200, // 2 hours
    suiTimelockDuration: 3600, // 1 hour (shorter to ensure Sui can be claimed first)
};

// HTLC ABI
const HTLC_ABI = [
    "function createHTLC(bytes32 _htlc_id, address _receiver, bytes32 _hashlock, uint256 _timelock, address _token) external payable",
    "function claimHTLC(bytes32 _htlc_id, bytes32 _secret) external",
    "function refundHTLC(bytes32 _htlc_id) external",
    "function getHTLC(bytes32 _htlc_id) external view returns (bytes32, bytes32, uint256, address, address, uint256, bytes32, bool, bool, uint256, address)",
    "function getSecret(bytes32 _htlc_id) external view returns (bytes32)",
    "event HTLCCreated(bytes32 indexed htlc_id, address indexed sender, address indexed receiver, uint256 amount, bytes32 hashlock, uint256 timelock, address token)",
    "event HTLCClaimed(bytes32 indexed htlc_id, address indexed receiver, bytes32 secret, uint256 amount)",
    "event HTLCRefunded(bytes32 indexed htlc_id, address indexed sender, uint256 amount)"
];

interface HTLCFields {
    id: Uint8Array;
    hashlock: Uint8Array;
    timelock: string;
    sender: string;
    receiver: string;
    amount: string;
    secret?: Uint8Array;
    withdrawn: boolean;
    refunded: boolean;
    created_at: string;
}

class AtomicSwap {
    private ethProvider: JsonRpcProvider;
    private ethWallet: ethers.Wallet;
    private ethContract: ethers.Contract;
    private suiClient: SuiClient;
    private suiKeypair: Ed25519Keypair;

    constructor() {
        // Initialize Ethereum
        this.ethProvider = new JsonRpcProvider(config.ethereumRPC);
        this.ethWallet = new ethers.Wallet(config.ethereumPrivateKey, this.ethProvider);
        this.ethContract = new ethers.Contract(config.htlcAddress, HTLC_ABI, this.ethWallet);

        // Initialize Sui
        this.suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
        // Remove the '1b' suffix from the private key if present
        const privateKey = config.suiPrivateKey.endsWith('1b') ? 
            config.suiPrivateKey.slice(0, -2) : config.suiPrivateKey;
        this.suiKeypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKey, 'hex'));
        
        // Log Sui address
        const suiAddress = this.suiKeypair.getPublicKey().toSuiAddress();
        console.log("\nSui Wallet Address:", suiAddress);
        console.log("Make sure this address has enough SUI tokens for gas and the HTLC amount\n");
    }

    getSuiAddress(): string {
        return this.suiKeypair.getPublicKey().toSuiAddress();
    }

    private generateSwapDetails() {
        const secret = crypto.randomBytes(32);
        const hashlock = crypto.createHash('sha256').update(secret).digest(); // Use sha256 to match both contracts
        const htlcId = crypto.randomBytes(16).toString('hex'); // Use random hex string for unique ID
        const ethTimelock = Math.floor(Date.now() / 1000) + config.ethTimelockDuration;
        const suiTimelock = Math.floor(Date.now() / 1000) + config.suiTimelockDuration;

        return { 
            secret: "0x" + secret.toString('hex'),
            hashlock: "0x" + Buffer.from(hashlock).toString('hex'),
            htlcId,
            ethTimelock,
            suiTimelock
        };
    }

    async createEthereumHTLC(htlcId: string, receiverAddress: string, hashlock: string, timelock: number, amount: string) {
        console.log("🔗 Creating Ethereum HTLC...");
        console.log(`📝 HTLC ID: ${htlcId}`);
        console.log(`💰 Amount: ${amount} ETH`);
        console.log(`⏰ Timelock: ${new Date(timelock * 1000).toISOString()}`);
        
        const tx = await this.ethContract.createHTLC(
            ethers.utils.id(htlcId),
            receiverAddress,
            hashlock,
            timelock,
            ethers.constants.AddressZero,
            { 
                value: ethers.utils.parseEther(amount),
                gasLimit: 300000 // Set explicit gas limit
            }
        );
        console.log(`⏳ Transaction pending: ${tx.hash}`);
        
        const receipt = await tx.wait();
        console.log("✅ Ethereum HTLC created successfully!");
        console.log(`🔗 Transaction Hash: ${receipt.transactionHash}`);
        console.log(`🔍 Explorer: https://sepolia.etherscan.io/tx/${receipt.transactionHash}`);
        console.log(`⛽ Gas Used: ${receipt.gasUsed.toString()}`);
        console.log(`💸 Gas Price: ${receipt.effectiveGasPrice?.toString()} wei`);
        return receipt;
    }

    async createSuiHTLC(htlcId: string, receiverAddress: string, hashlock: string, timelock: number, amount: string) {
        // Get gas coins first
        const senderAddress = this.suiKeypair.getPublicKey().toSuiAddress();
        console.log("\n🔗 Creating Sui HTLC...");
        console.log(`📝 HTLC ID: ${htlcId}`);
        console.log(`💰 Amount: ${amount} SUI`);
        console.log(`⏰ Timelock: ${new Date(timelock * 1000).toISOString()}`);
        console.log(`👤 Receiver: ${receiverAddress}`);
        
        console.log("\n=== 🔐 Sui Account Details ===");
        console.log("🔑 Private Key:", config.suiPrivateKey);
        console.log("🔑 Public Key:", this.suiKeypair.getPublicKey().toBase64());
        console.log("📍 Address:", senderAddress);
        console.log("=========================\n");

        // Get all coins and log them for debugging
        const coins = await this.suiClient.getCoins({
            owner: senderAddress,
            coinType: "0x2::sui::SUI"
        });
        
        console.log(`\n🔍 Checking coins for address: ${senderAddress}`);
        console.log("📊 Response from getCoins:", JSON.stringify(coins, null, 2));
        
        if (!coins || coins.data.length === 0) {
            throw new Error("❌ No SUI coins found in wallet. Please make sure you have enough SUI for gas and the HTLC amount.");
        }

        console.log("\n💼 Wallet Info:");
        console.log("--------------------------------");
        console.log(`📍 Sender Address: ${senderAddress}`);
        console.log(`🪙 Available Coins: ${coins.data.length}`);
        console.log(`🪙 Using Coin: ${coins.data[0].coinObjectId}`);
        console.log(`💰 Coin Balance: ${coins.data[0].balance} MIST`);
        console.log("--------------------------------\n");
        console.log("\n📋 Creating Sui HTLC with parameters:");
        console.log("--------------------------------");
        console.log(`📝 HTLC ID: ${htlcId}`);
        console.log(`📝 HTLC ID (bytes): ${Array.from(Buffer.from(htlcId))}`);
        console.log(`👤 Receiver Address: ${receiverAddress}`);
        console.log(`🔐 Hashlock: ${hashlock}`);
        console.log(`🔐 Hashlock (bytes): ${Array.from(Buffer.from(hashlock.slice(2), 'hex'))}`);
        console.log(`⏰ Timelock: ${timelock}`);
        console.log(`💰 Amount: ${amount}`);
        console.log(`💰 Amount in MIST: ${Math.floor(parseFloat(amount) * 1e9)}`);
        console.log("--------------------------------\n");
        
        const tx = new Transaction();
        
        // Split coins for payment
        const amountInMist = Math.floor(parseFloat(amount) * 1e9); // Convert to MIST (1 SUI = 10^9 MIST)
        
        // Prepare values for transaction
        const htlcIdBytes = Array.from(Buffer.from(htlcId));
        const hashlockBytes = Array.from(Buffer.from(hashlock.slice(2), 'hex'));
        const receiverAddr = receiverAddress.replace('0x', '');
        
        console.log("\n🔧 Prepared Values:");
        console.log("--------------------------------");
        console.log(`📝 HTLC ID (bytes): ${htlcIdBytes}`);
        console.log(`👤 Receiver (hex): ${receiverAddr}`);
        console.log(`🔐 Hashlock (bytes): ${hashlockBytes}`);
        console.log(`⏰ Timelock: ${timelock}`);
        console.log("--------------------------------\n");

        // Split coins from gas for payment
        const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountInMist)]);

        // Create HTLC with the split coin
        tx.moveCall({
            target: `${config.suiPackageId}::htlc::create_htlc`,
            arguments: [
                tx.object.clock(), // System clock
                tx.pure.vector('u8', htlcIdBytes), // htlc_id as vector<u8>
                tx.pure.address(receiverAddr), // receiver address
                tx.pure.vector('u8', hashlockBytes), // hashlock as vector<u8>
                tx.pure.u64(timelock), // timelock as u64
                paymentCoin // payment coin from gas split
            ]
        });

        console.log("⚙️ Preparing Transaction:");
        console.log("--------------------------------");
        console.log(`🎯 Target: ${config.suiPackageId}::htlc::create_htlc`);
        console.log(`🕐 System Clock: 0x6`);
        console.log(`💰 Payment Coin Amount: ${amountInMist} MIST`);
        console.log("--------------------------------\n");
        
        // Try to execute the transaction with retries
        let retries = 3;
        let result;
        while (retries > 0) {
            try {
                console.log(`⏳ Executing Sui transaction... (${retries} attempts left)`);
                result = await this.suiClient.signAndExecuteTransaction({
                    signer: this.suiKeypair,
                    transaction: tx,
                    options: { 
                        showEffects: true,
                        gasBudget: 100000000 // Set gas budget to 0.1 SUI
                    }
                });
                break;
            } catch (error) {
                if (error.message.includes('fetch failed') && retries > 1) {
                    console.log(`🔄 Network error, retrying... (${retries - 1} attempts left)`);
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
                    retries--;
                } else {
                    throw error;
                }
            }
        }
        
        console.log("✅ Sui HTLC created successfully!");
        console.log(`🔗 Transaction Hash: ${result.digest}`);
        console.log(`🔍 Explorer: https://suiexplorer.com/txblock/${result.digest}?network=testnet`);
        console.log(`⛽ Gas Used: ${result.effects?.gasUsed?.computationCost || 'N/A'}`);
        console.log(`💰 Storage Cost: ${result.effects?.gasUsed?.storageCost || 'N/A'}`);
        return result;
    }

    async claimEthereumHTLC(htlcId: string, secret: string) {
        console.log("🔓 Claiming Ethereum HTLC...");
        console.log(`📝 HTLC ID: ${htlcId}`);
        console.log(`🔐 Secret: ${secret}`);
        
        const tx = await this.ethContract.claimHTLC(
            ethers.utils.id(htlcId),
            secret
        );
        console.log(`⏳ Transaction pending: ${tx.hash}`);
        
        const receipt = await tx.wait();
        console.log("✅ Ethereum HTLC claimed successfully!");
        console.log(`🔗 Transaction Hash: ${receipt.transactionHash}`);
        console.log(`🔍 Explorer: https://sepolia.etherscan.io/tx/${receipt.transactionHash}`);
        console.log(`⛽ Gas Used: ${receipt.gasUsed.toString()}`);
        console.log(`💸 Gas Price: ${receipt.effectiveGasPrice?.toString()} wei`);
        return receipt;
    }

    async claimSuiHTLC(htlcId: string, secret: string, hashlock: string, htlcTxDigest: string) {
        console.log("🔓 Claiming Sui HTLC...");
        console.log(`📝 HTLC ID: ${htlcId}`);
        console.log(`🔐 Secret: ${secret}`);
        console.log(`🔗 HTLC Transaction Digest: ${htlcTxDigest}`);
        const tx = new Transaction();
        
        // Get the HTLC object from the transaction digest
        console.log("🔍 Fetching HTLC transaction details...");
        const htlcTx = await this.suiClient.getTransactionBlock({
            digest: htlcTxDigest,
            options: {
                showEffects: true,
                showInput: true,
                showEvents: true,
                showObjectChanges: true,
                showBalanceChanges: true
            }
        });
        console.log("📊 HTLC transaction:", htlcTx);

        // Find the created HTLC object from the transaction effects
        console.log("🔍 Searching for HTLC object in transaction...");
        const htlcObject = htlcTx.objectChanges.find(change => 
            change.type === 'created' && 
            change.objectType.includes('::htlc::HTLC')
        );

        if (!htlcObject) {
            throw new Error("❌ HTLC object not found in transaction");
        }

        console.log("✅ Found HTLC object:", htlcObject);

        // Get the current state of the HTLC object to debug
        try {
            console.log("🔍 Fetching HTLC object details...");
            const htlcObjectDetails = await this.suiClient.getObject({
                id: htlcObject.objectId,
                options: {
                    showContent: true,
                    showType: true,
                    showOwner: true,
                    showPreviousTransaction: true,
                    showDisplay: false,
                    showBcs: false,
                    showStorageRebate: false
                }
            });
            console.log("📊 HTLC Object Details:", JSON.stringify(htlcObjectDetails, null, 2));
        } catch (error) {
            console.log("❌ Error fetching HTLC object details:", error);
        }

        // Debug: Verify the secret hash matches the hashlock
        console.log("🔐 Verifying secret hash matches hashlock...");
        const secretBytes = Array.from(Buffer.from(secret.slice(2), 'hex'));
        // Use sha256 to match both contracts
        const secretHash = crypto.createHash('sha256').update(Buffer.from(secretBytes)).digest();
        const expectedHashlock = Array.from(Buffer.from(hashlock.slice(2), 'hex'));
        
        console.log("🔍 Secret verification:");
        console.log(`🔐 Secret bytes: ${secretBytes}`);
        console.log(`🔐 Secret hash (sha256): ${Array.from(secretHash)}`);
        console.log(`🔐 Expected hashlock: ${expectedHashlock}`);
        console.log(`✅ Hashes match: ${JSON.stringify(secretHash) === JSON.stringify(Buffer.from(hashlock.slice(2), 'hex'))}`);

        // Call claim_with_secret with the HTLC object
        console.log("⚙️ Building claim transaction...");
        tx.moveCall({
            target: `${config.suiPackageId}::htlc::claim_with_secret`,
            arguments: [
                tx.object.clock(), // System clock
                tx.object(htlcObject.objectId), // HTLC object
                tx.pure.vector('u8', secretBytes) // secret as vector<u8>
            ]
        });
        
        // Try to execute the transaction with retries
        let retries = 3;
        let result;
        while (retries > 0) {
            try {
                console.log(`⏳ Executing Sui claim transaction... (${retries} attempts left)`);
                result = await this.suiClient.signAndExecuteTransaction({
                    signer: this.suiKeypair,
                    transaction: tx,
                    options: { 
                        showEffects: true,
                        gasBudget: 100000000 // Set gas budget to 0.1 SUI
                    }
                });
                break;
            } catch (error) {
                if (error.message.includes('fetch failed') && retries > 1) {
                    console.log(`🔄 Network error, retrying... (${retries - 1} attempts left)`);
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
                    retries--;
                } else {
                    throw error;
                }
            }
        }
        
        console.log("✅ Sui HTLC claimed successfully!");
        console.log(`🔗 Transaction Hash: ${result.digest}`);
        console.log(`🔍 Explorer: https://suiexplorer.com/txblock/${result.digest}?network=testnet`);
        console.log(`⛽ Gas Used: ${result.effects?.gasUsed?.computationCost || 'N/A'}`);
        console.log(`💰 Storage Cost: ${result.effects?.gasUsed?.storageCost || 'N/A'}`);
        return result;
    }

    async performETHtoSUISwap(
        ethAmount: string,
        suiAmount: string,
        ethReceiverAddress: string,
        suiReceiverAddress: string
    ): Promise<boolean> {
        try {
            console.log("\n🚀 Starting ETH to SUI Atomic Swap...");
            console.log("=====================================");
            console.log(`💰 ETH Amount: ${ethAmount}`);
            console.log(`💰 SUI Amount: ${suiAmount}`);
            console.log(`👤 ETH Receiver: ${ethReceiverAddress}`);
            console.log(`👤 SUI Receiver: ${suiReceiverAddress}`);
            console.log("=====================================\n");
            
            // Generate swap details
            const { secret, hashlock, htlcId, ethTimelock, suiTimelock } = this.generateSwapDetails();
            console.log("🎲 Generated swap details:");
            console.log(`📝 HTLC ID: ${htlcId}`);
            console.log(`🔐 Hashlock: ${hashlock}`);
            console.log(`🔐 Secret: ${secret}`);
            console.log(`⏰ ETH Timelock: ${new Date(ethTimelock * 1000).toISOString()}`);
            console.log(`⏰ SUI Timelock: ${new Date(suiTimelock * 1000).toISOString()}\n`);

            // Step 1: Create Ethereum HTLC
            console.log("📋 Step 1: Creating Ethereum HTLC...");
            const ethHtlcResult = await this.createEthereumHTLC(
                htlcId,
                ethReceiverAddress,
                hashlock,
                ethTimelock,
                ethAmount
            );

            // Step 2: Create Sui HTLC
            console.log("\n📋 Step 2: Creating Sui HTLC...");
            const suiHtlcResult = await this.createSuiHTLC(
                htlcId,
                suiReceiverAddress,
                hashlock,
                suiTimelock,
                suiAmount
            );

            // Wait for the HTLC transaction to be finalized
            console.log("⏳ Waiting for Sui HTLC transaction to be finalized...");
            await this.suiClient.waitForTransaction({
                digest: suiHtlcResult.digest
            });
            console.log("✅ Sui HTLC transaction finalized!");

            // Step 3: Claim Sui HTLC (reveals secret)
            console.log("\n📋 Step 3: Claiming Sui HTLC (revealing secret)...");
            const suiClaimResult = await this.claimSuiHTLC(htlcId, secret, hashlock, suiHtlcResult.digest);

            // Step 4: Claim Ethereum HTLC (using revealed secret)
            console.log("\n📋 Step 4: Claiming Ethereum HTLC (using revealed secret)...");
            const ethClaimResult = await this.claimEthereumHTLC(htlcId, secret);

            console.log("\n🎉 ATOMIC SWAP COMPLETED SUCCESSFULLY! 🎉");
            console.log("==========================================");
            console.log("📊 Transaction Summary:");
            console.log(`🔗 ETH HTLC Created: ${ethHtlcResult.transactionHash}`);
            console.log(`🔗 SUI HTLC Created: ${suiHtlcResult.digest}`);
            console.log(`🔗 SUI HTLC Claimed: ${suiClaimResult.digest}`);
            console.log(`🔗 ETH HTLC Claimed: ${ethClaimResult.transactionHash}`);
            console.log("==========================================");
            console.log("🔗 All Transaction Hashes with Explorer Links:");
            console.log(`1️⃣  ETH HTLC Creation: ${ethHtlcResult.transactionHash}`);
            console.log(`    🔍 Explorer: https://sepolia.etherscan.io/tx/${ethHtlcResult.transactionHash}`);
            console.log(`2️⃣  SUI HTLC Creation: ${suiHtlcResult.digest}`);
            console.log(`    🔍 Explorer: https://suiexplorer.com/txblock/${suiHtlcResult.digest}?network=testnet`);
            console.log(`3️⃣  SUI HTLC Claim: ${suiClaimResult.digest}`);
            console.log(`    🔍 Explorer: https://suiexplorer.com/txblock/${suiClaimResult.digest}?network=testnet`);
            console.log(`4️⃣  ETH HTLC Claim: ${ethClaimResult.transactionHash}`);
            console.log(`    🔍 Explorer: https://sepolia.etherscan.io/tx/${ethClaimResult.transactionHash}`);
            console.log("==========================================");
            return true;

        } catch (error) {
            console.error("❌ Error during swap:", error);
            throw error;
        }
    }
}

// Example usage
async function runExample() {
    console.log("🚀 Starting ETH to SUI Atomic Swap Example...");
    const swap = new AtomicSwap();
    
    try {
        // Get the Sui sender address to use as receiver for testing
        const suiSenderAddress = swap.getSuiAddress();
        console.log(`📍 Using Sui address: ${suiSenderAddress}`);
        
        await swap.performETHtoSUISwap(
            "0.000001", // ETH amount (very small amount for testing)
            "0.001", // SUI amount
            process.env.ETH_RECEIVER_ADDRESS, // Your ETH address
            suiSenderAddress  // Use same address as sender for testing
        );
    } catch (error) {
        console.error("❌ Swap failed:", error);
    }
}

// Export for external use
export { AtomicSwap, runExample };

// Run the example if this file is run directly
if (require.main === module) {
    runExample().catch(console.error);
}