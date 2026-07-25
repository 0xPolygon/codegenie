from src.collector import collect


def test_calls_do_not_share_implicit_state() -> None:
    first = collect("first")
    second = collect("second")
    assert first == ["first"], f"{first!r} != ['first']"
    assert second == ["second"], f"{second!r} != ['second']"


if __name__ == "__main__":
    test_calls_do_not_share_implicit_state()
