// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The few Foundry cheatcodes these scripts use, so the example has no dependencies.
/// In your own project, `import {Script} from "forge-std/Script.sol"` works the same way.
interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bool public IS_SCRIPT = true;
}
