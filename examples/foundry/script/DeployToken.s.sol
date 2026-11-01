// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.s.sol";
import {HatchToken} from "../src/HatchToken.sol";

/// One contract with constructor arguments.
contract DeployToken is Base {
    function run() external returns (HatchToken token) {
        uint256 supply = vm.envOr("TOKEN_SUPPLY", uint256(1_000_000 ether));
        vm.startBroadcast();
        token = new HatchToken("Hatch Token", "HATCH", supply);
        vm.stopBroadcast();
    }
}
