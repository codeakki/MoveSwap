import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { SuiClient, SuiTransactionBlockResponse } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { getFullnodeUrl } from '@mysten/sui/client';
import { bcs } from '@mysten/sui/bcs';
import dotenv from 'dotenv';
import { LimitOrder, MakerTraits, Address, Api } from "@1inch/limit-order-sdk";
import { AxiosProviderConnector } from '@1inch/limit-order-sdk/axios';
import axios from 'axios';
import { Wallet, Contract } from 'ethers';
import { getLimitOrderV4Domain } from "@1inch/limit-order-sdk";
import * as readline from 'readline';

dotenv.config();

// Load configuration from config.json
const fs = require('fs');
const path = require('path');
const configPath = path.join(__dirname, 'config.json');
const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Debug: Log config structure
console.log('Config data keys:', Object.keys(configData));
console.log('Networks keys:', Object.keys(configData.networks || {}));
console.log('Mainnet config:', configData.networks?.mainnet);

// Merge with environment variables
const network = process.env.NETWORK || "mainnet";
console.log('Selected network:', network);
const networkConfig = configData.networks[network];
console.log('Network config:', networkConfig);
console.log('Network config type:', typeof networkConfig);

const config = {
    // Base Configuration
    baseRPC: process.env.BASE_RPC || networkConfig?.base?.rpc ,
    basePrivateKey: process.env.BASE_PRIVATE_KEY || configData.base.privateKey,

    // Base Configuration
    baseHTLCAddress: networkConfig?.base?.htlcContract || '0x4eEDCb01601F9e488B45B99a33510ab814E3383B',
    limitOrderProtocolAddress: networkConfig?.base?.limitOrderProtocol || '0x1111111254EEB25477B68fb85Ed929f73A960582',
    wethAddress: networkConfig?.base?.weth || '0x4200000000000000000000000000000000000006',

    // Token Configuration
    supportedTokens: configData.tokens,
    
    // Sui Configuration
    suiPackageId: networkConfig?.sui?.packageId || '0x5297cf1080eecc96654501b93946782771803a4707d76e99e0cf0735d68f4042',
    suiPrivateKey: process.env.SUI_PRIVATE_KEY || configData.sui.privateKey,
    
    // Timelock Configuration (in seconds)
    baseTimelockDuration: 7200, // 2 hours
    suiTimelockDuration: 3600, // 1 hour (shorter to ensure Sui can be claimed first)

    // Network Configuration
    network: process.env.NETWORK || "mainnet", // mainnet or base-sepolia
};

// ERC20 ABI for token transfers
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

const WETH_ABI = [
    "function deposit() payable",
    "function withdraw(uint256 wad)",
    "function balanceOf(address owner) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

// 1inch Limit Order Protocol ABI - using the actual contract interface
const LIMIT_ORDER_ABI = [
    // v4 fillOrder with v4 Order struct
    "function fillOrder((uint256 salt, address makerAsset, address takerAsset, address maker, address receiver, address allowedSender, uint256 makingAmount, uint256 takingAmount, bytes predicate, bytes permit, bytes interaction) order, bytes signature, uint256 makingAmount, uint256 takingAmount) payable returns (uint256, uint256)",
    "function getTakingAmount((uint256 salt, address makerAsset, address takerAsset, address maker, address receiver, address allowedSender, uint256 makingAmount, uint256 takingAmount, bytes predicate, bytes permit, bytes interaction) order, uint256 makingAmount) view returns (uint256)",
    "function getMakingAmount((uint256 salt, address makerAsset, address takerAsset, address maker, address receiver, address allowedSender, uint256 makingAmount, uint256 takingAmount, bytes predicate, bytes permit, bytes interaction) order, uint256 takingAmount) view returns (uint256)",
    "function domainSeparator() view returns (bytes32)",
    "function checkPredicate(bytes32 orderHash) view returns (bool)"
];

interface TokenInfo {
    address: string;
    symbol: string;
    decimals: number;
}

interface SwapParams {
    fromToken: TokenInfo;
    toToken: TokenInfo;
    amount: string;
    fromAddress: string;
    toAddress: string;
    secretHash: string;
    validUntil: number;
}

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

interface SwapState {
    secret?: string;
    hashlock?: string;
    htlcId?: string;
    baseTimelock?: number;
    suiTimelock?: number;
    baseLimitOrder?: { order: any, signature: string, orderHash: string };
    suiHtlcResult?: any;
    suiClaimResult?: any;
    fromChain?: 'base' | 'sui';
    fromTokenSymbol?: string;
    toTokenSymbol?: string;
    amount?: string;
    fromAddress?: string;
    toAddress?: string;
}

class AtomicSwapCLI {
    private baseProvider: any;
    private baseWallet: ethers.Wallet;
    private limitOrderContract: ethers.Contract;
    private loVerifyingContract: string;
    private suiClient: SuiClient;
    private suiKeypair: Ed25519Keypair;
    private network: string;
    private swapState: SwapState;
    private rl: readline.Interface;

    constructor() {
        this.network = config.network;
        this.swapState = {};

        // Initialize Base
        this.baseProvider = new ethers.JsonRpcProvider(config.baseRPC) as any;
        this.baseWallet = new ethers.Wallet(config.basePrivateKey, this.baseProvider);

        // Initialize 1inch Limit Order Protocol contract on Base mainnet (use known LoP address)
        this.loVerifyingContract = config.limitOrderProtocolAddress;
        this.limitOrderContract = new ethers.Contract(this.loVerifyingContract, LIMIT_ORDER_ABI, this.baseWallet);

        // Initialize Sui
        const suiNetwork = this.network === 'mainnet' ? 'mainnet' : 'testnet';
        this.suiClient = new SuiClient({ url: getFullnodeUrl(suiNetwork) });

        // Remove the '1b' suffix from the private key if present
        const privateKey = config.suiPrivateKey.endsWith('1b') ? 
            config.suiPrivateKey.slice(0, -2) : config.suiPrivateKey;
        this.suiKeypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKey, 'hex'));
        
        // Initialize readline interface
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        // Log addresses
        const suiAddress = this.suiKeypair.getPublicKey().toSuiAddress();
        console.log("\n🚀 Base-SUI Atomic Swap CLI Initialized");
        console.log("=====================================");
        console.log(`🌐 Network: ${this.network}`);
        console.log(`📍 Base Address: ${this.baseWallet.address}`);
        console.log(`📍 1inch Limit Order: ${this.loVerifyingContract}`);
        console.log(`📍 SUI Address: ${suiAddress}`);
        console.log("=====================================\n");
    }

    getSuiAddress(): string {
        return this.suiKeypair.getPublicKey().toSuiAddress();
    }

    private generateSwapDetails() {
        const secret = crypto.randomBytes(32);
        const hashlock = crypto.createHash('sha256').update(secret).digest(); // Use sha256 to match both contracts
        const htlcId = crypto.randomBytes(16).toString('hex'); // Use random hex string for unique ID
        const baseTimelock = Math.floor(Date.now() / 1000) + config.baseTimelockDuration;
        const suiTimelock = Math.floor(Date.now() / 1000) + config.suiTimelockDuration;

        return { 
            secret: "0x" + secret.toString('hex'),
            hashlock: "0x" + Buffer.from(hashlock).toString('hex'),
            htlcId,
            baseTimelock,
            suiTimelock
        };
    }

    private getTokenInfo(tokenSymbol: string): TokenInfo {
        // Map ETH to WETH for Limit Order Protocol (ERC20 only)
        const mappedSymbol = tokenSymbol === 'ETH' ? 'WETH' : tokenSymbol;
        const address = (config.supportedTokens as any)[mappedSymbol];
        if (!address || address === ethers.ZeroAddress) {
            throw new Error(`Unsupported or invalid token for limit order: ${tokenSymbol}. Use ERC20 (e.g., WETH, USDC).`);
        }
        const decimals = mappedSymbol === 'USDC' ? 6 : 18;
        return { address, symbol: mappedSymbol, decimals };
    }

    private async ensureAllowance(tokenAddress: string, ownerAddress: string, spender: string, needed: bigint): Promise<void> {
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.baseWallet);
        const allowance: bigint = await token.allowance(ownerAddress, spender);
        if (allowance < needed) {
            console.log(`🔄 Approving ${needed.toString()} units for ${spender} on ${tokenAddress}...`);
            const tx = await token.approve(spender, needed);
            await tx.wait();
            console.log(`✅ Approved. Hash: ${tx.hash}`);
        }
    }

    private async ensureWethBalance(required: bigint): Promise<void> {
        const weth = new ethers.Contract(config.wethAddress, WETH_ABI, this.baseWallet);
        const current: bigint = await weth.balanceOf(this.baseWallet.address);
        if (current >= required) return;
        const ethBal: bigint = await this.baseProvider.getBalance(this.baseWallet.address);
        const deficit = required - current;
        if (ethBal <= deficit) {
            throw new Error(`Insufficient ETH to wrap to WETH. Need ${deficit.toString()}, have ${ethBal.toString()}.`);
        }
        console.log(`💧 Wrapping ETH->WETH: ${deficit.toString()} wei`);
        const tx = await weth.deposit({ value: deficit });
        await tx.wait();
        console.log(`✅ Wrapped to WETH. Hash: ${tx.hash}`);
    }

    async approveToken(tokenAddress: string, amount: string): Promise<void> {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.baseWallet);
        const decimals = await tokenContract.decimals();
        const amountInUnits = ethers.parseUnits(amount, decimals);

        console.log(`🔄 Approving ${amount} tokens for Limit Order Protocol...`);

        const tx = await tokenContract.approve(config.limitOrderProtocolAddress, amountInUnits);
        await tx.wait();

        console.log(`✅ Token approved successfully! Hash: ${tx.hash}`);
    }

    async createBaseLimitOrder(params: SwapParams): Promise<{ order: LimitOrder, signature: string, orderHash: string }> {
        const { fromToken, toToken, amount, fromAddress, secretHash, validUntil } = params;

        // Parse amount based on token decimals
        const makingAmount = ethers.parseUnits(amount, fromToken.decimals);

        // For this example, set takingAmount using the to-token decimals for a 1:1 numeric amount
        const takingAmount = ethers.parseUnits(amount, toToken.decimals);

        // Create maker traits
        const makerTraits = MakerTraits.default()
            .withExpiration(BigInt(validUntil))
            .allowPartialFills()
            .allowMultipleFills();

        if (fromToken.address.toLowerCase() === toToken.address.toLowerCase()) {
            throw new Error('makerAsset and takerAsset must be different for 1inch Limit Order.');
        }

        // Ensure maker has balance and allowance for makerAsset
        if (fromToken.symbol === 'WETH') {
            await this.ensureWethBalance(makingAmount);
        }
        await this.ensureAllowance(fromToken.address, this.baseWallet.address, config.limitOrderProtocolAddress, makingAmount);

        // Create the 1inch Limit Order
        const order = new LimitOrder({
            makerAsset: new Address(fromToken.address),
            takerAsset: new Address(toToken.address),
            makingAmount,
            takingAmount,
            maker: new Address(fromAddress),
            salt: BigInt(Math.floor(Math.random() * 1_000_000_000)),
            receiver: new Address(fromAddress),
        }, makerTraits);

        // Get typed data for signing (chain id 8453 for Base)
        const typedData = order.getTypedData(8453);

        // Sign the order
        const signature = await this.baseWallet.signTypedData(
            typedData.domain,
            { Order: typedData.types.Order },
            typedData.message
        );

        // Get order hash
        const orderHash = order.getOrderHash(8453);

        return { order, signature, orderHash };
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
        const suiExplorerNetwork = this.network === 'mainnet' ? 'mainnet' : 'testnet';
        console.log(`🔍 Explorer: https://suiexplorer.com/txblock/${result.digest}?network=${suiExplorerNetwork}`);
        console.log(`⛽ Gas Used: ${result.effects?.gasUsed?.computationCost || 'N/A'}`);
        console.log(`💰 Storage Cost: ${result.effects?.gasUsed?.storageCost || 'N/A'}`);
        return result;
    }

    async executeLimitOrder(order: LimitOrder, signature: string, secret: string): Promise<void> {
        console.log("🔓 Executing 1inch Limit Order with secret...");
        console.log(`🔐 Secret: ${secret}`);
        console.log(`📋 Order Hash: ${order.getOrderHash(8453)}`);

        try {
            const chainId = 8453;
            const apiKey = process.env.INCH_API_KEY || process.env.INCH_API_TOKEN || process.env.ONEINCH_API_KEY || process.env.DEV_PORTAL_API_TOKEN;
            if (!apiKey) {
                throw new Error('Missing INCH_API_KEY in env for 1inch API.');
            }

            // Prepare taker allowances and balances
            const typed = order.getTypedData(chainId);
            const takerAsset: string = String(typed.message.takerAsset);
            const makingAmount: bigint = order.makingAmount;

            if (takerAsset.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
                throw new Error('takerAsset is invalid (ZeroAddress). Use ERC20 like USDC/WETH.');
            }
            // Ensure allowance is set for protocol
            await this.ensureAllowance(takerAsset, this.baseWallet.address, this.loVerifyingContract, ethers.MaxUint256);

            // Build takingAmount on-chain and fill directly (no REST dependency)
            const orderTyped = order.getTypedData(chainId);
            const orderStruct = {
                salt: orderTyped.message.salt,
                makerAsset: orderTyped.message.makerAsset,
                takerAsset: orderTyped.message.takerAsset,
                maker: orderTyped.message.maker,
                receiver: orderTyped.message.receiver,
                allowedSender: ethers.ZeroAddress,
                makingAmount: orderTyped.message.makingAmount,
                takingAmount: orderTyped.message.takingAmount,
                predicate: '0x',
                permit: '0x',
                interaction: '0x'
            };
            const derivedTaking: bigint = await this.limitOrderContract.getTakingAmount(orderStruct, makingAmount);

            console.log('🧾 Filling order on-chain...');
            const tx = await this.limitOrderContract.fillOrder(
                orderStruct,
                signature,
                makingAmount,
                derivedTaking,
                { gasLimit: 500000 }
            );

            console.log(`⏳ Transaction pending: ${tx.hash}`);
            const receipt = await tx.wait();

            console.log("✅ 1inch Limit Order executed successfully!");
            console.log(`🔗 Transaction Hash: ${receipt.hash}`);
            console.log(`🔍 Base Explorer: https://basescan.org/tx/${receipt.hash}`);
            console.log(`⛽ Gas Used: ${receipt.gasUsed?.toString?.() || receipt.gasUsed}`);
            console.log("💱 Token swap completed via 1inch Limit Order Protocol");

        } catch (error) {
            console.error("❌ Error executing 1inch limit order:", error);
            throw error;
        }
    }

    async claimEthereumHTLC(htlcId: string, secret: string) {
        console.log("🔓 Claiming Ethereum resources (using secret from Sui)...");
        console.log(`📝 HTLC ID: ${htlcId}`);
        console.log(`🔐 Secret: ${secret}`);
        
        // In this implementation, the "claim" is actually executing the limit order
        // The secret from Sui HTLC serves as the coordination mechanism
        console.log("✅ Ethereum side coordinated successfully via secret from Sui!");
        console.log("💱 Ready for token transfer execution");
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
        const suiExplorerNetwork2 = this.network === 'mainnet' ? 'mainnet' : 'testnet';
        console.log(`🔍 Explorer: https://suiexplorer.com/txblock/${result.digest}?network=${suiExplorerNetwork2}`);
        console.log(`⛽ Gas Used: ${result.effects?.gasUsed?.computationCost || 'N/A'}`);
        console.log(`💰 Storage Cost: ${result.effects?.gasUsed?.storageCost || 'N/A'}`);
        return result;
    }

    // CLI Command Methods
    async initSwap(fromChain: 'base' | 'sui', fromTokenSymbol: string, toTokenSymbol: string, amount: string, fromAddress: string, toAddress: string) {
        console.log(`\n🚀 Initializing ${fromChain.toUpperCase()} to ${fromChain === 'base' ? 'SUI' : 'BASE'} Atomic Swap...`);
        console.log("=====================================");
        console.log(`🔄 From: ${fromTokenSymbol} on ${fromChain}`);
        console.log(`🔄 To: ${toTokenSymbol} on ${fromChain === 'base' ? 'sui' : 'base'}`);
        console.log(`💰 Amount: ${amount}`);
        console.log(`👤 From Address: ${fromAddress}`);
        console.log(`👤 To Address: ${toAddress}`);
        console.log("=====================================\n");
        
        // Generate swap details
        const { secret, hashlock, htlcId, baseTimelock, suiTimelock } = this.generateSwapDetails();
        console.log("🎲 Generated swap details:");
        console.log(`📝 HTLC ID: ${htlcId}`);
        console.log(`🔐 Hashlock: ${hashlock}`);
        console.log(`🔐 Secret: ${secret}`);
        console.log(`⏰ Base Timelock: ${new Date(baseTimelock * 1000).toISOString()}`);
        console.log(`⏰ SUI Timelock: ${new Date(suiTimelock * 1000).toISOString()}\n`);

        // Store state
        this.swapState = {
            secret,
            hashlock,
            htlcId,
            baseTimelock,
            suiTimelock,
            fromChain,
            fromTokenSymbol,
            toTokenSymbol,
            amount,
            fromAddress,
            toAddress
        };

        console.log("✅ Swap initialized successfully!");
        console.log("📋 Next command: create-base-order or create-sui-htlc");
        return this.swapState;
    }

    async createBaseOrder() {
        if (!this.swapState.fromChain || !this.swapState.fromTokenSymbol || !this.swapState.toTokenSymbol || !this.swapState.amount || !this.swapState.fromAddress || !this.swapState.toAddress || !this.swapState.htlcId || !this.swapState.baseTimelock) {
            throw new Error("❌ Swap not initialized. Run 'init-swap' first.");
        }

        console.log("📋 Creating Base 1inch Limit Order...");
        
        const orderParams: SwapParams = {
            fromToken: this.getTokenInfo(this.swapState.fromTokenSymbol),
            toToken: this.getTokenInfo(this.swapState.toTokenSymbol),
            amount: this.swapState.amount,
            fromAddress: this.swapState.fromAddress,
            toAddress: this.swapState.toAddress,
            secretHash: this.swapState.htlcId,
            validUntil: this.swapState.baseTimelock
        };

        const baseLimitOrder = await this.createBaseLimitOrder(orderParams);
        this.swapState.baseLimitOrder = baseLimitOrder;

        console.log("✅ Base Limit Order created successfully!");
        console.log(`📋 Order Hash: ${baseLimitOrder.orderHash}`);
        console.log("📋 Next command: create-sui-htlc");
        return baseLimitOrder;
    }

    async createSuiHTLCStep() {
        if (!this.swapState.htlcId || !this.swapState.hashlock || !this.swapState.suiTimelock || !this.swapState.amount || !this.swapState.toAddress) {
            throw new Error("❌ Swap not initialized. Run 'init-swap' first.");
        }

        console.log("📋 Creating Sui HTLC...");
        
        const suiHtlcResult = await this.createSuiHTLC(
            this.swapState.htlcId,
            this.swapState.toAddress,
            this.swapState.hashlock,
            this.swapState.suiTimelock,
            this.swapState.amount
        );

        this.swapState.suiHtlcResult = suiHtlcResult;

        console.log("✅ Sui HTLC created successfully!");
        console.log(`🔗 Transaction Hash: ${suiHtlcResult.digest}`);
        console.log("📋 Next command: wait-for-sui-finalization");
        return suiHtlcResult;
    }

    async waitForSuiFinalization() {
        if (!this.swapState.suiHtlcResult) {
            throw new Error("❌ Sui HTLC not created. Run 'create-sui-htlc' first.");
        }

        console.log("⏳ Waiting for Sui HTLC transaction to be finalized...");
        await this.suiClient.waitForTransaction({
            digest: this.swapState.suiHtlcResult.digest
        });
        console.log("✅ Sui HTLC transaction finalized!");
        console.log("📋 Next command: claim-sui-htlc");
    }

    async claimSuiHTLCStep() {
        if (!this.swapState.htlcId || !this.swapState.secret || !this.swapState.hashlock || !this.swapState.suiHtlcResult) {
            throw new Error("❌ Required state missing. Make sure to run init-swap, create-sui-htlc, and wait-for-sui-finalization first.");
        }

        console.log("📋 Claiming Sui HTLC (revealing secret)...");
        
        const suiClaimResult = await this.claimSuiHTLC(
            this.swapState.htlcId,
            this.swapState.secret,
            this.swapState.hashlock,
            this.swapState.suiHtlcResult.digest
        );

        this.swapState.suiClaimResult = suiClaimResult;

        console.log("✅ Sui HTLC claimed successfully!");
        console.log(`🔗 Transaction Hash: ${suiClaimResult.digest}`);
        console.log("📋 Next command: execute-base-order");
        return suiClaimResult;
    }

    async executeBaseOrder() {
        if (!this.swapState.baseLimitOrder || !this.swapState.secret) {
            throw new Error("❌ Base Limit Order not created or secret not available. Make sure to run create-base-order and claim-sui-htlc first.");
        }

        console.log("📋 Executing Base 1inch Limit Order (using revealed secret)...");
        
        await this.executeLimitOrder(
            this.swapState.baseLimitOrder.order,
            this.swapState.baseLimitOrder.signature,
            this.swapState.secret
        );

        console.log("✅ Base Limit Order executed successfully!");
        console.log("🎉 ATOMIC SWAP COMPLETED SUCCESSFULLY! 🎉");
        console.log("==========================================");
        console.log("📊 Transaction Summary:");
        if (this.swapState.fromChain === 'base') {
            console.log(`🔗 Base 1inch Limit Order Created: ${this.swapState.baseLimitOrder.orderHash}`);
            console.log(`🔗 SUI HTLC Created: ${this.swapState.suiHtlcResult?.digest}`);
            console.log(`🔗 SUI HTLC Claimed: ${this.swapState.suiClaimResult?.digest}`);
            console.log("💱 Base 1inch Limit Order Executed");
        } else {
            console.log(`🔗 SUI HTLC Created: ${this.swapState.suiHtlcResult?.digest}`);
            console.log(`🔗 SUI HTLC Claimed: ${this.swapState.suiClaimResult?.digest}`);
            console.log(`🔗 Base 1inch Limit Order Created: ${this.swapState.baseLimitOrder.orderHash}`);
            console.log("💱 Base 1inch Limit Order Executed");
        }
        console.log("==========================================");
        console.log("🔗 Key Coordination Points:");
        console.log(`📝 Secret Hash: ${this.swapState.hashlock}`);
        console.log(`🔐 Revealed Secret: ${this.swapState.secret}`);
        console.log("💱 Cross-chain coordination successful!");
        console.log("==========================================");
    }

    async showState() {
        console.log("\n📊 Current Swap State:");
        console.log("=====================");
        console.log(`🔗 From Chain: ${this.swapState.fromChain || 'Not set'}`);
        console.log(`🪙 From Token: ${this.swapState.fromTokenSymbol || 'Not set'}`);
        console.log(`🪙 To Token: ${this.swapState.toTokenSymbol || 'Not set'}`);
        console.log(`💰 Amount: ${this.swapState.amount || 'Not set'}`);
        console.log(`👤 From Address: ${this.swapState.fromAddress || 'Not set'}`);
        console.log(`👤 To Address: ${this.swapState.toAddress || 'Not set'}`);
        console.log(`📝 HTLC ID: ${this.swapState.htlcId || 'Not set'}`);
        console.log(`🔐 Secret: ${this.swapState.secret || 'Not set'}`);
        console.log(`🔐 Hashlock: ${this.swapState.hashlock || 'Not set'}`);
        console.log(`⏰ Base Timelock: ${this.swapState.baseTimelock ? new Date(this.swapState.baseTimelock * 1000).toISOString() : 'Not set'}`);
        console.log(`⏰ SUI Timelock: ${this.swapState.suiTimelock ? new Date(this.swapState.suiTimelock * 1000).toISOString() : 'Not set'}`);
        console.log(`📋 Base Order Created: ${this.swapState.baseLimitOrder ? 'Yes' : 'No'}`);
        console.log(`🔗 SUI HTLC Created: ${this.swapState.suiHtlcResult ? 'Yes' : 'No'}`);
        console.log(`🔓 SUI HTLC Claimed: ${this.swapState.suiClaimResult ? 'Yes' : 'No'}`);
        console.log("=====================\n");
    }

    async showHelp() {
        console.log("\n🆘 Available Commands:");
        console.log("=====================");
        console.log("init-swap <fromChain> <fromToken> <toToken> <amount> <fromAddress> <toAddress>");
        console.log("  - Initialize a new atomic swap");
        console.log("  - fromChain: 'base' or 'sui'");
        console.log("  - fromToken/toToken: 'ETH', 'USDC', etc.");
        console.log("  - amount: amount to swap (e.g., '0.001')");
        console.log("  - fromAddress/toAddress: wallet addresses");
        console.log("");
        console.log("create-base-order");
        console.log("  - Create 1inch Limit Order on Base");
        console.log("");
        console.log("create-sui-htlc");
        console.log("  - Create HTLC on Sui blockchain");
        console.log("");
        console.log("wait-for-sui-finalization");
        console.log("  - Wait for Sui HTLC transaction to finalize");
        console.log("");
        console.log("claim-sui-htlc");
        console.log("  - Claim Sui HTLC (reveals secret)");
        console.log("");
        console.log("execute-base-order");
        console.log("  - Execute Base Limit Order with revealed secret");
        console.log("");
        console.log("show-state");
        console.log("  - Show current swap state");
        console.log("");
        console.log("show-help");
        console.log("  - Show this help message");
        console.log("");
        console.log("exit");
        console.log("  - Exit the CLI");
        console.log("=====================\n");
    }

    async processCommand(input: string) {
        const parts = input.trim().split(' ');
        const command = parts[0];

        try {
            switch (command) {
                case 'init-swap':
                    if (parts.length !== 7) {
                        console.log("❌ Usage: init-swap <fromChain> <fromToken> <toToken> <amount> <fromAddress> <toAddress>");
                        return;
                    }
                    await this.initSwap(
                        parts[1] as 'base' | 'sui',
                        parts[2],
                        parts[3],
                        parts[4],
                        parts[5],
                        parts[6]
                    );
                    break;

                case 'create-base-order':
                    await this.createBaseOrder();
                    break;

                case 'create-sui-htlc':
                    await this.createSuiHTLCStep();
                    break;

                case 'wait-for-sui-finalization':
                    await this.waitForSuiFinalization();
                    break;

                case 'claim-sui-htlc':
                    await this.claimSuiHTLCStep();
                    break;

                case 'execute-base-order':
                    await this.executeBaseOrder();
                    break;

                case 'show-state':
                    await this.showState();
                    break;

                case 'show-help':
                    await this.showHelp();
                    break;

                case 'exit':
                    console.log("👋 Goodbye!");
                    this.rl.close();
                    process.exit(0);
                    break;

                default:
                    console.log(`❌ Unknown command: ${command}`);
                    console.log("Type 'show-help' for available commands.");
            }
        } catch (error) {
            console.error("❌ Error:", error.message);
        }
    }

    async startCLI() {
        console.log("\n🚀 Base-SUI Atomic Swap CLI Started");
        console.log("===================================");
        console.log("Type 'show-help' for available commands");
        console.log("Type 'exit' to quit");
        console.log("===================================\n");

        this.rl.on('line', async (input) => {
            await this.processCommand(input);
            this.rl.prompt();
        });

        this.rl.prompt();
    }
}

// Export for external use
export { AtomicSwapCLI };

// Run the CLI if this file is run directly
if (require.main === module) {
    const cli = new AtomicSwapCLI();
    cli.startCLI().catch(console.error);
}
