// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Counter {
    uint256 public number;

    event NumberSet(uint256 number);

    function setNumber(uint256 newNumber) external {
        number = newNumber;
        emit NumberSet(newNumber);
    }

    function increment() external {
        number += 1;
        emit NumberSet(number);
    }
}
