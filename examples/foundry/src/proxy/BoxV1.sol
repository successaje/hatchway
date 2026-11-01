// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Upgradeable-style implementation used behind ERC1967Proxy in the examples.
contract BoxV1 {
    uint256 public value;
    address public admin;
    bool private _initialized;

    error AlreadyInitialized();
    error NotAdmin();

    function initialize(uint256 initialValue, address admin_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        value = initialValue;
        admin = admin_;
    }

    function setValue(uint256 newValue) external {
        if (msg.sender != admin) revert NotAdmin();
        value = newValue;
    }

    function version() external pure returns (string memory) {
        return "1";
    }
}
