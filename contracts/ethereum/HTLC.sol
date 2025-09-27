// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract HTLC is ReentrancyGuard {
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
            require(IERC20(_token).transferFrom(msg.sender, address(this), amount), "Token transfer failed");
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
            require(IERC20(lock.token).transfer(lock.receiver, lock.amount), "Token transfer failed");
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
            require(IERC20(lock.token).transfer(lock.sender, lock.amount), "Token transfer failed");
        }

        emit HTLCRefunded(_htlc_id, lock.sender, lock.amount);
    }

    function getHTLC(bytes32 _htlc_id) external view returns (
        bytes32 htlc_id,
        bytes32 hashlock,
        uint256 timelock,
        address sender,
        address receiver,
        uint256 amount,
        bytes32 secret,
        bool withdrawn,
        bool refunded,
        uint256 created_at,
        address token
    ) {
        Lock memory lock = locks[_htlc_id];
        return (
            lock.htlc_id,
            lock.hashlock,
            lock.timelock,
            lock.sender,
            lock.receiver,
            lock.amount,
            lock.secret,
            lock.withdrawn,
            lock.refunded,
            lock.created_at,
            lock.token
        );
    }

    function getSecret(bytes32 _htlc_id) external view returns (bytes32) {
        return locks[_htlc_id].secret;
    }
}
