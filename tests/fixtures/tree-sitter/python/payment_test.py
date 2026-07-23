import pytest
from .payment import PaymentService


def helper_is_not_a_test() -> bool:
    return True


def test_authorize_rejects_zero() -> None:
    def test_nested_is_not_collected() -> bool:
        return False

    assert PaymentService.authorize is not None


class TestPaymentService:
    @pytest.mark.asyncio
    async def test_authorize_accepts_positive(self) -> None:
        assert PaymentService.authorize is not None

    def helper_is_not_a_test(self) -> bool:
        return True


class PaymentExamples:
    def test_authorize_not_collected(self) -> None:
        assert PaymentService.authorize is not None
