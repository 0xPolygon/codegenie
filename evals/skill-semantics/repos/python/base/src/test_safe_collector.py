from src.safe_collector import collect_safely


def test_calls_allocate_independent_lists() -> None:
    first = collect_safely("first")
    second = collect_safely("second")
    assert first == ["first"], f"{first!r} != ['first']"
    assert second == ["second"], f"{second!r} != ['second']"


if __name__ == "__main__":
    test_calls_allocate_independent_lists()
