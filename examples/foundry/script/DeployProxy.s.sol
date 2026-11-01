// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.s.sol";
import {BoxV1} from "../src/proxy/BoxV1.sol";
import {ERC1967Proxy} from "../src/proxy/ERC1967Proxy.sol";

/// Implementation + ERC-1967 proxy initialized in its constructor, then a call through the proxy.
contract DeployProxy is Base {
    function run() external returns (BoxV1 box) {
        vm.startBroadcast();
        BoxV1 implementation = new BoxV1();
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), abi.encodeCall(BoxV1.initialize, (42, msg.sender)));
        box = BoxV1(address(proxy));
        box.setValue(43);
        vm.stopBroadcast();
    }
}
