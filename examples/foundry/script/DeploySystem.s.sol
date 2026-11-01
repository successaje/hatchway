// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.s.sol";
import {HatchToken} from "../src/HatchToken.sol";
import {Registry} from "../src/Registry.sol";

/// Several transactions: two deployments, an initialization, a configuration call,
/// and an ownership transfer. Each one is approved separately in the wallet.
contract DeploySystem is Base {
    function run() external returns (HatchToken token, Registry registry) {
        address newOwner = vm.envOr("NEW_OWNER", address(0x000000000000000000000000000000000000bEEF));
        vm.startBroadcast();
        token = new HatchToken("Hatch Token", "HATCH", 1_000_000 ether);
        registry = new Registry();
        registry.initialize(msg.sender, address(token));
        registry.register("token", address(token));
        registry.transferOwnership(newOwner);
        vm.stopBroadcast();
    }
}
