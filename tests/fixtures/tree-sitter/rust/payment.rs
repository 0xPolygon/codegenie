use std::{fmt::Debug as StdDebug, sync::*};
use anyhow::Result;
extern crate alloc as heap;
use std::{fmt::Debug as StdDebug, sync::*};

#[repr(C)]
#[derive(Debug)]
pub struct Payment<T> {
    value: T,
}

pub union PaymentBits {
    raw: u64,
}

pub enum PaymentState {
    Pending,
    Settled,
}

pub type PaymentId = u64;
pub const DEFAULT_LIMIT: usize = 10;
static NEXT_ID: usize = 1;

pub trait Gateway {
    #[cfg(feature = "async-gateway")]
    fn authorize(
        &self,
        amount: u64,
    ) -> Result<bool>;

    type Receipt;
    const MAX_RETRIES: usize;
}

pub trait BackupGateway {
    fn authorize(&self, amount: u64) -> Result<bool>;
}

impl<T> Gateway for Payment<T> {
    type Receipt = T;
    const MAX_RETRIES: usize = 3;

    #[track_caller]
    fn authorize(
        &self,
        amount: u64,
    ) -> Result<bool> {
        Ok(amount > 0)
    }
}

impl<T> BackupGateway for Payment<T> {
    fn authorize(&self, amount: u64) -> Result<bool> {
        Ok(amount >= 10)
    }
}

impl<T> Payment<T> {
    #[inline]
    pub fn capture(&self, amount: u64) -> bool {
        amount > 0
    }
}

#[macro_export]
macro_rules! payment_id {
    ($value:expr) => {
        $value as u64
    };
}

mod audit {
    pub fn record() {}
}
