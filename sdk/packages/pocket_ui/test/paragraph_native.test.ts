import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const sdk = resolve(import.meta.dir, '../../..');
const probe = process.env.POCKET_NATIVE_PROBE || join(sdk, 'native/target/debug/pocket_probe');

test('MobileParagraph wraps within measured nested card widths and reflows on resize', () => {
 const root = mkdtempSync(join(tmpdir(), 'pocket-paragraph-'));
 try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({name:'paragraph-fixture',type:'module',private:true}));
  writeFileSync(join(root, 'pocket.json'), JSON.stringify({appId:'pocket.test.paragraph',entry:'app.tsx'}));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({capabilities:{requires:[]}}));
  writeFileSync(join(root, 'app.tsx'), `
import { mount } from '@pocketjs/framework/solid';
import { Screen, Text, View } from '@pocketjs/framework/solid/components';
import { MobileScaffold, MobileThemeProvider, MobileCard, MobileParagraph } from '@pocket/ui';
function App(){return <Screen class="w-full h-full flex-col"><MobileThemeProvider><MobileScaffold><View class="w-full p-6"><MobileCard><MobileParagraph text="No background URL listener or route selection. Check the initial link only when requested."/><MobileParagraph text="Choose a connected service and characteristic before read, write, or notify."/><View class="flex-col w-[160]"><MobileParagraph text="Nested paragraphs must use the narrow parent width instead of the full screen width."/></View><Text>After paragraphs</Text></MobileCard></View></MobileScaffold></MobileThemeProvider></Screen>};mount(App);
`);
  const out = join(root, 'out');
  const build = spawnSync('bun', [join(sdk,'scripts/build_guest.ts'), '--project-root='+root, '--outdir='+out], {encoding:'utf8',timeout:120000});
  expect(build.status, build.stdout+'\n'+build.stderr).toBe(0);
  const commands:any[] = [{op:'create',width:390,height:844},{op:'loadBytecode',bytecodePath:join(out,'app.qjbc'),pakPath:join(out,'app.pak')}];
  for(const width of [390,320,480]){commands.push({op:'resize',width,height:844});for(let i=0;i<8;i++)commands.push({op:'frame',deltaMs:16});}
  commands.push({op:'quit'});
  const result=spawnSync(probe,[],{input:commands.map(v=>JSON.stringify(v)).join('\n')+'\n',encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
  expect(result.status,result.stderr).toBe(0);
  const replies=result.stdout.trim().split('\n').map(v=>JSON.parse(v));
  let width=390,observed=0;const heights:number[]=[];
  for(let i=0;i<commands.length;i++){
   if(commands[i].op==='resize')width=commands[i].width;
   if(commands[i].op!=='frame'||commands[i+1]?.op==='frame')continue;
   const frame=replies[i].frame;expect(frame).toBeDefined();
   const texts=frame.ops.filter((op:any)=>op.type==='text');
   const paragraphs=texts.filter((op:any)=>op.text.includes('No background URL')||op.text.includes('Choose a connected'));
   expect(paragraphs, JSON.stringify({width,texts,replies:replies.filter((v:any)=>v.ok===false)})).toHaveLength(2);
   for(const op of paragraphs){expect(op.x).toBeGreaterThanOrEqual(40);expect(op.x+op.w).toBeLessThanOrEqual(width-40);expect(op.text).toContain('\n');}
   const nested=texts.find((op:any)=>op.text.includes('Nested paragraphs'));
   expect(nested).toBeDefined();expect(nested.w).toBeLessThanOrEqual(160);expect(nested.text).toContain('\n');
   const after=texts.find((op:any)=>op.text==='After paragraphs');
   expect(after.y).toBeGreaterThanOrEqual(paragraphs[1].y+paragraphs[1].h);
   heights.push(paragraphs.reduce((sum:number,op:any)=>sum+op.h,0));observed++;
  }
  expect(observed).toBe(3);expect(heights[1]).toBeGreaterThanOrEqual(heights[0]);expect(heights[2]).toBeLessThanOrEqual(heights[1]);
 }finally{rmSync(root,{recursive:true,force:true});}
},150000);

test('MobileParagraph remeasures when its parent width changes without a viewport resize', () => {
 const root = mkdtempSync(join(tmpdir(), 'pocket-paragraph-parent-resize-'));
 try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({name:'paragraph-parent-resize',type:'module',private:true}));
  writeFileSync(join(root, 'pocket.json'), JSON.stringify({appId:'pocket.test.paragraph.parentresize',entry:'app.tsx'}));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({capabilities:{requires:[]}}));
  writeFileSync(join(root, 'app.tsx'), `
import { createSignal } from 'solid-js';
import { mount } from '@pocketjs/framework/solid';
import { FocusScope, Screen, View } from '@pocketjs/framework/solid/components';
import { MobileParagraph, MobileScaffold, MobileThemeProvider, MobileTonalButton } from '@pocket/ui';
function App(){const [narrow,setNarrow]=createSignal(false);return <Screen class="w-full h-full flex-col"><FocusScope autoFocus><MobileThemeProvider><MobileScaffold><MobileTonalButton label="Toggle" compact onPress={() => setNarrow(v => !v)} /><View class={narrow() ? "w-[160]" : "w-[280]"}><MobileParagraph text="Parent width changes without a viewport resize and must remeasure this paragraph." /></View></MobileScaffold></MobileThemeProvider></FocusScope></Screen>};mount(App);
`);
  const out = join(root, 'out');
  const build = spawnSync('bun', [join(sdk,'scripts/build_guest.ts'), '--project-root='+root, '--outdir='+out], {encoding:'utf8',timeout:120000});
  expect(build.status, build.stdout+'\n'+build.stderr).toBe(0);
  const bytecodePath=join(out,'app.qjbc');const pakPath=join(out,'app.pak');
  const initialCommands:any[]=[{op:'create',width:390,height:844},{op:'loadBytecode',bytecodePath,pakPath},{op:'frame',deltaMs:16},{op:'frame',deltaMs:16},{op:'frame',deltaMs:16},{op:'quit'}];
  const initialResult=spawnSync(probe,[],{input:initialCommands.map(v=>JSON.stringify(v)).join('\n')+'\n',encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
  expect(initialResult.status,initialResult.stderr).toBe(0);
  const initialReplies=initialResult.stdout.trim().split('\n').map(v=>JSON.parse(v));
  const initialFrame=initialReplies[initialCommands.length-2].frame;
  const toggle=initialFrame.ops.find((op:any)=>op.type==='text'&&op.text==='Toggle');
  const paragraphBefore=initialFrame.ops.find((op:any)=>op.type==='text'&&typeof op.text==='string'&&op.text.includes('Parent width changes'));
  expect(toggle).toBeDefined();expect(paragraphBefore).toBeDefined();
  const x=Number(toggle.x)+Number(toggle.w)/2;const y=Number(toggle.y)+Number(toggle.h)/2;
  const commands:any[]=[{op:'create',width:390,height:844},{op:'loadBytecode',bytecodePath,pakPath},{op:'frame',deltaMs:16},{op:'frame',deltaMs:16},{op:'frame',deltaMs:16},{op:'send',message:{type:'event',name:'input.pointer',payload:{phase:'down',id:0,x,y}}},{op:'frame',deltaMs:16},{op:'send',message:{type:'event',name:'input.pointer',payload:{phase:'up',id:0,x,y}}},{op:'frame',deltaMs:16},{op:'frame',deltaMs:16},{op:'frame',deltaMs:16},{op:'quit'}];
  const result=spawnSync(probe,[],{input:commands.map(v=>JSON.stringify(v)).join('\n')+'\n',encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
  expect(result.status,result.stderr).toBe(0);
  const replies=result.stdout.trim().split('\n').map(v=>JSON.parse(v));
  const finalFrame=replies[commands.length-2].frame;
  const paragraphAfter=finalFrame.ops.find((op:any)=>op.type==='text'&&typeof op.text==='string'&&op.text.includes('Parent width changes'));
  expect(paragraphAfter).toBeDefined();
  expect(paragraphAfter.w).toBeLessThan(Number(paragraphBefore.w));
  expect(paragraphAfter.text).toContain('\n');
 }finally{rmSync(root,{recursive:true,force:true});}
},150000);
