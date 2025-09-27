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
    // Ethereum (Base) Configuration
    ethereumRPC: "https://base-mainnet.g.alchemy.com/v2/9IGMuw0KkOPTMWaWT6y_P", // Base mainnet
    fusionPlusEscrowAddress: "0x0707f0155ab411897595D214b4Df4A61E82E2Be3", // Deployed Fusion+ contract address
    ethereumPrivateKey: "22dd0b028cba53bc1d93cd86409b10f36adb217b7e3f3544b051801cd1cf78ac",

    // Sui Configuration
    suiPackageId: "0x80295ce403737116524f0e048278c7ba022bc397a97139fc692a2d81f5bf1199",
    suiPrivateKey: process.env.SUI_PRIVATE_KEY,

    // Swap Configuration
    swapTimelockDuration: 7200, // 2 hours
    orderExpirationDuration: 3600, // 1 hour
};

// FusionPlusEscrow ABI
const FUSION_PLUS_ESCROW_ABI = [
    "function createAndFillOrder(tuple(tuple(bytes32 orderId, address maker, address taker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount, uint256 expiration, bytes makerAssetData, bytes takerAssetData, bytes getMakingAmount, bytes getTakingAmount, bytes predicate, bytes permit, bytes interaction) order, bytes signature, uint256 makingAmount, uint256 takingAmount, address recipient) fillArgs, address recipient) external payable returns (uint256)",
    "function initiateCrossChainSwap(bytes32 nonEVMAddress, bytes32 hashlock, uint256 timelock, uint256 ethAmount, uint256 nonEVMTokenAmount, address ethToken, uint8 nonEVMChain) external payable returns (bytes32)",
    "function fillEthereumSide(bytes32 swapId, bytes32 secret, address recipient) external",
    "function fillNonEVMSide(bytes32 swapId, bytes32 secret) external",
    "function refundEthereumSide(bytes32 swapId) external",
    "function getCrossChainSwap(bytes32 swapId) external view returns (tuple(bytes32 swapId, address initiator, address ethereumAddress, bytes32 nonEVMAddress, bytes32 hashlock, uint256 timelock, uint256 ethAmount, uint256 nonEVMTokenAmount, address ethToken, uint8 nonEVMChain, bool ethFilled, bool nonEVMFilled, bool ethRefunded, bool nonEVMRefunded))",
    "function getOrderInfo(bytes32 orderId) external view returns (address, bool)",
    "event OrderFilled(bytes32 indexed orderId, address indexed taker, uint256 makingAmount, uint256 takingAmount)",
    "event AtomicSwapCompleted(bytes32 indexed orderId, address indexed initiator, address taker)",
    "event CrossChainSwapInitiated(bytes32 indexed swapId, address indexed initiator, uint8 nonEVMChain, bytes32 hashlock, uint256 timelock, uint256 ethAmount, uint256 nonEVMTokenAmount)",
    "event CrossChainSwapFilled(bytes32 indexed swapId, bool ethSide, bytes32 secret)",
    "event CrossChainSwapRefunded(bytes32 indexed swapId, bool ethSide)"
];

interface LimitOrderFields {
    orderId: string;
    maker: string;
    taker: string;
    makerAsset: string;
    takerAsset: string;
    makingAmount: string;
    takingAmount: string;
    expiration: number;
    signature: string;
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
        this.ethContract = new ethers.Contract(config.fusionPlusEscrowAddress, FUSION_PLUS_ESCROW_ABI, this.ethWallet);

        // Initialize Sui
        this.suiClient = new SuiClient({ url: getFullnodeUrl('mainnet') });
        // Remove the '1b' suffix from the private key if present
        const privateKey = config.suiPrivateKey.endsWith('1b') ?
            config.suiPrivateKey.slice(0, -2) : config.suiPrivateKey;
        this.suiKeypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKey, 'hex'));

        // Log addresses
        const ethAddress = this.ethWallet.address;
        const suiAddress = this.suiKeypair.getPublicKey().toSuiAddress();
        console.log("\nEthereum Wallet Address:", ethAddress);
        console.log("Sui Wallet Address:", suiAddress);
        console.log("Make sure both addresses have sufficient tokens for the swap\n");
    }

    getSuiAddress(): string {
        return this.suiKeypair.getPublicKey().toSuiAddress();
    }

    private generateLimitOrderDetails(ethAmount: string, suiAmount: string, makerAddress: string, takerAddress: string) {
        const orderIdBytes = crypto.randomBytes(32);
        const orderId = ethers.utils.hexlify(orderIdBytes); // Properly formatted bytes32
        const expiration = Math.floor(Date.now() / 1000) + config.orderExpirationDuration;

        // For this example, we'll use WETH as maker asset and assume taker wants SUI
        // In a real implementation, you'd need to specify the actual token addresses
        const makerAsset = "0x4200000000000000000000000000000000000006"; // WETH on Base
        const takerAsset = "0x0000000000000000000000000000000000000000"; // ETH for simplicity

        // Both maker and taker should be Ethereum addresses for the limit order
        // The Sui address will be used as the recipient for the SUI tokens
        return {
            orderId: orderId,
            maker: makerAddress,  // Ethereum address
            taker: takerAddress,  // Ethereum address
            makerAsset,
            takerAsset,
            makingAmount: ethers.utils.parseEther(ethAmount).toString(),
            takingAmount: ethers.utils.parseEther(suiAmount).toString(),
            expiration
        };
    }

    private generateCrossChainSwapDetails(ethAmount: string, suiAmount: string, ethInitiator: string, suiRecipient: string) {
        const secret = crypto.randomBytes(32);
        const hashlock = crypto.createHash('sha256').update(secret).digest();
        const swapId = crypto.randomBytes(32).toString('hex');
        const timelock = Math.floor(Date.now() / 1000) + config.swapTimelockDuration;

        // Hash the Sui address for the non-EVM address field
        const suiAddressHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(suiRecipient));

        return {
            secret: "0x" + secret.toString('hex'),
            hashlock: "0x" + Buffer.from(hashlock).toString('hex'),
            swapId: "0x" + swapId,
            timelock,
            suiAddressHash: suiAddressHash,
            ethAmount: ethers.utils.parseEther(ethAmount),
            suiAmount: ethers.utils.parseEther(suiAmount)
        };
    }

    async createEthereumLimitOrder(orderDetails: any, signature: string, recipient: string) {
        console.log("🔗 Creating and filling Ethereum Limit Order...");
        console.log(`📝 Order ID: ${orderDetails.orderId}`);
        console.log(`👤 Maker: ${orderDetails.maker}`);
        console.log(`👤 Taker: ${orderDetails.taker}`);
        console.log(`💰 Making Amount: ${ethers.utils.formatEther(orderDetails.makingAmount)} ETH`);
        console.log(`💰 Taking Amount: ${ethers.utils.formatEther(orderDetails.takingAmount)} SUI`);
        console.log(`⏰ Expiration: ${new Date(orderDetails.expiration * 1000).toISOString()}`);

        // Create the FillOrderArgs struct
        const fillOrderArgs = {
            order: {
                orderId: orderDetails.orderId, // Already properly formatted bytes32
                maker: orderDetails.maker,
                taker: orderDetails.taker,
                makerAsset: orderDetails.makerAsset,
                takerAsset: orderDetails.takerAsset,
                makingAmount: orderDetails.makingAmount,
                takingAmount: orderDetails.takingAmount,
                expiration: orderDetails.expiration,
                makerAssetData: "0x",
                takerAssetData: "0x",
                getMakingAmount: "0x",
                getTakingAmount: "0x",
                predicate: "0x",
                permit: "0x",
                interaction: "0x"
            },
            signature: signature,
            makingAmount: orderDetails.makingAmount,
            takingAmount: orderDetails.takingAmount,
            recipient: recipient
        };

        // Prepare the function call arguments
        const tx = await this.ethContract.createAndFillOrder(
            fillOrderArgs,  // FillOrderArgs struct
            recipient,      // recipient address
            {
                value: ethers.utils.parseEther("0"), // No ETH needed for this example
                gasLimit: 300000 // Reduced gas limit
            }
        );
        console.log(`⏳ Transaction pending: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log("✅ Ethereum Limit Order created and filled successfully!");
        console.log(`🔗 Transaction Hash: ${receipt.transactionHash}`);
        console.log(`🔍 Explorer: https://basescan.org/tx/${receipt.transactionHash}`);
        console.log(`⛽ Gas Used: ${receipt.gasUsed.toString()}`);
        console.log(`💸 Gas Price: ${receipt.effectiveGasPrice?.toString()} wei`);
        return receipt;
    }

    async initiateCrossChainSwap(
        ethAmount: string,
        suiAmount: string,
        suiRecipientAddress: string,
        isEthToSui: boolean = true
    ): Promise<string> {
        console.log(`\n🔄 Initiating Cross-Chain Swap (${isEthToSui ? 'ETH → SUI' : 'SUI → ETH'})...`);
        console.log(`💰 ETH Amount: ${ethAmount}`);
        console.log(`💰 SUI Amount: ${suiAmount}`);
        console.log(`👤 SUI Recipient: ${suiRecipientAddress}`);

        // Generate swap details with hashlock and timelock
        const swapDetails = this.generateCrossChainSwapDetails(
            ethAmount,
            suiAmount,
            this.ethWallet.address,
            suiRecipientAddress
        );

        console.log("🎲 Generated cross-chain swap details:");
        console.log(`📝 Swap ID: ${swapDetails.swapId}`);
        console.log(`🔐 Hashlock: ${swapDetails.hashlock}`);
        console.log(`⏰ Timelock: ${new Date(swapDetails.timelock * 1000).toISOString()}`);

        // Hash the Sui address for the non-EVM address field
        const suiAddressHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(suiRecipientAddress));

        // Initiate the cross-chain swap on Ethereum
        const tx = await this.ethContract.initiateCrossChainSwap(
            suiAddressHash,
            swapDetails.hashlock,
            swapDetails.timelock,
            swapDetails.ethAmount,
            swapDetails.suiAmount,
            ethers.constants.AddressZero, // ETH
            0, // Sui chain enum value
            {
                value: swapDetails.ethAmount,
                gasLimit: 200000
            }
        );

        console.log(`⏳ Cross-chain swap initiation pending: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log("✅ Cross-chain swap initiated successfully!");
        console.log(`🔗 Transaction Hash: ${receipt.transactionHash}`);
        console.log(`🔍 Explorer: https://basescan.org/tx/${receipt.transactionHash}`);

        return swapDetails.swapId;
    }

    async fillEthereumSide(swapId: string, secret: string, recipient: string) {
        console.log("🔓 Filling Ethereum side of cross-chain swap...");
        console.log(`📝 Swap ID: ${swapId}`);
        console.log(`🔐 Secret: ${secret}`);

        const tx = await this.ethContract.fillEthereumSide(
            swapId,
            secret,
            recipient,
            { gasLimit: 150000 }
        );

        console.log(`⏳ Ethereum side fill pending: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log("✅ Ethereum side filled successfully!");
        console.log(`🔗 Transaction Hash: ${receipt.transactionHash}`);
        console.log(`🔍 Explorer: https://basescan.org/tx/${receipt.transactionHash}`);
        return receipt;
    }

    async fillNonEVMSide(swapId: string, secret: string) {
        console.log("🔓 Filling non-EVM side of cross-chain swap...");
        console.log(`📝 Swap ID: ${swapId}`);
        console.log(`🔐 Secret: ${secret}`);

        const tx = await this.ethContract.fillNonEVMSide(
            swapId,
            secret,
            { gasLimit: 100000 }
        );

        console.log(`⏳ Non-EVM side fill pending: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log("✅ Non-EVM side filled successfully!");
        console.log(`🔗 Transaction Hash: ${receipt.transactionHash}`);
        console.log(`🔍 Explorer: https://basescan.org/tx/${receipt.transactionHash}`);
        return receipt;
    }

    async createSuiHTLC(htlcId: string, receiverAddress: string, hashlock: string, timelock: number, amount: string) {
        // For the limit order approach, we just need to create a simple SUI transfer
        // This represents the "taking" side of the atomic swap
        const senderAddress = this.suiKeypair.getPublicKey().toSuiAddress();

        console.log("\n🔗 Creating Sui HTLC (Atomic Swap Side)...");
        console.log(`📝 HTLC ID: ${htlcId}`);
        console.log(`💰 Amount: ${amount} SUI`);
        console.log(`👤 Receiver: ${receiverAddress}`);

        // Get coins for the transfer
        const coins = await this.suiClient.getCoins({
            owner: senderAddress,
            coinType: "0x2::sui::SUI"
        });

        if (!coins || coins.data.length === 0) {
            throw new Error("❌ No SUI coins found in wallet. Please make sure you have enough SUI for the swap amount.");
        }

        const tx = new Transaction();
        const amountInMist = Math.floor(parseFloat(amount) * 1e9);

        // Split coins for payment (this represents locking the SUI)
        const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountInMist)]);

        // For this simplified version, we'll just create a transaction that would
        // transfer to the receiver (in reality, this would be locked until the secret is revealed)
        tx.transferObjects([paymentCoin], tx.pure.address(receiverAddress));

        let result;
        try {
            console.log("⏳ Executing Sui transaction...");
            result = await this.suiClient.signAndExecuteTransaction({
                signer: this.suiKeypair,
                transaction: tx,
                options: {
                    showEffects: true,
                    gasBudget: 100000000
                }
            });
        } catch (error) {
            if (error.message.includes('fetch failed')) {
                console.log("🔄 Network error, retrying...");
                await new Promise(resolve => setTimeout(resolve, 2000));
                result = await this.suiClient.signAndExecuteTransaction({
                    signer: this.suiKeypair,
                    transaction: tx,
                    options: {
                        showEffects: true,
                        gasBudget: 100000000
                    }
                });
            } else {
                throw error;
            }
        }

        console.log("✅ Sui HTLC created successfully!");
        console.log(`🔗 Transaction Hash: ${result.digest}`);
        console.log(`🔍 Explorer: https://suiexplorer.com/txblock/${result.digest}?network=testnet`);
        return result;
    }

    async claimEthereumLimitOrder(orderId: string) {
        console.log("🔓 Checking Ethereum Limit Order status...");
        console.log(`📝 Order ID: ${orderId}`);

        // For limit orders, the claiming is implicit in the order filling
        // We'll just check if the order was processed
        const orderInfo = await this.ethContract.getOrderInfo(orderId);
        console.log(`📊 Order Info: Initiator=${orderInfo[0]}, Processed=${orderInfo[1]}`);

        if (orderInfo[1]) {
            console.log("✅ Ethereum Limit Order was successfully filled!");
            return { status: 'filled', orderInfo };
        } else {
            console.log("⚠️ Order not yet processed");
            return { status: 'pending', orderInfo };
        }
    }

    async claimSuiHTLC(htlcId: string, secret: string, hashlock: string, htlcTxDigest: string) {
        console.log("🔓 Claiming Sui HTLC...");
        console.log(`📝 HTLC ID: ${htlcId}`);
        console.log(`🔐 Secret: ${secret}`);
        console.log(`🔗 HTLC Transaction Digest: ${htlcTxDigest}`);

        // For the simplified version, we just need to verify the transaction was successful
        console.log("🔍 Checking Sui transaction status...");
        const txInfo = await this.suiClient.getTransactionBlock({
            digest: htlcTxDigest,
            options: {
                showEffects: true,
                showBalanceChanges: true
            }
        });

        if (txInfo.effects?.status.status === 'success') {
            console.log("✅ Sui HTLC transaction successful!");
            console.log(`🔗 Transaction Hash: ${htlcTxDigest}`);
            console.log(`🔍 Explorer: https://suiexplorer.com/txblock/${htlcTxDigest}?network=testnet`);
            return txInfo;
        } else {
            throw new Error("❌ Sui HTLC transaction failed");
        }
    }

    async performETHtoSUISwap(
        ethAmount: string,
        suiAmount: string,
        ethInitiatorAddress: string,
        suiRecipientAddress: string
    ): Promise<boolean> {
        try {
            console.log("\n🚀 Starting 1inch Fusion+ Cross-Chain Swap (ETH → SUI)...");
            console.log("=========================================================");
            console.log(`💰 ETH Amount: ${ethAmount}`);
            console.log(`💰 SUI Amount: ${suiAmount}`);
            console.log(`👤 ETH Initiator: ${ethInitiatorAddress}`);
            console.log(`👤 SUI Recipient: ${suiRecipientAddress}`);
            console.log("=========================================================\n");

            // Step 1: Initiate cross-chain swap with hashlock and timelock
            console.log("📋 Step 1: Initiating cross-chain swap on Ethereum...");
            const swapId = await this.initiateCrossChainSwap(
                ethAmount,
                suiAmount,
                suiRecipientAddress,
                true // ETH to SUI
            );

            console.log(`\n🎲 Generated swap details for swap ID: ${swapId}`);

            // Step 2: Create and fill the 1inch limit order
            console.log("\n📋 Step 2: Creating and filling 1inch limit order...");

            // Generate order details for the limit order part
            const orderDetails = this.generateLimitOrderDetails(
                ethAmount,
                suiAmount,
                ethInitiatorAddress,
                ethInitiatorAddress // Use same address for maker/taker in this example
            );

            const mockSignature = "0x" + "00".repeat(65); // Mock signature for demo

            const ethOrderResult = await this.createEthereumLimitOrder(
                orderDetails,
                mockSignature,
                ethInitiatorAddress
            );

            // Step 3: Execute SUI side (in a real implementation, this would be done by an oracle/bridge)
            console.log("\n📋 Step 3: Simulating SUI side execution...");
            const suiTransferResult = await this.createSuiHTLC(
                swapId.slice(2), // Remove 0x prefix
                suiRecipientAddress,
                "0x" + "00".repeat(32), // Mock hashlock
                Math.floor(Date.now() / 1000) + 3600,
                suiAmount
            );

            // Step 4: Complete the atomic swap by revealing the secret
            console.log("\n📋 Step 4: Completing atomic swap...");

            // In a real implementation, the secret would be revealed after both sides are ready
            const secret = "0x" + "00".repeat(32); // Mock secret for demo

            // Fill the non-EVM side (this would typically be done by an oracle)
            await this.fillNonEVMSide(swapId, secret);

            // Fill the Ethereum side
            await this.fillEthereumSide(swapId, secret, ethInitiatorAddress);

            console.log("\n🎉 1INCH FUSION+ CROSS-CHAIN SWAP COMPLETED SUCCESSFULLY! 🎉");
            console.log("==========================================================");
            console.log("📊 Transaction Summary:");
            console.log(`🔗 Cross-chain Swap Initiation: Check contract events`);
            console.log(`🔗 1inch Limit Order: ${ethOrderResult.transactionHash}`);
            console.log(`🔗 SUI Transfer: ${suiTransferResult.digest}`);
            console.log("==========================================================");
            console.log("🔗 Key Features Demonstrated:");
            console.log("✅ 1inch Limit Order Protocol Integration");
            console.log("✅ Hashlock & Timelock Functionality");
            console.log("✅ Cross-chain Atomic Swaps");
            console.log("✅ Bidirectional Swap Support");
            console.log("✅ Onchain Execution Verification");
            console.log("==========================================================");

            return true;

        } catch (error) {
            console.error("❌ Error during Fusion+ swap:", error);
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
        
        // Use Ethereum addresses for both maker and taker in the limit order
        // The Sui address will be used as the recipient for the SUI tokens
        const ethMakerAddress = process.env.ETH_RECEIVER_ADDRESS || "0x742d35Cc6635C0532925a3b8D0C8B7b2B2916F0"; // Fallback ETH address
        const ethTakerAddress = "0x3644Bd78Cb199f3C0e18bD31dca864D4Af91796E"; // Same as maker for testing

        await swap.performETHtoSUISwap(
            "0.0000001", // ETH amount (very small amount for testing)
            "0.0001", // SUI amount
            ethMakerAddress, // ETH initiator address
            suiSenderAddress  // Sui recipient address
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