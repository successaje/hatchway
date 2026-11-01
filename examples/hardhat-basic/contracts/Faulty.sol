// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fails on purpose; used to show how reverts are reported.
contract Faulty {
    error Boom(uint256 code);

    constructor(bool failOnDeploy) {
        if (failOnDeploy) revert Boom(1);
    }

    function boom() external pure {
        revert Boom(42);
    }
}
