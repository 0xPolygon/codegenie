from src.payment import PaymentService


def test_authorize_package_variant() -> None:
    assert PaymentService.authorize is not None
