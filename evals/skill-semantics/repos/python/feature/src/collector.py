def collect(value: str, seen: list[str] = []) -> list[str]:
    seen.append(value)
    return seen
