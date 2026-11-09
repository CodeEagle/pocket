import { strict as assert } from 'node:assert';
import { test } from 'bun:test';
import { createNovelEngine } from '../../../../sdk/packages/pocket_vn/src/engine.ts';
import { createNovelReplayEngine } from '../../../../sdk/packages/pocket_vn/src/replay.ts';
import { localizeStory, diagnoseStoryLocale, type StoryLocaleCatalogCollection } from '../../../../sdk/packages/pocket_vn/src/localization.ts';
import type { StoryDefinition } from '../../../../sdk/packages/pocket_vn/src/types.ts';
import { lanternStory } from './story.ts';
import localeDocument from './novel.locales.json';
const catalogs=localeDocument.catalogs as StoryLocaleCatalogCollection;
for(const locale of ['zh','en'])for(const [choice,lights,body] of [['keep_light',60,'blueprint_lit_body'],['send_letter',59,'blueprint_depart_body']] as const){
 test(`The Sixtieth Light ${locale}/${choice} executes real chapter flow without altering the main journey`,()=>{
  assert.equal(diagnoseStoryLocale(lanternStory,catalogs[locale]!).filter(d=>d.severity==='error').length,0);
  const story=localizeStory(lanternStory,catalogs,locale).story;
  const main=createNovelEngine(story);main.start();
  const parked=JSON.stringify(main.save());
  const replay=createNovelReplayEngine(story,main.getSnapshot(),'chapter_blueprint_showcase');
  const opening:string[]=[];
  for(let n=0;n<40&&replay.getSnapshot().active?.kind!=='choice';n++){
   const active=replay.getSnapshot().active;if(active?.kind==='say')opening.push(active.id);replay.advance();
  }
  assert.ok(opening.includes('blueprint_opening_01'));
  assert.equal(replay.getSnapshot().active?.kind,'choice');
  replay.selectChoice(choice);
  assert.equal(replay.getSnapshot().variables.blueprint_lights,lights);
  assert.equal(replay.getSnapshot().active?.location.label,body);
  assert.equal(replay.getSnapshot().callStack.length,1,'chapter is a real engine call');
  const restored=createNovelReplayEngine(story,main.getSnapshot(),'chapter_blueprint_showcase');restored.load(replay.save());
  assert.equal(restored.getSnapshot().callStack.length,1);
  for(let n=0;n<20&&restored.getSnapshot().active?.kind!=='ending';n++)restored.advance();
  assert.equal(restored.getSnapshot().active?.kind,'ending');
  assert.equal(restored.getSnapshot().callStack.length,0,'chapter EOF/return resumes wrapper continuation');
  assert.equal(restored.getSnapshot().active?.location.label,lights===60?'blueprint_end_lit':'blueprint_end_depart');
  assert.equal(JSON.stringify(main.save()),parked);
  const bare={...story} as {editor?:unknown};delete bare.editor;
  const plain=createNovelReplayEngine(bare as StoryDefinition,main.getSnapshot(),'chapter_blueprint_showcase');
  for(let n=0;n<40&&plain.getSnapshot().active?.kind!=='choice';n++)plain.advance();plain.selectChoice(choice);
  for(let n=0;n<20&&plain.getSnapshot().active?.kind!=='ending';n++)plain.advance();
  assert.equal(JSON.stringify(plain.getSnapshot().active),JSON.stringify(restored.getSnapshot().active));
 });
}
