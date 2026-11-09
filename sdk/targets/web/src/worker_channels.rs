//! Browser transport adaptation of the pinned worker UI mirror contract.
//! Resource execution remains in the independent QJBC worker realm.
use crate::{binary_bridge, WasmHost};
use rquickjs::{
    function::{FromParams, Function, IntoJsFunc, ParamRequirement, Params},
    Array, Ctx, Object, TypedArray, Value,
};
use serde::Deserialize;
use std::{
    cell::RefCell,
    collections::{HashSet, VecDeque},
    rc::Rc,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Declaration {
    name: String,
    kind: String,
    direction: String,
    record_bytes: usize,
    capacity: usize,
}
struct Channel {
    declaration: Declaration,
    configured: bool,
    incoming: VecDeque<Vec<u8>>,
    outgoing: VecDeque<Vec<u8>>,
    mirror: Vec<Vec<u8>>,
}
pub struct UiChannels {
    channels: Vec<Channel>,
}
type Shared = Rc<RefCell<Option<UiChannels>>>;

impl UiChannels {
    pub(crate) fn valid_declarations(declarations: &[serde_json::Value]) -> bool {
        serde_json::to_vec(declarations)
            .ok()
            .is_some_and(|bytes| Self::parse(&bytes).is_ok())
    }
    fn parse(bytes: &[u8]) -> Result<Self, ()> {
        let declarations: Vec<Declaration> = serde_json::from_slice(bytes).map_err(|_| ())?;
        if declarations.len() > 8 {
            return Err(());
        }
        let mut names = HashSet::new();
        let mut channels = Vec::new();
        for declaration in declarations {
            if declaration.name.is_empty()
                || declaration.name.len() > 63
                || !declaration.name.as_bytes()[0].is_ascii_alphabetic()
                || !declaration
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
                || !names.insert(declaration.name.clone())
                || !matches!(declaration.kind.as_str(), "snapshot" | "ring")
                || !matches!(
                    declaration.direction.as_str(),
                    "ui-to-worker" | "worker-to-ui"
                )
                || !(1..=1024).contains(&declaration.record_bytes)
                || !(1..=8).contains(&declaration.capacity)
            {
                return Err(());
            }
            channels.push(Channel {
                declaration,
                configured: false,
                incoming: VecDeque::new(),
                outgoing: VecDeque::new(),
                mirror: Vec::new(),
            });
        }
        Ok(Self { channels })
    }
    fn channel(&mut self, id: u32) -> Option<&mut Channel> {
        self.channels.get_mut(id.checked_sub(1)? as usize)
    }
    fn push(&mut self, id: u32, bytes: &[u8], from_worker: bool) -> i32 {
        let Some(channel) = self.channel(id) else {
            return -5;
        };
        if bytes.len() > channel.declaration.record_bytes
            || from_worker != (channel.declaration.direction == "worker-to-ui")
        {
            return -5;
        }
        let queue = if from_worker {
            &mut channel.incoming
        } else {
            &mut channel.outgoing
        };
        if channel.declaration.kind == "snapshot" {
            queue.clear();
        } else if queue.len() >= channel.declaration.capacity {
            return -4;
        }
        queue.push_back(bytes.to_vec());
        0
    }
    fn latch(&mut self) {
        for channel in &mut self.channels {
            if !channel.configured {
                continue;
            }
            if channel.declaration.kind == "ring" {
                channel.mirror.clear();
            }
            if !channel.incoming.is_empty() {
                channel.mirror = channel.incoming.drain(..).collect();
            }
        }
    }
}

struct Observe {
    shared: Shared,
}
impl<'js> IntoJsFunc<'js, (Ctx<'js>, u32)> for Observe {
    fn param_requirements() -> ParamRequirement {
        <(Ctx<'js>, u32)>::param_requirements()
    }
    fn call<'a>(&self, params: Params<'a, 'js>) -> rquickjs::Result<Value<'js>> {
        let (ctx, id) = <(Ctx<'js>, u32)>::from_params(&mut params.access())?;
        let shared = self.shared.borrow();
        let channel = shared
            .as_ref()
            .and_then(|channels| {
                id.checked_sub(1)
                    .and_then(|i| channels.channels.get(i as usize))
            })
            .filter(|channel| channel.configured)
            .ok_or(rquickjs::Error::Exception)?;
        let array = Array::new(ctx.clone())?;
        for (index, data) in channel.mirror.iter().enumerate() {
            array.set(index, TypedArray::<u8>::new_copy(ctx.clone(), data)?)?;
        }
        Ok(array.into_value())
    }
}

pub fn install<'js>(ctx: &Ctx<'js>, shared: Shared) -> rquickjs::Result<()> {
    if shared.borrow().is_none() {
        return Ok(());
    }
    let namespace = Object::new(ctx.clone())?;
    let configure = shared.clone();
    namespace.set(
        "configure",
        Function::new(ctx.clone(), move |id: u32, snapshot: u32| -> i32 {
            let mut state = configure.borrow_mut();
            let Some(channel) = state.as_mut().and_then(|channels| channels.channel(id)) else {
                return -5;
            };
            if snapshot > 1 || (snapshot == 1) != (channel.declaration.kind == "snapshot") {
                return -5;
            }
            channel.configured = true;
            0
        })?,
    )?;
    let publish = shared.clone();
    namespace.set(
        "publish",
        Function::new(
            ctx.clone(),
            move |id: u32, bytes: TypedArray<'_, u8>| -> i32 {
                let Some(bytes) = bytes.as_bytes() else {
                    return -5;
                };
                let mut state = publish.borrow_mut();
                state.as_mut().map_or(-5, |channels| {
                    if !channels
                        .channel(id)
                        .is_some_and(|channel| channel.configured)
                    {
                        return -5;
                    }
                    channels.push(id, bytes, false)
                })
            },
        )?,
    )?;
    namespace.set("observe", Function::new(ctx.clone(), Observe { shared })?)?;
    ctx.globals().set("__pocketWorkerChannels", namespace)
}

pub fn before_frame(ctx: &Ctx<'_>, shared: &Shared) -> rquickjs::Result<()> {
    if let Some(channels) = shared.borrow_mut().as_mut() {
        channels.latch();
    }
    let hook: Value = ctx.globals().get("__pocketWorkerChannelFrame")?;
    if let Some(function) = hook.as_function() {
        function.call::<_, ()>(())?;
    }
    Ok(())
}

/// Configure declared channels before UI QJBC evaluation. Input is the JSON
/// channel array from the admitted Worker descriptor; never guest JS source.
#[no_mangle]
pub unsafe extern "C" fn web_worker_channels_configure(
    host: &WasmHost,
    p: *const u8,
    n: usize,
) -> i32 {
    if p.is_null() || n == 0 || n > 16 * 1024 || host.worker_channels.borrow().is_some() {
        return -5;
    }
    let Ok(channels) = UiChannels::parse(std::slice::from_raw_parts(p, n)) else {
        return -5;
    };
    *host.worker_channels.borrow_mut() = Some(channels);
    0
}

#[no_mangle]
pub unsafe extern "C" fn web_worker_channels_push(
    host: &WasmHost,
    id: u32,
    p: *const u8,
    n: usize,
) -> i32 {
    if n > 1024 || (n != 0 && p.is_null()) {
        return -5;
    }
    let bytes = if n == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(p, n)
    };
    host.worker_channels
        .borrow_mut()
        .as_mut()
        .map_or(-5, |channels| channels.push(id, bytes, true))
}

/// Drains UI-to-worker records to the existing bounded binary result buffer.
#[no_mangle]
pub extern "C" fn web_worker_channels_take(host: &WasmHost) -> i32 {
    let mut shared = host.worker_channels.borrow_mut();
    let Some(channels) = shared.as_mut() else {
        return -5;
    };
    let mut records = Vec::new();
    for (index, channel) in channels.channels.iter_mut().enumerate() {
        while records.len() < 8 {
            let Some(data) = channel.outgoing.pop_front() else {
                break;
            };
            records.push(serde_json::json!({"channel": index + 1, "data": data}));
        }
    }
    match binary_bridge::encode_json_to_binary(&serde_json::json!({"records": records}), 128 * 1024)
    {
        Ok(bytes) => {
            *host.result.borrow_mut() = bytes;
            0
        }
        Err(_) => -1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Shared {
        Rc::new(RefCell::new(Some(UiChannels::parse(br#"[
          {"name":"request","kind":"ring","direction":"ui-to-worker","recordBytes":4,"capacity":1},
          {"name":"progress","kind":"snapshot","direction":"worker-to-ui","recordBytes":4,"capacity":1},
          {"name":"events","kind":"ring","direction":"worker-to-ui","recordBytes":4,"capacity":2}
        ]"#).unwrap())))
    }
    #[test]
    fn bounds_directions_and_backpressure_match_channel_contract() {
        let shared = fixture();
        let mut state = shared.borrow_mut();
        let state = state.as_mut().unwrap();
        assert_eq!(state.push(0, &[1], false), -5);
        assert_eq!(state.push(1, &[1; 5], false), -5);
        assert_eq!(state.push(1, &[1], true), -5);
        assert_eq!(state.push(1, &[1], false), 0);
        assert_eq!(state.push(1, &[2], false), -4);
        assert_eq!(state.push(2, &[1], true), 0);
        assert_eq!(state.push(2, &[2], true), 0);
        assert_eq!(state.channels[1].incoming.len(), 1);
    }
    #[test]
    fn quickjs_mirrors_latch_before_frame_and_snapshot_survives_idle() {
        let shared = fixture();
        let runtime = rquickjs::Runtime::new().unwrap();
        let context = rquickjs::Context::full(&runtime).unwrap();
        context.with(|ctx| {
            install(&ctx, shared.clone()).unwrap();
            ctx.eval::<(), _>(
                "globalThis.frames=0;globalThis.__pocketWorkerChannelFrame=()=>{frames++}",
            )
            .unwrap();
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.configure(2,1)")
                    .unwrap(),
                0
            );
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.configure(3,0)")
                    .unwrap(),
                0
            );
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.configure(2,0)")
                    .unwrap(),
                -5
            );
            {
                let mut state = shared.borrow_mut();
                let state = state.as_mut().unwrap();
                state.push(2, &[7], true);
                state.push(3, &[8], true);
            }
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.observe(2).length")
                    .unwrap(),
                0
            );
            before_frame(&ctx, &shared).unwrap();
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.observe(2)[0][0]")
                    .unwrap(),
                7
            );
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.observe(3)[0][0]")
                    .unwrap(),
                8
            );
            before_frame(&ctx, &shared).unwrap();
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.observe(2)[0][0]")
                    .unwrap(),
                7
            );
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.observe(3).length")
                    .unwrap(),
                0
            );
            assert_eq!(ctx.eval::<i32, _>("frames").unwrap(), 2);
            ctx.eval::<(), _>("__pocketWorkerChannels.configure(1,0)")
                .unwrap();
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.publish(1,Uint8Array.of(1))")
                    .unwrap(),
                0
            );
            assert_eq!(
                ctx.eval::<i32, _>("__pocketWorkerChannels.publish(1,Uint8Array.of(2))")
                    .unwrap(),
                -4
            );
        });
    }
}
