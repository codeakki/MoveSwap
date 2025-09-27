// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title LimitOrderEscrow
 * @dev Contract for atomic swaps using 1inch Limit Order Protocol
 */
// 1inch Limit Order Protocol Interface
interface ILimitOrderProtocol {
    function fillOrderArgs(
        bytes calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 thresholdAmount
    ) external returns (uint256, uint256);
}

contract LimitOrderEscrow is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // Split the struct into core data and order data to optimize storage
    struct AtomicSwapCore {
        bytes32 hashlock;
        uint256 timelock;
        address maker;
        address taker;
        address makerAsset;
        address takerAsset;
        uint256 makerAmount;
        uint256 takerAmount;
        bool filled;
        bool refunded;
    }

    struct AtomicSwapExtended {
        bytes32 secret;
        uint256 createdAt;
        bytes orderData;
        bytes signature;
    }

    event AtomicSwapOrderCreated(
        bytes32 indexed orderId,
        address indexed maker,
        address indexed taker,
        address makerAsset,
        address takerAsset,
        uint256 makerAmount,
        uint256 takerAmount,
        bytes32 hashlock,
        uint256 timelock
    );

    event AtomicSwapOrderFilled(
        bytes32 indexed orderId,
        address indexed taker,
        bytes32 secret,
        uint256 makerAmount,
        uint256 takerAmount
    );

    event AtomicSwapOrderRefunded(
        bytes32 indexed orderId,
        address indexed maker,
        uint256 makerAmount
    );

    mapping(bytes32 => AtomicSwapCore) public atomicSwapOrders;
    mapping(bytes32 => AtomicSwapExtended) public atomicSwapExtendedData;
    mapping(address => bool) public authorizedRelayers;
    
    ILimitOrderProtocol public immutable limitOrderProtocol;
    address public immutable weth;

    modifier onlyAuthorizedRelayer() {
        require(authorizedRelayers[msg.sender], "Not authorized relayer");
        _;
    }

    modifier onlyOrderParties(bytes32 orderId) {
        AtomicSwapCore memory order = atomicSwapOrders[orderId];
        require(
            msg.sender == order.maker || msg.sender == order.taker,
            "Not order party"
        );
        _;
    }

    /**
     * @dev Constructor to initialize the contract
     * @param _limitOrderProtocol Address of 1inch Limit Order Protocol
     * @param _weth Address of WETH token
     * 
     * Sepolia Testnet:
     * - Limit Order Protocol: 0x1111111254EEB25477B68fb85Ed929f73A960582
     * - WETH: 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14
     *
     * Mainnet:
     * - Limit Order Protocol: 0x1111111254EEB25477B68fb85Ed929f73A960582
     * - WETH: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
     */
    constructor(
        address _limitOrderProtocol,
        address _weth
    ) Ownable(msg.sender) {
        require(_limitOrderProtocol != address(0), "Invalid protocol address");
        require(_weth != address(0), "Invalid WETH address");
        limitOrderProtocol = ILimitOrderProtocol(_limitOrderProtocol);
        weth = _weth;
    }

    /**
     * @dev Creates an atomic swap order
     * @param orderId Unique identifier for the order
     * @param taker Address that can fill the order
     * @param makerAsset Token being sold (address(0) for ETH)
     * @param takerAsset Token being bought
     * @param makerAmount Amount of maker asset
     * @param takerAmount Amount of taker asset
     * @param hashlock Hash of the secret
     * @param timelock Timestamp after which order can be refunded
     * @param orderData 1inch order data
     * @param signature 1inch order signature
     */
    function createAtomicSwapOrder(
        bytes32 orderId,
        address taker,
        address makerAsset,
        address takerAsset,
        uint256 makerAmount,
        uint256 takerAmount,
        bytes32 hashlock,
        uint256 timelock,
        bytes calldata orderData,
        bytes calldata signature
    ) external payable nonReentrant {
        require(atomicSwapOrders[orderId].maker == address(0), "Order exists");
        require(timelock > block.timestamp, "Invalid timelock");
        require(taker != address(0), "Invalid taker");
        require(makerAmount > 0 && takerAmount > 0, "Invalid amounts");

        if (makerAsset == address(0)) {
            require(msg.value == makerAmount, "Incorrect ETH amount");
        } else {
            IERC20(makerAsset).safeTransferFrom(
                msg.sender,
                address(this),
                makerAmount
            );
        }

        atomicSwapOrders[orderId] = AtomicSwapCore({
            hashlock: hashlock,
            timelock: timelock,
            maker: msg.sender,
            taker: taker,
            makerAsset: makerAsset,
            takerAsset: takerAsset,
            makerAmount: makerAmount,
            takerAmount: takerAmount,
            filled: false,
            refunded: false
        });

        atomicSwapExtendedData[orderId] = AtomicSwapExtended({
            secret: bytes32(0),
            createdAt: block.timestamp,
            orderData: orderData,
            signature: signature
        });

        emit AtomicSwapOrderCreated(
            orderId,
            msg.sender,
            taker,
            makerAsset,
            takerAsset,
            makerAmount,
            takerAmount,
            hashlock,
            timelock
        );
    }

    /**
     * @dev Fills an atomic swap order using 1inch's fillOrderArgs
     * @param orderId Order identifier
     * @param secret Secret that matches the hashlock
     * @param interaction Interaction data for 1inch
     * @param makingAmount Amount being made
     * @param takingAmount Amount being taken
     * @param thresholdAmount Minimum amount to accept
     */
    function fillAtomicSwapOrder(
        bytes32 orderId,
        bytes32 secret,
        bytes calldata interaction,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 thresholdAmount
    ) external nonReentrant onlyAuthorizedRelayer {
        AtomicSwapCore storage order = atomicSwapOrders[orderId];
        AtomicSwapExtended storage extendedData = atomicSwapExtendedData[orderId];
        
        require(order.maker != address(0), "Order not found");
        require(!order.filled, "Order already filled");
        require(!order.refunded, "Order refunded");
        require(block.timestamp < order.timelock, "Order expired");
        require(sha256(abi.encodePacked(secret)) == order.hashlock, "Invalid secret");
        require(msg.sender == order.taker || authorizedRelayers[msg.sender], "Not authorized taker");

        extendedData.secret = secret;
        order.filled = true;

        (uint256 actualMakingAmount, uint256 actualTakingAmount) = 
            limitOrderProtocol.fillOrderArgs(
                extendedData.orderData,
                extendedData.signature,
                interaction,
                makingAmount,
                takingAmount,
                thresholdAmount
            );

        _transferAssets(order, actualMakingAmount, actualTakingAmount);

        emit AtomicSwapOrderFilled(
            orderId,
            msg.sender,
            secret,
            actualMakingAmount,
            actualTakingAmount
        );
    }

    /**
     * @dev Refunds an atomic swap order after timelock expiry
     * @param orderId Order identifier
     */
    function refundAtomicSwapOrder(bytes32 orderId) external nonReentrant onlyOrderParties(orderId) {
        AtomicSwapCore storage order = atomicSwapOrders[orderId];
        
        require(!order.filled, "Order already filled");
        require(!order.refunded, "Order already refunded");
        require(block.timestamp >= order.timelock, "Timelock not expired");

        order.refunded = true;

        if (order.makerAsset == address(0)) {
            (bool success, ) = order.maker.call{value: order.makerAmount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(order.makerAsset).safeTransfer(order.maker, order.makerAmount);
        }

        emit AtomicSwapOrderRefunded(orderId, order.maker, order.makerAmount);
    }

    /**
     * @dev Internal function to transfer assets after order fill
     */
    function _transferAssets(
        AtomicSwapCore memory order,
        uint256 actualMakingAmount,
        uint256 actualTakingAmount
    ) internal {
        if (order.makerAsset == address(0)) {
            (bool success, ) = order.taker.call{value: actualMakingAmount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(order.makerAsset).safeTransfer(order.taker, actualMakingAmount);
        }
    }

    /**
     * @dev Gets atomic swap order details
     * @param orderId Order identifier
     */
    struct OrderView {
        bytes32 hashlock;
        uint256 timelock;
        address maker;
        address taker;
        bool filled;
        bool refunded;
    }

    function getAtomicSwapOrderCore(bytes32 orderId) external view returns (OrderView memory) {
        AtomicSwapCore memory order = atomicSwapOrders[orderId];
        return OrderView(
            order.hashlock,
            order.timelock,
            order.maker,
            order.taker,
            order.filled,
            order.refunded
        );
    }

    function getAtomicSwapOrderAssets(bytes32 orderId) external view returns (
        address makerAsset,
        address takerAsset,
        uint256 makerAmount,
        uint256 takerAmount
    ) {
        AtomicSwapCore memory order = atomicSwapOrders[orderId];
        return (
            order.makerAsset,
            order.takerAsset,
            order.makerAmount,
            order.takerAmount
        );
    }

    function getAtomicSwapOrderData(bytes32 orderId) external view returns (
        bytes32 secret,
        uint256 createdAt
    ) {
        AtomicSwapExtended memory extended = atomicSwapExtendedData[orderId];
        return (extended.secret, extended.createdAt);
    }

    /**
     * @dev Gets the revealed secret for an order
     * @param orderId Order identifier
     */
    function getRevealedSecret(bytes32 orderId) external view returns (bytes32) {
        return atomicSwapExtendedData[orderId].secret;
    }

    /**
     * @dev Authorizes a relayer
     * @param relayer Address of the relayer
     */
    function authorizeRelayer(address relayer) external onlyOwner {
        require(relayer != address(0), "Invalid relayer address");
        authorizedRelayers[relayer] = true;
    }

    /**
     * @dev Revokes a relayer's authorization
     * @param relayer Address of the relayer
     */
    function revokeRelayer(address relayer) external onlyOwner {
        authorizedRelayers[relayer] = false;
    }

    /**
     * @dev Emergency function to recover stuck tokens
     * @param token Token address (address(0) for ETH)
     * @param amount Amount to recover
     */
    function emergencyRecover(address token, uint256 amount) external onlyOwner {
        require(amount > 0, "Invalid amount");
        if (token == address(0)) {
            (bool success, ) = owner().call{value: amount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(owner(), amount);
        }
    }

    receive() external payable {}
}
