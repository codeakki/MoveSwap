# Atomic Swap CLI Documentation

This CLI provides step-by-step control over the Base-SUI atomic swap process, allowing you to execute each step individually and monitor the progress.

## Features

- **Step-by-step execution**: Execute each atomic swap step individually
- **State management**: Track swap progress between steps
- **Interactive CLI**: Real-time command execution with feedback
- **Error handling**: Comprehensive error checking and recovery
- **Progress tracking**: Monitor which steps have been completed

## Installation

Make sure you have the required dependencies installed:

```bash
npm install
```

## Usage

### Starting the CLI

```bash
npx ts-node atomic_swap_cli.ts
```

### Available Commands

#### 1. Initialize Swap
```
init-swap <fromChain> <fromToken> <toToken> <amount> <fromAddress> <toAddress>
```

**Parameters:**
- `fromChain`: Either 'base' or 'sui'
- `fromToken`: Token symbol (e.g., 'ETH', 'USDC')
- `toToken`: Token symbol (e.g., 'ETH', 'USDC')
- `amount`: Amount to swap (e.g., '0.001')
- `fromAddress`: Sender wallet address
- `toAddress`: Receiver wallet address

**Example:**
```
init-swap base ETH USDC 0.001 0x3644Bd78Cb199f3C0e18bD31dca864D4Af91796E 0x31d63d6d38b8aee284b7d74f9e380a1cfbc48677c1f8f008e0f84db1731ae58b
```

#### 2. Create Base Limit Order
```
create-base-order
```
Creates a 1inch Limit Order on Base blockchain.

#### 3. Create Sui HTLC
```
create-sui-htlc
```
Creates an HTLC (Hash Time Locked Contract) on Sui blockchain.

#### 4. Wait for Sui Finalization
```
wait-for-sui-finalization
```
Waits for the Sui HTLC transaction to be finalized.

#### 5. Claim Sui HTLC
```
claim-sui-htlc
```
Claims the Sui HTLC, revealing the secret.

#### 6. Execute Base Order
```
execute-base-order
```
Executes the Base Limit Order using the revealed secret.

#### 7. Show State
```
show-state
```
Displays the current swap state and progress.

#### 8. Show Help
```
show-help
```
Displays all available commands.

#### 9. Exit
```
exit
```
Exits the CLI.

## Complete Workflow Example

Here's a complete example of a Base to SUI atomic swap:

```bash
# Start the CLI
npx ts-node atomic_swap_cli.ts

# Initialize the swap
init-swap base ETH USDC 0.001 0x3644Bd78Cb199f3C0e18bD31dca864D4Af91796E 0x31d63d6d38b8aee284b7d74f9e380a1cfbc48677c1f8f008e0f84db1731ae58b

# Create Base Limit Order
create-base-order

# Create Sui HTLC
create-sui-htlc

# Wait for Sui transaction to finalize
wait-for-sui-finalization

# Claim Sui HTLC (reveals secret)
claim-sui-htlc

# Execute Base Limit Order
execute-base-order

# Check final state
show-state

# Exit
exit
```

## State Management

The CLI maintains state between commands, including:
- Swap parameters (tokens, amounts, addresses)
- Generated secrets and hashlocks
- Transaction hashes and results
- Progress tracking

## Error Handling

The CLI includes comprehensive error handling:
- Validates required state before executing commands
- Provides clear error messages
- Maintains state consistency
- Allows recovery from errors

## Configuration

Make sure your `config.json` and environment variables are properly set up before using the CLI. The CLI uses the same configuration as the main atomic swap implementation.

## Testing

You can test the CLI functionality using the provided test script:

```bash
node test_cli.js
```

This will run a series of test commands to verify the CLI functionality.

## Troubleshooting

### Common Issues

1. **"Swap not initialized"**: Run `init-swap` first
2. **"Required state missing"**: Complete previous steps in order
3. **Network errors**: Check your RPC endpoints and network connectivity
4. **Insufficient funds**: Ensure you have enough tokens and gas

### Debug Information

The CLI provides detailed logging for each step, including:
- Transaction hashes
- Explorer links
- Gas usage
- Error details

## Security Notes

- Never share your private keys
- Verify all transaction details before confirming
- Use testnet for initial testing
- Keep your secrets secure during the swap process

## Support

For issues or questions, refer to the main project documentation or create an issue in the repository.
