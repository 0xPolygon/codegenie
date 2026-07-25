pragma solidity ^0.8.24;

contract VaultTest {
    function setUp() public {}

    function testWithdrawRejectsExcess() public {
        vault.withdraw(101, payable(address(this)));
    }

    function invariantTotalAssetsBounded() public view {
        vault.withdraw(0, payable(address(this)));
    }

    function helperWithdraw() public {
        vault.withdraw(1, payable(address(this)));
    }
}

function testFreeFunctionIsNotFoundryTest() pure returns (bool) {
    return true;
}

interface TestInterface {
    function testInterfaceMethodIsNotFoundryTest() external;
}

library TestLibrary {
    function testLibraryMethodIsNotFoundryTest() internal pure returns (bool) {
        return true;
    }
}
