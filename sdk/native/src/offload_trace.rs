//! Compact event records for the offload broker's shared trace lane.
//!
//! This module contains data shapes only. State transitions stay in
//! `offload.rs`; replay facts are applied through the same broker methods.

use super::OffloadProviderRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProviderRequest {
    pub generation: u32,
    pub session: u32,
    pub id: u64,
    pub method: String,
    pub payload: String,
    #[serde(rename = "timeoutMicros")]
    pub timeout_micros: u64,
}

impl From<&OffloadProviderRequest> for ProviderRequest {
    fn from(request: &OffloadProviderRequest) -> Self {
        Self {
            generation: request.generation,
            session: request.session,
            id: request.id,
            method: request.method.clone(),
            payload: request.payload.clone(),
            timeout_micros: request.timeout.as_micros().min(u64::MAX as u128) as u64,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub(super) enum ProviderResult {
    Payload(PayloadResult),
    Error(ErrorResult),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PayloadResult {
    pub payload: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ErrorResult {
    pub error: String,
}

impl ProviderResult {
    pub fn into_result(self) -> Result<String, String> {
        match self {
            Self::Payload(value) => Ok(value.payload),
            Self::Error(value) => Err(value.error),
        }
    }

    pub fn as_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProviderCompleteFact {
    pub generation: u32,
    #[serde(rename = "providerSession")]
    pub provider_session: u32,
    pub id: u64,
    pub result: ProviderResult,
    pub accepted: bool,
}
