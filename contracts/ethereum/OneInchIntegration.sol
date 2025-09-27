// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title OneInchIntegration
 * @dev Contract that integrates with 1inch Limit Order Protocol for order filling
 * This contract acts as a bridge between HTLC swaps and 1inch order execution
 */
contract OneInchIntegration is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // 1inch Limit Order Protocol contract address
    address public immutable oneInchLimitOrderProtocol;
    
    // HTLC contract address
    address public immutable htlcContract;
    
    // Events
    event OrderFilled(
        bytes32 indexed htlcId,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address orderMaker
    );
    
    event OrderFillFailed(
        bytes32 indexed htlcId,
        string reason
    );

    // Struct for order data
    struct OrderInfo {
        address maker;
        address makerAsset;
        address takerAsset;
        uint256 makingAmount;
        uint256 takingAmount;
        address receiver;
        address allowedSender;
        uint256 salt;
        bytes makerAssetData;
        bytes takerAssetData;
        bytes getMakerAmount;
        bytes getTakerAmount;
        bytes predicate;
        bytes permit;
        bytes interaction;
    }

    // Struct for execution parameters
    struct ExecutionParams {
        bytes32 htlcId;
        uint256 makingAmount;
        uint256 takingAmount;
        uint256 thresholdAmount;
    }

    constructor(
        address _oneInchLimitOrderProtocol,
        address _htlcContract
    ) Ownable(msg.sender) {
        oneInchLimitOrderProtocol = _oneInchLimitOrderProtocol;
        htlcContract = _htlcContract;
    }

    /**
     * @dev Fill a 1inch limit order as part of HTLC swap
     * @param htlcId The HTLC ID associated with this order fill
     * @param order The 1inch order to fill
     * @param signature The order signature
     * @param interaction The interaction data for the order
     * @param makingAmount The amount being made (input)
     * @param takingAmount The amount being taken (output)
     * @param thresholdAmount The minimum amount to receive
     */
    function fillOrderForHTLC(
        bytes32 htlcId,
        OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 thresholdAmount
    ) external nonReentrant onlyHTLCContract {
        ExecutionParams memory params = ExecutionParams({
            htlcId: htlcId,
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            thresholdAmount: thresholdAmount
        });
        
        bytes memory emptyPermit = "";
        _executeOrderInternal(order, signature, interaction, params, false, emptyPermit);
    }

    /**
     * @dev Fill a 1inch limit order with additional parameters
     * @param htlcId The HTLC ID associated with this order fill
     * @param order The 1inch order to fill
     * @param signature The order signature
     * @param interaction The interaction data for the order
     * @param makingAmount The amount being made (input)
     * @param takingAmount The amount being taken (output)
     * @param thresholdAmount The minimum amount to receive
     * @param permit The permit data for token approval
     */
    function fillOrderWithPermit(
        bytes32 htlcId,
        OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 thresholdAmount,
        bytes calldata permit
    ) external nonReentrant onlyHTLCContract {
        ExecutionParams memory params = ExecutionParams({
            htlcId: htlcId,
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            thresholdAmount: thresholdAmount
        });
        
        bytes memory permitBytes = permit;
        _executeOrderInternal(order, signature, interaction, params, true, permitBytes);
    }

    /**
     * @dev Emergency function to withdraw tokens (only owner)
     * @param token The token to withdraw
     * @param amount The amount to withdraw
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            payable(owner()).transfer(amount);
        } else {
            IERC20(token).safeTransfer(owner(), amount);
        }
    }

    /**
     * @dev Get the 1inch Limit Order Protocol contract address
     */
    function getOneInchProtocol() external view returns (address) {
        return oneInchLimitOrderProtocol;
    }

    /**
     * @dev Get the HTLC contract address
     */
    function getHTLCContract() external view returns (address) {
        return htlcContract;
    }

    /**
     * @dev Check if an order can be filled
     * @param order The order to check
     * @param makingAmount The amount being made
     */
    function canFillOrder(
        OrderInfo calldata order,
        uint256 makingAmount,
        uint256 /* takingAmount */
    ) external view returns (bool) {
        return _checkOrderFillability(order, makingAmount);
    }

    /**
     * @dev Internal function to check order fillability
     */
    function _checkOrderFillability(
        OrderInfo calldata order,
        uint256 makingAmount
    ) internal view returns (bool) {
        IERC20 token = IERC20(order.makerAsset);
        
        return (token.balanceOf(order.maker) >= makingAmount &&
                token.allowance(order.maker, oneInchLimitOrderProtocol) >= makingAmount);
    }

    /**
     * @dev Internal function to execute the order (optimized)
     */
    function _executeOrderInternal(
        OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        ExecutionParams memory params,
        bool usePermit,
        bytes memory permit
    ) internal {
        _validateOrder(order, params.makingAmount, params.takingAmount);
        _transferTokens(order.makerAsset, params.makingAmount);
        _approveTokens(order.makerAsset, params.makingAmount);
        
        bool success = _callOneInchProtocol(order, signature, interaction, params, usePermit, permit);
        
        if (!success) {
            _revertTransfer(order.makerAsset, params.makingAmount);
            emit OrderFillFailed(params.htlcId, "1inch fillOrder failed");
            return;
        }

        _finalizeOrder(params.htlcId, order, params.makingAmount, params.thresholdAmount);
    }

    /**
     * @dev Internal function to validate order parameters
     */
    function _validateOrder(
        OrderInfo calldata order,
        uint256 makingAmount,
        uint256 takingAmount
    ) internal pure {
        require(order.maker != address(0), "Invalid maker");
        require(order.makerAsset != address(0), "Invalid maker asset");
        require(order.takerAsset != address(0), "Invalid taker asset");
        require(makingAmount > 0, "Invalid making amount");
        require(takingAmount > 0, "Invalid taking amount");
    }

    /**
     * @dev Transfer tokens from HTLC to this contract
     */
    function _transferTokens(address token, uint256 amount) internal {
        IERC20(token).safeTransferFrom(htlcContract, address(this), amount);
    }

    /**
     * @dev Approve 1inch protocol to spend tokens
     */
    function _approveTokens(address token, uint256 amount) internal {
        // Check current allowance and approve if needed
        uint256 currentAllowance = IERC20(token).allowance(address(this), oneInchLimitOrderProtocol);
        if (currentAllowance < amount) {
            // Reset to 0 first if there's existing allowance to avoid issues with some tokens
            if (currentAllowance > 0) {
                IERC20(token).approve(oneInchLimitOrderProtocol, 0);
            }
            IERC20(token).approve(oneInchLimitOrderProtocol, amount);
        }
    }

    /**
     * @dev Call 1inch protocol (optimized)
     */
    function _callOneInchProtocol(
        OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        ExecutionParams memory params,
        bool usePermit,
        bytes memory permit
    ) internal returns (bool) {
        if (usePermit) {
            return _callOneInchWithPermit(order, signature, interaction, params, permit);
        } else {
            return _callOneInchWithoutPermit(order, signature, interaction, params);
        }
    }

    /**
     * @dev Call 1inch protocol with permit
     */
    function _callOneInchWithPermit(
        OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        ExecutionParams memory params,
        bytes memory permit
    ) internal returns (bool) {
        (bool success,) = oneInchLimitOrderProtocol.call(
            abi.encodeWithSignature(
                "fillOrder((address,address,address,uint256,uint256,address,address,uint256,bytes,bytes,bytes,bytes,bytes,bytes,bytes),bytes,bytes,uint256,uint256,uint256,bytes)",
                order,
                signature,
                interaction,
                params.makingAmount,
                params.takingAmount,
                params.thresholdAmount,
                permit
            )
        );
        return success;
    }

    /**
     * @dev Call 1inch protocol without permit
     */
    function _callOneInchWithoutPermit(
        OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        ExecutionParams memory params
    ) internal returns (bool) {
        (bool success,) = oneInchLimitOrderProtocol.call(
            abi.encodeWithSignature(
                "fillOrder((address,address,address,uint256,uint256,address,address,uint256,bytes,bytes,bytes,bytes,bytes,bytes,bytes),bytes,bytes,uint256,uint256,uint256)",
                order,
                signature,
                interaction,
                params.makingAmount,
                params.takingAmount,
                params.thresholdAmount
            )
        );
        return success;
    }

    /**
     * @dev Revert token transfer on failure
     */
    function _revertTransfer(address token, uint256 amount) internal {
        IERC20(token).safeTransfer(htlcContract, amount);
    }

    /**
     * @dev Finalize the order execution
     */
    function _finalizeOrder(
        bytes32 htlcId,
        OrderInfo calldata order,
        uint256 makingAmount,
        uint256 thresholdAmount
    ) internal {
        uint256 receivedAmount = IERC20(order.takerAsset).balanceOf(address(this));
        require(receivedAmount >= thresholdAmount, "Insufficient output amount");
        
        IERC20(order.takerAsset).safeTransfer(htlcContract, receivedAmount);

        emit OrderFilled(
            htlcId,
            order.makerAsset,
            order.takerAsset,
            makingAmount,
            receivedAmount,
            order.maker
        );
    }

    modifier onlyHTLCContract() {
        require(msg.sender == htlcContract, "Only HTLC contract can call this function");
        _;
    }
}
