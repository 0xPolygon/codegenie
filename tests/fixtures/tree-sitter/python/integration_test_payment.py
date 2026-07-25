from src.payment import PaymentService


class TestPaymentIntegration:
    def test_authorize_integration(self) -> None:
        assert PaymentService.authorize is not None
