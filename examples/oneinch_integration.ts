import { ethers } from 'ethers';
import { JsonRpcProvider } from '@ethersproject/providers';
import * as crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Configuration
const config = {
    // Ethereum (Sepolia) Configuration
    ethereumRPC: "https://ethereum-sepolia-rpc.publicnode.com",
    htlcAddress: "0x239f06e80631C1347876FE256Cc43BA79641e53F", // Update with deployed HTLC address
    oneInchIntegrationAddress: "0x0000000000000000000000000000000000000000", // Update with deployed OneInchIntegration address
    oneInchLimitOrderProtocol: "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch Limit Order Protocol address
    ethereumPrivateKey: process.env.ETH_PRIVATE_KEY,
};

// HTLC ABI (updated with 1inch integration functions)
const HTLC_ABI = [
    "function createHTLC(bytes32 _htlc_id, address _receiver, bytes32 _hashlock, uint256 _timelock, address _token) external payable",
    "function claimHTLC(bytes32 _htlc_id, bytes32 _secret) external",
    "function refundHTLC(bytes32 _htlc_id) external",
    "function getHTLC(bytes32 _htlc_id) external view returns (bytes32, bytes32, uint256, address, address, uint256, bytes32, bool, bool, uint256, address)",
    "function getSecret(bytes32 _htlc_id) external view returns (bytes32)",
    "function setOneInchIntegration(address _oneInchIntegration) external",
    "function executeOneInchOrder(bytes32 _htlc_id, tuple(address maker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount, address receiver, address allowedSender, uint256 salt, bytes makerAssetData, bytes takerAssetData, bytes getMakerAmount, bytes getTakerAmount, bytes predicate, bytes permit, bytes interaction) order, bytes signature, bytes interaction, uint256 makingAmount, uint256 takingAmount, uint256 thresholdAmount) external",
    "function executeOneInchOrderWithPermit(bytes32 _htlc_id, tuple(address maker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount, address receiver, address allowedSender, uint256 salt, bytes makerAssetData, bytes takerAssetData, bytes getMakerAmount, bytes getTakerAmount, bytes predicate, bytes permit, bytes interaction) order, bytes signature, bytes interaction, uint256 makingAmount, uint256 takingAmount, uint256 thresholdAmount, bytes permit) external",
    "function canExecuteOrder(bytes32 _htlc_id, tuple(address maker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount, address receiver, address allowedSender, uint256 salt, bytes makerAssetData, bytes takerAssetData, bytes getMakerAmount, bytes getTakerAmount, bytes predicate, bytes permit, bytes interaction) order, uint256 makingAmount, uint256 takingAmount) external view returns (bool)",
    "event HTLCCreated(bytes32 indexed htlc_id, address indexed sender, address indexed receiver, uint256 amount, bytes32 hashlock, uint256 timelock, address token)",
    "event HTLCClaimed(bytes32 indexed htlc_id, address indexed receiver, bytes32 secret, uint256 amount)",
    "event HTLCRefunded(bytes32 indexed htlc_id, address indexed sender, uint256 amount)",
    "event OneInchIntegrationSet(address indexed oneInchIntegration)",
    "event OrderExecuted(bytes32 indexed htlc_id, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)"
];

// OneInch Integration ABI
const ONEINCH_INTEGRATION_ABI = [
    "function fillOrderForHTLC(bytes32 htlcId, tuple(address maker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount, address receiver, address allowedSender, uint256 salt, bytes makerAssetData, bytes takerAssetData, bytes getMakerAmount, bytes getTakerAmount, bytes predicate, bytes permit, bytes interaction) order, bytes signature, bytes interaction, uint256 makingAmount, uint256 takingAmount, uint256 thresholdAmount) external",
    "function fillOrderWithPermit(bytes32 htlcId, tuple(address maker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount, address receiver, address allowedSender, uint256 salt, bytes makerAssetData, bytes takerAssetData, bytes getMakerAmount, bytes getTakerAmount, bytes predicate, bytes permit, bytes interaction) order, bytes signature, bytes interaction, uint256 makingAmount, uint256 takingAmount, uint256 thresholdAmount, bytes permit) external",
    "function canFillOrder(tuple(address maker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount, address receiver, address allowedSender, uint256 salt, bytes makerAssetData, bytes takerAssetData, bytes getMakerAmount, bytes getTakerAmount, bytes predicate, bytes permit, bytes interaction) order, uint256 makingAmount, uint256 takingAmount) external view returns (bool)",
    "event OrderFilled(bytes32 indexed htlcId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address orderMaker)",
    "event OrderFillFailed(bytes32 indexed htlcId, string reason)"
];

// ERC20 ABI for token operations
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

interface OneInchOrder {
    maker: string;
    makerAsset: string;
    takerAsset: string;
    makingAmount: string;
    takingAmount: string;
    receiver: string;
    allowedSender: string;
    salt: string;
    makerAssetData: string;
    takerAssetData: string;
    getMakerAmount: string;
    getTakerAmount: string;
    predicate: string;
    permit: string;
    interaction: string;
}

class OneInchHTLCSwap {
    private provider: JsonRpcProvider;
    private wallet: ethers.Wallet;
    private htlcContract: ethers.Contract;
    private oneInchIntegration: ethers.Contract;

    constructor() {
        this.provider = new JsonRpcProvider(config.ethereumRPC);
        this.wallet = new ethers.Wallet(config.ethereumPrivateKey!, this.provider);
        this.htlcContract = new ethers.Contract(config.htlcAddress, HTLC_ABI, this.wallet);
        this.oneInchIntegration = new ethers.Contract(config.oneInchIntegrationAddress, ONEINCH_INTEGRATION_ABI, this.wallet);
    }

    /**
     * Create an HTLC with 1inch integration capability
     */
    async createHTLCWithOneInch(
        receiver: string,
        tokenAddress: string,
        amount: string,
        timelock: number
    ): Promise<string> {
        const htlcId = crypto.randomBytes(32);
        const secret = crypto.randomBytes(32);
        const hashlock = ethers.utils.keccak256(secret);

        console.log(`Creating HTLC with 1inch integration capability...`);
        console.log(`HTLC ID: ${ethers.utils.hexlify(htlcId)}`);
        console.log(`Secret: ${ethers.utils.hexlify(secret)}`);
        console.log(`Hashlock: ${hashlock}`);

        // Approve token transfer if not ETH
        if (tokenAddress !== ethers.constants.AddressZero) {
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);
            const tx = await tokenContract.approve(config.htlcAddress, amount);
            await tx.wait();
            console.log(`Token approval transaction: ${tx.hash}`);
        }

        // Create HTLC
        const tx = await this.htlcContract.createHTLC(
            ethers.utils.hexlify(htlcId),
            receiver,
            hashlock,
            Math.floor(Date.now() / 1000) + timelock,
            tokenAddress,
            { value: tokenAddress === ethers.constants.AddressZero ? amount : 0 }
        );

        const receipt = await tx.wait();
        console.log(`HTLC created: ${tx.hash}`);

        return ethers.utils.hexlify(htlcId);
    }

    /**
     * Execute a 1inch order as part of HTLC swap
     */
    async executeOneInchOrder(
        htlcId: string,
        order: OneInchOrder,
        signature: string,
        interaction: string,
        makingAmount: string,
        takingAmount: string,
        thresholdAmount: string
    ): Promise<string> {
        console.log(`Executing 1inch order for HTLC: ${htlcId}`);

        // Check if order can be executed
        const canExecute = await this.htlcContract.canExecuteOrder(
            htlcId,
            order,
            makingAmount,
            takingAmount
        );

        if (!canExecute) {
            throw new Error("Order cannot be executed");
        }

        // Execute the order
        const tx = await this.htlcContract.executeOneInchOrder(
            htlcId,
            order,
            signature,
            interaction,
            makingAmount,
            takingAmount,
            thresholdAmount
        );

        const receipt = await tx.wait();
        console.log(`1inch order executed: ${tx.hash}`);

        return tx.hash;
    }

    /**
     * Execute a 1inch order with permit
     */
    async executeOneInchOrderWithPermit(
        htlcId: string,
        order: OneInchOrder,
        signature: string,
        interaction: string,
        makingAmount: string,
        takingAmount: string,
        thresholdAmount: string,
        permit: string
    ): Promise<string> {
        console.log(`Executing 1inch order with permit for HTLC: ${htlcId}`);

        // Execute the order with permit
        const tx = await this.htlcContract.executeOneInchOrderWithPermit(
            htlcId,
            order,
            signature,
            interaction,
            makingAmount,
            takingAmount,
            thresholdAmount,
            permit
        );

        const receipt = await tx.wait();
        console.log(`1inch order with permit executed: ${tx.hash}`);

        return tx.hash;
    }

    /**
     * Set the 1inch integration contract address
     */
    async setOneInchIntegration(integrationAddress: string): Promise<string> {
        console.log(`Setting 1inch integration address: ${integrationAddress}`);

        const tx = await this.htlcContract.setOneInchIntegration(integrationAddress);
        const receipt = await tx.wait();
        console.log(`1inch integration set: ${tx.hash}`);

        return tx.hash;
    }

    /**
     * Get HTLC details
     */
    async getHTLC(htlcId: string) {
        const htlc = await this.htlcContract.getHTLC(htlcId);
        return {
            htlcId: htlc.htlc_id,
            hashlock: htlc.hashlock,
            timelock: htlc.timelock.toString(),
            sender: htlc.sender,
            receiver: htlc.receiver,
            amount: htlc.amount.toString(),
            secret: htlc.secret,
            withdrawn: htlc.withdrawn,
            refunded: htlc.refunded,
            createdAt: htlc.created_at.toString(),
            token: htlc.token
        };
    }

    /**
     * Monitor HTLC events
     */
    async monitorHTLCEvents() {
        console.log("Monitoring HTLC events...");

        this.htlcContract.on("HTLCCreated", (htlcId, sender, receiver, amount, hashlock, timelock, token, event) => {
            console.log(`HTLC Created: ${htlcId} from ${sender} to ${receiver} for ${amount} ${token}`);
        });

        this.htlcContract.on("HTLCClaimed", (htlcId, receiver, secret, amount, event) => {
            console.log(`HTLC Claimed: ${htlcId} by ${receiver} with secret ${secret} for ${amount}`);
        });

        this.htlcContract.on("HTLCRefunded", (htlcId, sender, amount, event) => {
            console.log(`HTLC Refunded: ${htlcId} to ${sender} for ${amount}`);
        });

        this.htlcContract.on("OrderExecuted", (htlcId, tokenIn, tokenOut, amountIn, amountOut, event) => {
            console.log(`Order Executed: ${htlcId} swapped ${amountIn} ${tokenIn} for ${amountOut} ${tokenOut}`);
        });
    }
}

// Example usage
async function main() {
    const swap = new OneInchHTLCSwap();

    try {
        // Set up 1inch integration (this should be done after deploying the OneInchIntegration contract)
        // await swap.setOneInchIntegration("0x..."); // Replace with actual deployment address

        // Create an HTLC with 1inch capability
        const htlcId = await swap.createHTLCWithOneInch(
            "0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6", // Receiver address
            "0xA0b86a33E6441b8C4C8C0E4b8C4C8C0E4b8C4C8C0", // Token address (replace with actual token)
            ethers.utils.parseEther("1.0"), // Amount
            7200 // 2 hours timelock
        );

        console.log(`HTLC created with ID: ${htlcId}`);

        // Monitor events
        await swap.monitorHTLCEvents();

        // Example of executing a 1inch order (you would need actual order data from 1inch)
        /*
        const order: OneInchOrder = {
            maker: "0x...",
            makerAsset: "0x...",
            takerAsset: "0x...",
            makingAmount: "1000000000000000000",
            takingAmount: "2000000000000000000",
            receiver: "0x...",
            allowedSender: "0x...",
            salt: "0x...",
            makerAssetData: "0x",
            takerAssetData: "0x",
            getMakerAmount: "0x",
            getTakerAmount: "0x",
            predicate: "0x",
            permit: "0x",
            interaction: "0x"
        };

        await swap.executeOneInchOrder(
            htlcId,
            order,
            "0x...", // signature
            "0x", // interaction
            "1000000000000000000", // makingAmount
            "2000000000000000000", // takingAmount
            "1900000000000000000" // thresholdAmount
        );
        */

    } catch (error) {
        console.error("Error:", error);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

export { OneInchHTLCSwap };
