use super::Payment;

#[test]
fn authorize_rejects_zero() {
    let payment = Payment { value: 1_u64 };
    assert!(!payment.capture(0));
}

#[tokio::test]
async fn authorize_async() {
    let payment = Payment { value: 1_u64 };
    assert!(payment.capture(10));
}

#[cfg(test)]
fn helper_is_not_a_test_case() {
    let _payment = Payment { value: 1_u64 };
}
