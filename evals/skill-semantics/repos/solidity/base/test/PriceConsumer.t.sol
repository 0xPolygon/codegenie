// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MockFeed} from "../src/MockFeed.sol";
import {PriceConsumer} from "../src/PriceConsumer.sol";
import {SafePriceConsumer} from "../src/SafePriceConsumer.sol";

interface Vm {
    function warp(uint256 timestamp) external;
}

contract PriceConsumerTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testPositiveRejectsStaleRound() public {
        vm.warp(1_000);
        MockFeed feed = new MockFeed();
        feed.setRound(2_000e8, 100);
        PriceConsumer consumer = new PriceConsumer(feed, 300);

        (bool ok,) = address(consumer).call(abi.encodeCall(PriceConsumer.quote, (1e18)));
        require(!ok, "stale oracle data was accepted");
    }

    function testSafeControlChecksFreshnessAndUnits() public {
        vm.warp(1_000);
        MockFeed feed = new MockFeed();
        SafePriceConsumer consumer = new SafePriceConsumer(feed, 300);
        feed.setRound(2_000e8, 900);
        require(consumer.quote(1e18) == 2_000e18, "feed units were not normalized");

        feed.setRound(2_000e8, 100);
        (bool ok,) = address(consumer).call(abi.encodeCall(SafePriceConsumer.quote, (1e18)));
        require(!ok, "safe control accepted stale oracle data");
    }
}
