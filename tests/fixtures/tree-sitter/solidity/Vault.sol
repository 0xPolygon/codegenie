// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Access.sol";
import * as Math from "./Math.sol";
import {Token as Asset, IERC20} from "./Token.sol";
import "./Access.sol" as AccessAlias;

abstract contract Vault is Access {
    uint256 public totalAssets;
    uint256 internal constant MAX_WITHDRAWAL = 1_000 ether;
    address public immutable asset;

    struct Position {
        uint128 shares;
        uint128 debt;
    }

    enum Status {
        Open,
        Closed
    }

    type Shares is uint128;
    event Withdrawal(address indexed account, uint256 amount);
    error InsufficientAssets(uint256 available, uint256 requested);

    modifier onlyOwner() {
        _;
    }

    constructor(address asset_) {
        asset = asset_;
    }

    function withdraw(
        uint256 amount,
        address payable recipient
    ) external onlyOwner returns (uint256 remaining) {
        require(amount <= totalAssets, "insufficient");
        totalAssets -= amount;
        recipient.transfer(amount);
        emit Withdrawal(recipient, amount);
        return totalAssets;
    }

    function withdraw(address token) external onlyOwner returns (bool) {
        return IERC20(token).transfer(msg.sender, 1);
    }

    fallback() external payable {}
    receive() external payable {}
}

interface IVault {
    function totalAssets() external view returns (uint256);
}

library VaultMath {
    function scale(uint256 amount) internal pure returns (uint256) {
        return amount * 1e18;
    }
}

function normalize(uint256 amount) pure returns (uint256) {
    return amount / 1e12;
}

uint256 constant FILE_LIMIT = 100;
