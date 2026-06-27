//! Integration tests for the cancellation registry.

use core_dispatch::CancellationRegistry;

#[test]
fn starting_same_request_cancels_the_previous_token() {
    let mut registry = CancellationRegistry::new();

    let first = registry.start(7);
    let second = registry.start(7);

    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
    assert_eq!(registry.len(), 1);
}

#[test]
fn explicit_cancel_marks_token_cancelled_and_forgets_it() {
    let mut registry = CancellationRegistry::new();

    let token = registry.start(3);
    registry.cancel(3);

    assert!(token.is_cancelled());
    assert!(registry.is_empty());
}

#[test]
fn finishing_a_request_forgets_it_without_cancelling() {
    let mut registry = CancellationRegistry::new();

    let token = registry.start(1);
    registry.finish(1);

    assert!(!token.is_cancelled());
    assert!(registry.is_empty());
}
