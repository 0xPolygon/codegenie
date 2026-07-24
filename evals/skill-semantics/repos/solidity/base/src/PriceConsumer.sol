// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MockFeed} from "./MockFeed.sol";

contract PriceConsumer {
    MockFeed public immutable feed;
    uint256 public immutable maxAge;

    constructor(MockFeed nextFeed, uint256 nextMaxAge) {
        feed = nextFeed;
        maxAge = nextMaxAge;
    }

    function quote(uint256 amount) external view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        require(answer > 0, "invalid answer");
        require(updatedAt != 0 && updatedAt <= block.timestamp, "invalid timestamp");
        require(block.timestamp - updatedAt <= maxAge, "stale price");
        return amount * uint256(answer) / (10 ** feed.decimals());
    }
}
