# ETH-SUI Cross-Chain Swap

This project implements a cross-chain swap solution between Ethereum and Sui networks using the 1inch Fusion+ protocol. It enables trustless atomic swaps using Hash Time Lock Contracts (HTLCs).

## Features

- Bidirectional token swaps between Ethereum and Sui networks
- Trustless execution using HTLCs
- Integration with 1inch Fusion+ protocol
- Secure secret management
- Real-time order status monitoring
- Support for multiple token pairs

## Prerequisites

- Node.js v18+
- Yarn or npm
- Sui CLI
- Ethereum wallet with testnet/mainnet tokens
- Sui wallet with testnet/mainnet tokens
- 1inch Developer Portal API key

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd eth-sui-swap
```

2. Install dependencies:
```bash
yarn install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` file with your credentials:
```
DEV_PORTAL_API_TOKEN=your_1inch_api_key
EVM_PRIVATE_KEY=your_ethereum_private_key
SUI_PRIVATE_KEY=your_sui_private_key
```

## Usage

### ETH to SUI Swap

```typescript
import { SDK, NetworkEnum, EvmAddress, SuiAddress } from '@1inch/cross-chain-sdk-sui'

// Initialize SDK
const sdk = new SDK({
  url: 'https://api.1inch.dev/fusion-plus',
  authKey: process.env.DEV_PORTAL_API_TOKEN
})

// Create and execute swap
async function swapETHtoSUI() {
  // Get quote
  const quote = await sdk.getQuote({
    srcChainId: NetworkEnum.ETHEREUM,
    dstChainId: NetworkEnum.SUI,
    srcTokenAddress: srcToken.toString(),
    dstTokenAddress: dstToken.toString(),
    amount: amount.toString(),
    walletAddress: maker
  })

  // Create order
  const order = quote.createEvmOrder({
    hashLock,
    receiver: SuiAddress.fromString(receiver),
    preset: quote.recommendedPreset
  })

  // Submit and monitor order
  const { orderHash } = await sdk.submitOrder(
    NetworkEnum.ETHEREUM,
    order,
    quote.quoteId,
    secretHashes
  )

  // Monitor and complete swap
  await monitorAndCompleteSwap(orderHash, secrets)
}
```

### SUI to ETH Swap

```typescript
async function swapSUItoETH() {
  // Get quote
  const quote = await sdk.getQuote({
    srcChainId: NetworkEnum.SUI,
    dstChainId: NetworkEnum.ETHEREUM,
    srcTokenAddress: srcToken.toString(),
    dstTokenAddress: dstToken.toString(),
    amount: amount.toString(),
    walletAddress: maker
  })

  // Create order
  const order = quote.createSuiOrder({
    hashLock,
    receiver: EvmAddress.fromString(receiver),
    preset: quote.recommendedPreset
  })

  // Submit and monitor order
  const orderHash = await sdk.announceOrder(
    order,
    quote.quoteId,
    secretHashes
  )

  // Monitor and complete swap
  await monitorAndCompleteSwap(orderHash, secrets)
}
```

## Architecture

The project consists of several key components:

1. Smart Contracts
   - Ethereum HTLC Contract
   - Sui Move HTLC Contract
   - Token Escrow Contracts

2. SDK Integration
   - Extended 1inch Cross-chain SDK
   - Custom Sui blockchain provider
   - Integration with ETH provider

3. Core Features
   - Bidirectional swaps
   - Hash lock mechanism
   - Timelock safety
   - Secret revelation system
   - Order management

For detailed implementation steps, see [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## Development

### Running Tests

```bash
# Run all tests
yarn test

# Run specific test suite
yarn test:eth
yarn test:sui
yarn test:integration
```

### Local Development

1. Start local Ethereum network:
```bash
yarn hardhat:node
```

2. Start local Sui network:
```bash
sui-test-validator
```

3. Deploy contracts:
```bash
yarn deploy:local
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- 1inch Protocol team for the Fusion+ SDK
- Sui Foundation for Move language support
- Ethereum community for smart contract development tools
