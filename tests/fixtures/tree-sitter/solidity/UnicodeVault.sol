// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Dépôt limite 😀
uint256 constant FILE_LIMIT = 100;

/// @notice Coffre pour café
contract UnicodeVault {
    uint256 internal constant MAX_DEPOSIT = 10;

    /// @notice Calcule une cotation
    function quote(
        uint256 amount
    ) external pure returns (uint256 quoted) {
        quoted = amount;
    }
}
