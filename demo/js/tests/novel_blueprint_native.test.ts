import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'bun:test';
import { NativeSession, readNativeArtifacts, textOf } from './native_session.ts';
import { waitForText, tapVisibleAction, tapUntilText } from './novel_interaction.ts';
const guest=resolve(import.meta.dir,'../../assets/apps/lantern');

for(const [choice,first,ending,forbidden] of [
 ['为晚归的船留灯','第60道光亮了','第六十道光没有改变潮汐','信先到了'],
 ['让回信先过海','五十九道光已经指向对岸','信先到了','第六十道光没有改变潮汐'],
])test(`real Lantern gallery blueprint executes ${choice} and restores the parked journey`,{timeout:180000},async()=>{
 process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(guest,'app.qjbc');
 process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(guest,'app.pak');
 process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(guest,'app.bytecode.json');
 const session=new NativeSession(readNativeArtifacts('POCKET_LANTERN'),{width:360,height:640,deadlineMs:150000});
 try{
  let frame=await session.boot();
  frame=await session.tap('启程 · 开始新的故事',frame);
  frame=await waitForText(session,frame,'23点08分');
  for(let n=0;n<120&&!session.storage['lantern.slot.auto'];n++)frame=await session.frame();
  assert.ok(session.storage['lantern.slot.auto'],'main journey established an actual auto-save');
  const parked=JSON.stringify(session.storage['lantern.slot.auto']);
  frame=await session.tap('手札',frame);
  frame=await tapVisibleAction(session,frame,'雾港纪念');
  frame=await tapVisibleAction(session,frame,'回看 · 第六十道光');
  frame=await waitForText(session,frame,'凌晨四点五十九分');
  const writes=session.storageSets.filter(p=>p.key==='lantern.slot.auto').length;
  frame=await tapUntilText(session,frame,'最后一根灯芯，留给谁',18);
  frame=await tapVisibleAction(session,frame,choice!);
  frame=await waitForText(session,frame,first!,240);
  assert.ok(!textOf(frame).includes(forbidden!));
  frame=await tapUntilText(session,frame,ending!,14);
  assert.ok(textOf(frame).includes(ending!),'chapter returned to the canonical flow ending');
  assert.equal(JSON.stringify(session.storage['lantern.slot.auto']),parked);
  assert.equal(session.storageSets.filter(p=>p.key==='lantern.slot.auto').length,writes,'replay does not auto-save into the parked main journey');
  frame=await session.tap('返回原旅程',frame);
  frame=await session.settle(frame,3);
  assert.ok(textOf(frame).includes('雾港纪念'));
  assert.equal(JSON.stringify(session.storage['lantern.slot.auto']),parked);
 }finally{await session.quit();}
});
