use payment::Payment;

#[async_std::test]
async fn capture_integration() {
    let payment = Payment { value: 1_u64 };
    assert!(payment.capture(10));
}

#[test_case]
fn parameterized_helper_is_not_a_v1_test_case() {
    let payment = Payment { value: 1_u64 };
    assert!(payment.capture(20));
}
