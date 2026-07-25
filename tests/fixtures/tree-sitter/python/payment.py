from __future__ import annotations
from decimal import Decimal
import asyncio, decimal as decimal_module
import os.path as os_path
from .gateways import Gateway as PaymentGateway, Receipt as GatewayReceipt
from ..shared.money import Money
from . import local_gateway
import asyncio


class BaseService:
    pass


def module_helper(
    value: Decimal,
) -> str:
    def local_formatter(item: Decimal) -> str:
        return str(item)

    return local_formatter(value)


@service_registry.register(
    "payments",
)
class PaymentService(BaseService):
    @staticmethod
    @audit(
        "authorize",
    )
    async def authorize(
        self,
        amount: Decimal,
    ) -> bool:
        def normalized(value: Decimal) -> Decimal:
            return value.copy_abs()

        if amount <= 0:
            return False
        return await self.gateway.authorize(normalized(amount))

    class Receipt:
        @property
        def code(self) -> str:
            return "ok"


@cache
class CachedService:
    def read(self) -> str:
        return "cached"
