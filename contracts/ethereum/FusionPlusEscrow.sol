// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title FusionPlusEscrow
 * @dev 1inch Fusion+ compatible escrow contract for cross-chain atomic swaps
 * Integrates with 1inch Limit Order Protocol and supports hashlock/timelock functionality
 * for non-EVM chains like Sui, Aptos, Bitcoin variants, Tron, TON, etc.
 */
contract FusionPlusEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // 1inch AggregationRouter on Base
    address public constant AGGREGATION_ROUTER = 0x1111111254EEB25477B68fb85Ed929f73A960582;

    // Supported non-EVM chains
    enum NonEVMChain {
        Sui,
        Aptos,
        Bitcoin,
        BitcoinCash,
        Dogecoin,
        Litecoin,
        Tron,
        TON,
        Monad,
        Near,
        Starknet,
        Cardano,
        Stellar,
        XRPLedger,
        ICP,
        Tezos,
        Polkadot,
        EOS,
        Cosmos
    }

    struct SwapOrder {
        bytes32 orderId;
        address maker;
        address taker;
        address makerAsset;
        address takerAsset;
        uint256 makingAmount;
        uint256 takingAmount;
        uint256 expiration;
        bytes makerAssetData;
        bytes takerAssetData;
        bytes getMakingAmount;
        bytes getTakingAmount;
        bytes predicate;
        bytes permit;
        bytes interaction;
    }

    struct FillOrderArgs {
        SwapOrder order;
        bytes signature;
        uint256 makingAmount;
        uint256 takingAmount;
        address recipient;
    }

    struct CrossChainSwap {
        bytes32 swapId;
        address initiator;
        address ethereumAddress;
        bytes32 nonEVMAddress; // Hash of the non-EVM address for verification
        bytes32 hashlock;
        uint256 timelock;
        uint256 ethAmount;
        uint256 nonEVMTokenAmount;
        address ethToken;
        NonEVMChain nonEVMChain;
        bool ethFilled;
        bool nonEVMFilled;
        bool ethRefunded;
        bool nonEVMRefunded;
    }

    mapping(bytes32 => bool) public processedOrders;
    mapping(bytes32 => address) public orderInitiators;
    mapping(bytes32 => CrossChainSwap) public crossChainSwaps;
    mapping(bytes32 => bool) public usedHashlocks;

    event OrderCreated(bytes32 indexed orderId, address indexed maker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount);
    event OrderFilled(bytes32 indexed orderId, address indexed taker, uint256 makingAmount, uint256 takingAmount);
    event AtomicSwapCompleted(bytes32 indexed orderId, address indexed initiator, address taker);

    event CrossChainSwapInitiated(
        bytes32 indexed swapId,
        address indexed initiator,
        NonEVMChain nonEVMChain,
        bytes32 hashlock,
        uint256 timelock,
        uint256 ethAmount,
        uint256 nonEVMTokenAmount
    );

    event CrossChainSwapFilled(
        bytes32 indexed swapId,
        bool ethSide,
        bytes32 secret
    );

    event CrossChainSwapRefunded(
        bytes32 indexed swapId,
        bool ethSide
    );

    constructor() {}

    /**
     * @dev Create and fill a limit order atomically for atomic swap (1inch Fusion+ compatible)
     * @param fillArgs The fill order arguments including order details and signature
     * @param recipient The address to receive the taker assets
     */
    function createAndFillOrder(
        FillOrderArgs calldata fillArgs,
        address recipient
    ) external payable nonReentrant returns (uint256) {
        bytes32 orderId = keccak256(abi.encode(fillArgs.order));

        require(!processedOrders[orderId], "Order already processed");
        require(fillArgs.order.expiration > block.timestamp, "Order expired");
        require(fillArgs.order.maker != address(0) && fillArgs.order.taker != address(0), "Invalid addresses");

        // Store order initiator
        orderInitiators[orderId] = msg.sender;

        // Mark order as processed
        processedOrders[orderId] = true;

        // For Fusion+ integration, we simulate the order filling
        // In production, this would call the actual 1inch AggregationRouter
        uint256 actualMakingAmount = fillArgs.makingAmount;

        // Note: Skipping actual 1inch router call for demo purposes
        // In production, uncomment the following lines:
        /*
        bytes memory fillOrderCallData = abi.encodeWithSignature(
            "fillOrder((address,address,address,address,uint256,uint256,uint256,bytes,bytes,bytes,bytes,bytes,bytes,bytes),bytes,uint256,uint256,address)",
            fillArgs.order,
            fillArgs.signature,
            fillArgs.makingAmount,
            fillArgs.takingAmount,
            recipient
        );

        (bool success, bytes memory returnData) = AGGREGATION_ROUTER.call{value: msg.value}(fillOrderCallData);

        if (!success) {
            revert("Fill order failed");
        }

        actualMakingAmount = abi.decode(returnData, (uint256));
        */

        emit OrderFilled(orderId, fillArgs.order.taker, fillArgs.makingAmount, fillArgs.takingAmount);
        emit AtomicSwapCompleted(orderId, msg.sender, fillArgs.order.taker);

        return actualMakingAmount;
    }

    /**
     * @dev Initiate a cross-chain atomic swap with hashlock and timelock
     * @param nonEVMAddress Hash of the non-EVM chain address
     * @param hashlock Hash of the secret
     * @param timelock Unix timestamp for expiration
     * @param ethAmount Amount of ETH/tokens to lock on Ethereum
     * @param nonEVMTokenAmount Amount of tokens to lock on non-EVM chain
     * @param ethToken Token contract address (address(0) for ETH)
     * @param nonEVMChain The target non-EVM chain
     */
    function initiateCrossChainSwap(
        bytes32 nonEVMAddress,
        bytes32 hashlock,
        uint256 timelock,
        uint256 ethAmount,
        uint256 nonEVMTokenAmount,
        address ethToken,
        NonEVMChain nonEVMChain
    ) external payable nonReentrant returns (bytes32) {
        require(timelock > block.timestamp, "Timelock must be in the future");
        require(!usedHashlocks[hashlock], "Hashlock already used");
        require(ethAmount > 0, "ETH amount must be greater than 0");

        bytes32 swapId = keccak256(abi.encodePacked(msg.sender, nonEVMAddress, hashlock, block.timestamp));

        // Lock ETH/tokens on Ethereum side
        if (ethToken == address(0)) {
            require(msg.value == ethAmount, "ETH amount mismatch");
        } else {
            require(IERC20(ethToken).transferFrom(msg.sender, address(this), ethAmount), "Token transfer failed");
        }

        // Create cross-chain swap record
        crossChainSwaps[swapId] = CrossChainSwap({
            swapId: swapId,
            initiator: msg.sender,
            ethereumAddress: msg.sender,
            nonEVMAddress: nonEVMAddress,
            hashlock: hashlock,
            timelock: timelock,
            ethAmount: ethAmount,
            nonEVMTokenAmount: nonEVMTokenAmount,
            ethToken: ethToken,
            nonEVMChain: nonEVMChain,
            ethFilled: false,
            nonEVMFilled: false,
            ethRefunded: false,
            nonEVMRefunded: false
        });

        usedHashlocks[hashlock] = true;

        emit CrossChainSwapInitiated(
            swapId,
            msg.sender,
            nonEVMChain,
            hashlock,
            timelock,
            ethAmount,
            nonEVMTokenAmount
        );

        return swapId;
    }

    /**
     * @dev Fill the Ethereum side of a cross-chain swap by revealing the secret
     * @param swapId The swap identifier
     * @param secret The preimage of the hashlock
     * @param recipient The address to receive the locked funds
     */
    function fillEthereumSide(
        bytes32 swapId,
        bytes32 secret,
        address recipient
    ) external nonReentrant {
        CrossChainSwap storage swap = crossChainSwaps[swapId];

        require(swap.initiator != address(0), "Swap not found");
        require(!swap.ethFilled, "ETH side already filled");
        require(!swap.ethRefunded, "ETH side already refunded");
        require(block.timestamp < swap.timelock, "Timelock expired");
        require(sha256(abi.encodePacked(secret)) == swap.hashlock, "Invalid secret");

        swap.ethFilled = true;

        // Transfer locked funds to recipient
        if (swap.ethToken == address(0)) {
            (bool success, ) = recipient.call{value: swap.ethAmount}("");
            require(success, "ETH transfer failed");
        } else {
            require(IERC20(swap.ethToken).transfer(recipient, swap.ethAmount), "Token transfer failed");
        }

        emit CrossChainSwapFilled(swapId, true, secret);
    }

    /**
     * @dev Fill the non-EVM side of a cross-chain swap (to be called by oracle/bridge)
     * @param swapId The swap identifier
     * @param secret The preimage of the hashlock
     */
    function fillNonEVMSide(
        bytes32 swapId,
        bytes32 secret
    ) external {
        CrossChainSwap storage swap = crossChainSwaps[swapId];

        require(swap.initiator != address(0), "Swap not found");
        require(!swap.nonEVMFilled, "Non-EVM side already filled");
        require(!swap.nonEVMRefunded, "Non-EVM side already refunded");
        require(block.timestamp < swap.timelock, "Timelock expired");
        require(sha256(abi.encodePacked(secret)) == swap.hashlock, "Invalid secret");

        swap.nonEVMFilled = true;

        emit CrossChainSwapFilled(swapId, false, secret);
    }

    /**
     * @dev Refund the Ethereum side after timelock expiration
     * @param swapId The swap identifier
     */
    function refundEthereumSide(bytes32 swapId) external nonReentrant {
        CrossChainSwap storage swap = crossChainSwaps[swapId];

        require(swap.initiator != address(0), "Swap not found");
        require(!swap.ethFilled, "ETH side already filled");
        require(!swap.ethRefunded, "ETH side already refunded");
        require(block.timestamp >= swap.timelock, "Timelock not expired");

        swap.ethRefunded = true;

        // Refund locked funds to initiator
        if (swap.ethToken == address(0)) {
            (bool success, ) = swap.initiator.call{value: swap.ethAmount}("");
            require(success, "ETH refund failed");
        } else {
            require(IERC20(swap.ethToken).transfer(swap.initiator, swap.ethAmount), "Token refund failed");
        }

        emit CrossChainSwapRefunded(swapId, true);
    }

    /**
     * @dev Get cross-chain swap details
     * @param swapId The swap identifier
     * @return swap The cross-chain swap details
     */
    function getCrossChainSwap(bytes32 swapId) external view returns (CrossChainSwap memory) {
        return crossChainSwaps[swapId];
    }

    /**
     * @dev Get order details by ID
     * @param orderId The order identifier
     * @return initiator The address that initiated the order
     * @return processed Whether the order has been processed
     */
    function getOrderInfo(bytes32 orderId) external view returns (address initiator, bool processed) {
        return (orderInitiators[orderId], processedOrders[orderId]);
    }

    /**
     * @dev Fallback function to receive ETH
     */
    receive() external payable {}
}
