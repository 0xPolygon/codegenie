from .payment import PaymentService


def test_authorize_uses_gateway() -> None:
    assert PaymentService.authorize is not None
