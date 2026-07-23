pragma solidity ^0.8.24;

contract VaultIntegrationTest {
    function testWithdrawTransfersAssets() public {
        vault.withdraw(10, payable(address(this)));
    }
}
