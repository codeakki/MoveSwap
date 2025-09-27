// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./OneInchIntegration.sol";

contract HTLC is ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    struct Lock {
        bytes32 htlc_id;
        bytes32 hashlock;
        uint256 timelock;
        address sender;
        address receiver;
        uint256 amount;
        bytes32 secret;
        bool withdrawn;
        bool refunded;
        uint256 created_at;
        address token; // 0x0 for ETH, otherwise ERC20 token address
    }

    struct OrderExecutionParams {
        bytes32 htlc_id;
        uint256 makingAmount;
        uint256 takingAmount;
        uint256 thresholdAmount;
        bool usePermit;
    }

    // 1inch Integration contract
    OneInchIntegration public oneInchIntegration;
    
    mapping(bytes32 => Lock) public locks;

    event HTLCCreated(
        bytes32 indexed htlc_id,
        address indexed sender,
        address indexed receiver,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock,
        address token
    );

    event HTLCClaimed(
        bytes32 indexed htlc_id,
        address indexed receiver,
        bytes32 secret,
        uint256 amount
    );

    event HTLCRefunded(
        bytes32 indexed htlc_id,
        address indexed sender,
        uint256 amount
    );

    event OneInchIntegrationSet(
        address indexed oneInchIntegration
    );

    event OrderExecuted(
        bytes32 indexed htlc_id,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor() {
        // 1inch integration will be set after deployment
    }

    /**
     * @dev Set the 1inch integration contract address
     * @param _oneInchIntegration The address of the OneInchIntegration contract
     */
    function setOneInchIntegration(address _oneInchIntegration) external {
        require(_oneInchIntegration != address(0), "Invalid 1inch integration address");
        oneInchIntegration = OneInchIntegration(_oneInchIntegration);
        emit OneInchIntegrationSet(_oneInchIntegration);
    }

    modifier onlyInvolvedParties(bytes32 _htlc_id) {
        require(
            msg.sender == locks[_htlc_id].sender || msg.sender == locks[_htlc_id].receiver,
            "Not authorized"
        );
        _;
    }

    function createHTLC(
        bytes32 _htlc_id,
        address _receiver,
        bytes32 _hashlock,
        uint256 _timelock,
        address _token
    ) external payable nonReentrant {
        require(_timelock > block.timestamp, "Timelock must be in the future");
        require(_receiver != address(0), "Invalid receiver address");
        require(locks[_htlc_id].sender == address(0), "HTLC already exists");

        uint256 amount;
        if (_token == address(0)) {
            // ETH HTLC
            amount = msg.value;
            require(amount > 0, "Amount must be greater than 0");
        } else {
            // ERC20 HTLC
            amount = IERC20(_token).allowance(msg.sender, address(this));
            require(amount > 0, "Token allowance must be greater than 0");
            IERC20(_token).safeTransferFrom(msg.sender, address(this), amount);
        }

        locks[_htlc_id] = Lock({
            htlc_id: _htlc_id,
            hashlock: _hashlock,
            timelock: _timelock,
            sender: msg.sender,
            receiver: _receiver,
            amount: amount,
            secret: 0,
            withdrawn: false,
            refunded: false,
            created_at: block.timestamp,
            token: _token
        });

        emit HTLCCreated(
            _htlc_id,
            msg.sender,
            _receiver,
            amount,
            _hashlock,
            _timelock,
            _token
        );
    }

    function claimHTLC(bytes32 _htlc_id, bytes32 _secret) external nonReentrant {
        Lock storage lock = locks[_htlc_id];
        require(msg.sender == lock.receiver, "Not the receiver");
        require(!lock.withdrawn, "Already withdrawn");
        require(!lock.refunded, "Already refunded");
        require(block.timestamp < lock.timelock, "Timelock expired");
        require(sha256(abi.encodePacked(_secret)) == lock.hashlock, "Invalid secret");

        lock.secret = _secret;
        lock.withdrawn = true;

        if (lock.token == address(0)) {
            // Transfer ETH
            (bool success, ) = lock.receiver.call{value: lock.amount}("");
            require(success, "ETH transfer failed");
        } else {
            // Transfer ERC20
            IERC20(lock.token).safeTransfer(lock.receiver, lock.amount);
        }

        emit HTLCClaimed(_htlc_id, lock.receiver, _secret, lock.amount);
    }

    function refundHTLC(bytes32 _htlc_id) external nonReentrant {
        Lock storage lock = locks[_htlc_id];
        require(msg.sender == lock.sender, "Not the sender");
        require(!lock.withdrawn, "Already withdrawn");
        require(!lock.refunded, "Already refunded");
        require(block.timestamp >= lock.timelock, "Timelock not expired");

        lock.refunded = true;

        if (lock.token == address(0)) {
            // Transfer ETH back
            (bool success, ) = lock.sender.call{value: lock.amount}("");
            require(success, "ETH transfer failed");
        } else {
            // Transfer ERC20 back
            IERC20(lock.token).safeTransfer(lock.sender, lock.amount);
        }

        emit HTLCRefunded(_htlc_id, lock.sender, lock.amount);
    }

    function getHTLC(bytes32 _htlc_id) external view returns (Lock memory) {
        return locks[_htlc_id];
    }

    function getSecret(bytes32 _htlc_id) external view returns (bytes32) {
        return locks[_htlc_id].secret;
    }

    /**
     * @dev Execute a 1inch order as part of HTLC swap
     * @param _htlc_id The HTLC ID
     * @param order The 1inch order to execute
     * @param signature The order signature
     * @param interaction The interaction data
     * @param makingAmount The amount being made
     * @param takingAmount The amount being taken
     * @param thresholdAmount The minimum amount to receive
     */
    function executeOneInchOrder(
        bytes32 _htlc_id,
        OneInchIntegration.OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 thresholdAmount
    ) external nonReentrant onlyInvolvedParties(_htlc_id) {
        OrderExecutionParams memory params = OrderExecutionParams({
            htlc_id: _htlc_id,
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            thresholdAmount: thresholdAmount,
            usePermit: false
        });
        
        bytes memory emptyPermit = "";
        _executeOrderInternal(order, signature, interaction, params, emptyPermit);
    }

    /**
     * @dev Execute a 1inch order with permit
     * @param _htlc_id The HTLC ID
     * @param order The 1inch order to execute
     * @param signature The order signature
     * @param interaction The interaction data
     * @param makingAmount The amount being made
     * @param takingAmount The amount being taken
     * @param thresholdAmount The minimum amount to receive
     * @param permit The permit data
     */
    function executeOneInchOrderWithPermit(
        bytes32 _htlc_id,
        OneInchIntegration.OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256 thresholdAmount,
        bytes calldata permit
    ) external nonReentrant onlyInvolvedParties(_htlc_id) {
        OrderExecutionParams memory params = OrderExecutionParams({
            htlc_id: _htlc_id,
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            thresholdAmount: thresholdAmount,
            usePermit: true
        });
        
        _executeOrderInternal(order, signature, interaction, params, permit);
    }

    /**
     * @dev Internal function to execute 1inch orders
     */
    function _executeOrderInternal(
        OneInchIntegration.OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        OrderExecutionParams memory params,
        bytes memory permit
    ) internal {
        Lock storage lock = locks[params.htlc_id];
        
        _validateOrderExecution(lock, order);
        _transferTokensForOrder(lock.token, params.makingAmount);
        _callOneInchIntegration(order, signature, interaction, params, permit);
        _updateLockAfterOrder(lock, order);
        
        emit OrderExecuted(
            params.htlc_id,
            order.makerAsset,
            order.takerAsset,
            params.makingAmount,
            lock.amount
        );
    }

    /**
     * @dev Validate order execution preconditions
     */
    function _validateOrderExecution(Lock storage lock, OneInchIntegration.OrderInfo calldata order) internal view {
        require(!lock.withdrawn, "Already withdrawn");
        require(!lock.refunded, "Already refunded");
        require(address(oneInchIntegration) != address(0), "1inch integration not set");
        require(lock.token == order.makerAsset, "Token mismatch");
    }

    /**
     * @dev Transfer tokens to 1inch integration contract
     */
    function _transferTokensForOrder(address token, uint256 amount) internal {
        IERC20(token).safeTransfer(address(oneInchIntegration), amount);
    }

    /**
     * @dev Call 1inch integration contract
     */
    function _callOneInchIntegration(
        OneInchIntegration.OrderInfo calldata order,
        bytes calldata signature,
        bytes calldata interaction,
        OrderExecutionParams memory params,
        bytes memory permit
    ) internal {
        if (params.usePermit) {
            oneInchIntegration.fillOrderWithPermit(
                params.htlc_id,
                order,
                signature,
                interaction,
                params.makingAmount,
                params.takingAmount,
                params.thresholdAmount,
                permit
            );
        } else {
            oneInchIntegration.fillOrderForHTLC(
                params.htlc_id,
                order,
                signature,
                interaction,
                params.makingAmount,
                params.takingAmount,
                params.thresholdAmount
            );
        }
    }

    /**
     * @dev Update lock after successful order execution
     */
    function _updateLockAfterOrder(Lock storage lock, OneInchIntegration.OrderInfo calldata order) internal {
        lock.token = order.takerAsset;
        lock.amount = IERC20(order.takerAsset).balanceOf(address(this));
    }

    /**
     * @dev Check if an order can be executed
     * @param _htlc_id The HTLC ID
     * @param order The 1inch order to check
     * @param makingAmount The amount being made
     * @param takingAmount The amount being taken
     */
    function canExecuteOrder(
        bytes32 _htlc_id,
        OneInchIntegration.OrderInfo calldata order,
        uint256 makingAmount,
        uint256 takingAmount
    ) external view returns (bool) {
        Lock storage lock = locks[_htlc_id];
        
        return _canExecuteOrderInternal(lock, order, makingAmount, takingAmount);
    }

    /**
     * @dev Internal function to check if order can be executed
     */
    function _canExecuteOrderInternal(
        Lock storage lock,
        OneInchIntegration.OrderInfo calldata order,
        uint256 makingAmount,
        uint256 takingAmount
    ) internal view returns (bool) {
        if (lock.withdrawn || lock.refunded || 
            address(oneInchIntegration) == address(0) ||
            lock.token != order.makerAsset ||
            lock.amount < makingAmount) {
            return false;
        }
        
        return oneInchIntegration.canFillOrder(order, makingAmount, takingAmount);
    }
}
