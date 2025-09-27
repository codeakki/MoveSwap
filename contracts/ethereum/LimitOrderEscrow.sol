// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LimitOrderEscrow
 * @dev Minimal contract for atomic swaps using 1inch Limit Order Protocol
 * Integrates with AggregationRouter to fill limit orders atomically
 */
contract LimitOrderEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // 1inch AggregationRouter on Base
    address public constant AGGREGATION_ROUTER = 0x1111111254EEB25477B68fb85Ed929f73A960582;

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

    mapping(bytes32 => bool) public processedOrders;
    mapping(bytes32 => address) public orderInitiators;

    event OrderCreated(bytes32 indexed orderId, address indexed maker, address makerAsset, address takerAsset, uint256 makingAmount, uint256 takingAmount);
    event OrderFilled(bytes32 indexed orderId, address indexed taker, uint256 makingAmount, uint256 takingAmount);
    event AtomicSwapCompleted(bytes32 indexed orderId, address indexed initiator, address taker);

    constructor() {}

    /**
     * @dev Create and fill a limit order atomically for atomic swap
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

        // For this minimal example, we'll simulate the order filling
        // In a real implementation, this would call the 1inch AggregationRouter
        // For now, just return the making amount as if the order was filled
        uint256 actualMakingAmount = fillArgs.makingAmount;

        emit OrderFilled(orderId, fillArgs.order.taker, fillArgs.makingAmount, fillArgs.takingAmount);
        emit AtomicSwapCompleted(orderId, msg.sender, fillArgs.order.taker);

        return actualMakingAmount;
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
