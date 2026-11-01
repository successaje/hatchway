// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.s.sol";
import {Counter} from "../src/Counter.sol";

/// One contract, no constructor arguments.
contract DeployCounter is Base {
    function run() external returns (Counter counter) {
        vm.startBroadcast();
        counter = new Counter();
        vm.stopBroadcast();
    }
}
