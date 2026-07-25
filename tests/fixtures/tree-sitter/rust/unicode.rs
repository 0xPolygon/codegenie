use crate::{
    /* dépendance 😀 */
    Foo,
    Bar,
};

macro_rules! /* règle 😀 */ collect_values {
    () => {};
}

trait Blanket {
    fn run(&self);
}

impl<T> Blanket for T {
    fn run(&self) {}
}

struct Container<T>(T);

trait Concrete {
    fn run_concrete(&self);
}

impl<T> Concrete for Container<T> {
    fn run_concrete(&self) {}
}
