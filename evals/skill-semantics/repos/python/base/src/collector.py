def collect(value: str, seen: list[str] | None = None) -> list[str]:
    current = [] if seen is None else seen
    current.append(value)
    return current
