// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Ownable registry that must be initialized after deployment.
contract Registry {
    address public owner;
    address public token;
    bool public initialized;
    mapping(bytes32 => address) public entries;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Registered(bytes32 indexed key, address value);

    error NotOwner(address caller);
    error AlreadyInitialized();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    function initialize(address owner_, address token_) external {
        if (initialized) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroAddress();
        initialized = true;
        owner = owner_;
        token = token_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function register(bytes32 key, address value) external onlyOwner {
        entries[key] = value;
        emit Registered(key, value);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
