"""Émoji and Unicode before declarations: café 😀."""

@trace(
    "café",
)
async def fetch_value(
    item_id: str,
) -> str:
    normalized = item_id.strip()
    return normalized
