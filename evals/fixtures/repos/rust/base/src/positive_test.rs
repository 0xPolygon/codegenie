use super::positive_marker;

#[test]
fn missing_input_uses_fallback() {
    assert_eq!(positive_marker(None), "fallback");
}

