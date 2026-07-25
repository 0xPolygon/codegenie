def collect_safely(value: str, seen: list[str] | None = None) -> list[str]:
    if seen is None:
        seen = []
    seen.append(value)
    return seen
