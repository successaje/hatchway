// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.s.sol";
import {Faulty} from "../src/Faulty.sol";

/// Reverts during forge's simulation, so nothing ever reaches the wallet.
contract Fails is Base {
    function run() external {
        vm.startBroadcast();
        Faulty faulty = new Faulty(false);
        faulty.boom();
        vm.stopBroadcast();
    }
}
