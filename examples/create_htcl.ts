import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiMoveObject, SuiTransactionBlockResponse } from '@mysten/sui/client';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

interface SuiHTLCConfig {
  orderId: string;
  senderKeypair: Ed25519Keypair;
  receiverAddress: string;
  hashlock: Buffer;
  timelock: number;
  amount: bigint; // in MIST (1 SUI = 10^9 MIST)
  network: 'testnet' | 'devnet' | 'mainnet';
  packageId: string;
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

export class SuiHTLCBuilder {
  private client: SuiClient;
  private config: SuiHTLCConfig;

  constructor(config: SuiHTLCConfig) {
    this.config = config;
    const rpcUrl = getFullnodeUrl(config.network);
    this.client = new SuiClient({ url: rpcUrl });
  }

  async initialize() {
    try {
      // In SUI, we don't need explicit initialization as the HTLC store
      // is created on first use through the Move contract
      console.log('SUI HTLC ready to use');
    } catch (error) {
      console.error('Failed to initialize SUI HTLC:', error);
      throw error;
    }
  }

  async createHTLC() {
    try {
      const tx = new Transaction();
      
      // Add create_htlc call
      tx.moveCall({
        target: `${this.config.packageId}::htlc::create_htlc`,
        arguments: [
          tx.pure(new Uint8Array(Buffer.from(this.config.orderId, 'utf8'))), // htlc_id as vector<u8>
          tx.pure(new Uint8Array(Buffer.from(this.config.receiverAddress))), // receiver address as bytes
          tx.pure(new Uint8Array(this.config.hashlock)), // hashlock as vector<u8>
          tx.pure(new Uint8Array(Buffer.from(this.config.timelock.toString()))), // timelock as bytes
          tx.pure(new Uint8Array(Buffer.from(this.config.amount.toString()))), // amount as bytes
        ],
      });

      const response = await this.client.signAndExecuteTransaction({
        signer: this.config.senderKeypair,
        transaction: tx,
        options: {
          showEffects: true,
          showInput: true,
        },
      }) as SuiTransactionBlockResponse;

      const senderAddress = await this.config.senderKeypair.toSuiAddress();

      return {
        htlcId: this.config.orderId,
        transactionDigest: response.digest,
        sender: senderAddress,
        receiver: this.config.receiverAddress,
        hashlock: this.config.hashlock.toString('hex'),
        timelock: this.config.timelock,
        amount: this.config.amount,
        success: response.effects?.status.status === 'success',
      };
    } catch (error) {
      console.error('Failed to create HTLC:', error);
      throw error;
    }
  }

  async claimWithSecret(htlcId: string, secret: Buffer, receiverKeypair: Ed25519Keypair, senderAddress: string) {
    try {
      const tx = new Transaction();

      tx.moveCall({
        target: `${this.config.packageId}::htlc::claim_with_secret`,
        arguments: [
          tx.pure(new Uint8Array(Buffer.from(senderAddress))), // sender address as bytes
          tx.pure(new Uint8Array(Buffer.from(htlcId, 'utf8'))),
          tx.pure(new Uint8Array(secret)),
        ],
      });

      const response = await this.client.signAndExecuteTransaction({
        signer: receiverKeypair,
        transaction: tx,
        options: { showEffects: true },
      }) as SuiTransactionBlockResponse;

      return {
        htlcId,
        transactionDigest: response.digest,
        secret: secret.toString('hex'),
        success: response.effects?.status.status === 'success',
      };
    } catch (error) {
      console.error('Failed to claim HTLC:', error);
      throw error;
    }
  }

  async refundHTLC(htlcId: string) {
    try {
      const tx = new Transaction();

      tx.moveCall({
        target: `${this.config.packageId}::htlc::refund_htlc`,
        arguments: [
          tx.pure(new Uint8Array(Buffer.from(htlcId, 'utf8'))),
        ],
      });

      const response = await this.client.signAndExecuteTransaction({
        signer: this.config.senderKeypair,
        transaction: tx,
        options: { showEffects: true },
      }) as SuiTransactionBlockResponse;

      return {
        htlcId,
        transactionDigest: response.digest,
        success: response.effects?.status.status === 'success',
      };
    } catch (error) {
      console.error('Failed to refund HTLC:', error);
      throw error;
    }
  }

  async getHTLC(storeAddress: string, htlcId: string) {
    try {
      // Get dynamic fields from store object
      const fields = await this.client.getDynamicFields({
        parentId: storeAddress,
      });

      // Find the HTLC object by ID
      const htlcField = fields.data.find(field => {
        const nameValue = field.name.value as Uint8Array;
        return Buffer.from(nameValue).toString('utf8') === htlcId;
      });

      if (htlcField) {
        const htlcObject = await this.client.getObject({
          id: htlcField.objectId,
          options: { showContent: true }
        });

        if (htlcObject.data?.content) {
          const fields = (htlcObject.data.content as SuiMoveObject).fields as unknown as HTLCFields;
          return {
            found: true,
            id: htlcId,
            hashlock: Buffer.from(fields.hashlock).toString('hex'),
            timelock: Number(fields.timelock),
            sender: fields.sender,
            receiver: fields.receiver,
            amount: BigInt(fields.amount),
            secret: fields.secret ? Buffer.from(fields.secret).toString('hex') : null,
            withdrawn: fields.withdrawn,
            refunded: fields.refunded,
            created_at: Number(fields.created_at),
          };
        }
      }
      return { found: false };
    } catch (error) {
      console.error('Failed to get HTLC:', error);
      return { found: false };
    }
  }

  async getRevealedSecret(storeAddress: string, htlcId: string): Promise<string | null> {
    try {
      const htlc = await this.getHTLC(storeAddress, htlcId);
      if (htlc.found && htlc.secret) {
        return htlc.secret;
      }
      return null;
    } catch (error) {
      console.error('Failed to get revealed secret:', error);
      return null;
    }
  }

  static generateSecret(): { secret: Buffer; hashlock: Buffer } {
    const secret = crypto.randomBytes(32);
    const hashlock = crypto.createHash('sha256').update(secret).digest();
    return { secret, hashlock };
  }

  static createKeypair(privateKey?: string): Ed25519Keypair {
    if (privateKey) {
      return Ed25519Keypair.fromSecretKey(Buffer.from(privateKey, 'hex'));
    }
    return Ed25519Keypair.generate();
  }

  static saveHTLCData(orderId: string, data: any) {
    const outputDir = path.join(__dirname, '../../orders');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filePath = path.join(outputDir, `${orderId}.json`);

    let orderData = {};
    if (fs.existsSync(filePath)) {
      orderData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    orderData = {
      ...orderData,
      suiHTLC: data,
    };

    fs.writeFileSync(filePath, JSON.stringify(orderData, null, 2));
    console.log(`SUI HTLC data saved to ${filePath}`);
  }
}

// Main function for creating SUI HTLC
async function main() {
  const orderId = process.env.ORDER_ID || `order_${Date.now()}`;

  // Generate or load secret
  const { secret, hashlock } = SuiHTLCBuilder.generateSecret();

  // Create accounts
  const sender = SuiHTLCBuilder.createKeypair(process.env.SUI_PRIVATE_KEY);
  const receiverAddress = process.env.SUI_RECEIVER_ADDRESS || '0x0000000000000000000000000000000000000000';

  const config: SuiHTLCConfig = {
    orderId,
    senderKeypair: sender,
    receiverAddress,
    hashlock,
    timelock: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    amount: BigInt(1_000_000_000), // 1 SUI
    network: (process.env.SUI_NETWORK as 'testnet' | 'devnet' | 'mainnet') || 'testnet',
    packageId: process.env.SUI_PACKAGE_ID || '0x0000000000000000000000000000000000000000',
  };

  const builder = new SuiHTLCBuilder(config);

  // Initialize (not strictly needed for SUI but kept for consistency)
  await builder.initialize();

  // Create HTLC
  console.log('Creating SUI HTLC...');
  const htlcResult = await builder.createHTLC();
  console.log('HTLC created:', htlcResult);

  // Save data
  SuiHTLCBuilder.saveHTLCData(orderId, {
    ...htlcResult,
    secret: secret.toString('hex'),
  });
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}