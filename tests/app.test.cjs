'use strict';
// Event-driven logic tests with a deliberately small DOM stub. These complement,
// and do not replace, real browser layout / microphone / Safari verification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const KEY = 'ielts-atelier-v1', SESSION = 'ielts-atelier-session-v1';
const listeningTranscripts = [
  'The code is alpha.',
  'The office opens today. Bring your blue badge. Register on arrival.',
  'Meet outside the library. The tour takes an hour.',
  'Call the help desk after lunch.'
];
const fixtures = [
  ...['listening', 'reading'].flatMap(skill => Array.from({length:40}, (_,i) => ({id:`${skill}-${i}`, skill, groupId:`${skill}-group-${Math.floor(i / 10)}`, module:'both', origin:'original', title:`${skill} question ${i + 1}`, type:i < 20 ? '填空' : '判断题', topic:'Study', level:'基础', prompt:`Write the code for question ${i + 1}.`, transcript:skill==='listening'?listeningTranscripts[Math.floor(i / 10)]:'The code is alpha.', passage:skill==='reading'&&i===39?undefined:`Material ${Math.floor(i / 10)+1}: The code is alpha.`, answer:['alpha'], explanation:'The stated code is alpha.', vocabulary:[{word:'evidence', meaning:'证据', example:'Evidence supports the claim.'}]}))),
  ...[1,2].map(i => ({id:`writing-${i}`, skill:'writing', module:i === 1 ? 'general' : 'both', origin:'original', title:`Writing Task ${i}`, type:`Task ${i}`, topic:'Study', level:'进阶', prompt:i === 1 ? 'Write a letter asking about an evening course.' : 'Discuss the role of education.', minWords:i === 1 ? 150 : 250, explanation:'Develop your ideas.'})),
  ...[1,2,3].map(i => ({id:`speaking-${i}`, skill:'speaking', module:'both', origin:'original', title:`Speaking Part ${i}`, type:`Part ${i}`, topic:'Study', level:'基础', prompt:'Describe your interests.', explanation:'Give specific examples.'}))
];

function boot({store = new Map(), now = new Date(2026,10,16,12).getTime(), hash = '#dashboard', recording = false, reducedMotion = false, mobileReading = false} = {}) {
  let clock = now, serial = 0;
  const events = {}, windowEvents = {}, intervals = new Map(), timeouts = new Map(), nodes = new Map();
  const mainIds = new Set(), answerIds = new Set(), scrollCalls = [];
  const frames = [];
  const unescape = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function replaceIds(markup, ids) {
    for (const id of ids) nodes.delete(id);
    ids.clear();
    for (const [,id] of markup.matchAll(/\bid="([^"]+)"/g)) {
      ids.add(id);
      nodes.set(id, element(id));
    }
    for (const [,id,motion] of markup.matchAll(/id="([^"]+)" data-motion="([^"]+)"/g)) nodes.get(id).dataset.motion=motion;
  }
  function element(id = '') {
    let html = '';
    const classes = new Set();
    const attributes = new Map();
    return {id, value:'', textContent:'', dataset:{}, open:false, style:{}, scrollTop:0,
      classList:{add(name){classes.add(name);},remove(name){classes.delete(name);},contains(name){return classes.has(name);},
        toggle(name,force=!classes.has(name)){if(force)classes.add(name);else classes.delete(name);return force;}},
      getAttribute(name){return attributes.get(name)??null;},
      setAttribute(name,value){attributes.set(name,value);},
      getClientRects(){return mobileReading&&id==='reading-toggle'?[{}]:[];},
      getBoundingClientRect(){return {top:200-sandbox.scrollY};},
      get innerHTML() {return html;},
      set innerHTML(value) {
        html = value;
        if (id === 'main') {
          replaceIds('', answerIds);
          const answerPane = value.match(/<section id="session-answer" class="answer-pane">([\s\S]*?)<\/section>/);
          replaceIds(answerPane ? value.replace(answerPane[1], '') : value, mainIds);
          if (answerPane) nodes.get('session-answer').innerHTML = answerPane[1];
          const numbers = value.match(/<div id="session-questions"[^>]*>([\s\S]*?)<\/div>/);
          if (numbers) nodes.get('session-questions').innerHTML = numbers[1];
          const recordingResult = value.match(/<div\b[^>]*\bid="record-result"[^>]*>([\s\S]*?)<\/div>/);
          if (recordingResult) nodes.get('record-result').innerHTML = recordingResult[1];
        }
        if (id === 'session-answer') {
          replaceIds(value, answerIds);
          const input = value.match(/<input\b[^>]*\bid="answer"[^>]*\bvalue="([^"]*)"/);
          const textarea = value.match(/<textarea\b[^>]*\bid="answer"[^>]*>([\s\S]*?)<\/textarea>/);
          if (nodes.has('answer')) nodes.get('answer').value = unescape(input?.[1] ?? textarea?.[1] ?? '');
        }
      },
      showModal(){this.open = true;}, close(){this.open = false;}, focus(){}, setSelectionRange(){}, scrollIntoView(){}, click(){}, remove(){}
    };
  }
  for (const id of ['main','app-splash','toast','confirm-title','confirm-message','confirm-dialog','module-label','date-label','review-badge','page-label']) nodes.set(id, element(id));
  const document = {
    querySelector(selector) {return selector.startsWith('#') ? nodes.get(selector.slice(1)) || null : null;},
    querySelectorAll(selector){
      if (selector.includes('#session-answer input') && nodes.has('answer')) return [nodes.get('answer')];
      return [];
    },
    addEventListener(name, fn){(events[name] ||= []).push(fn);},
    createElement(){return element();},
    body:{append(){}}
  };
  class ClockDate extends Date {
    constructor(...args) {super(...(args.length ? args : [clock]));}
    static now(){return clock;}
  }
  const sandbox = {document, console, Date:ClockDate, navigator:{}, location:{hash, protocol:'https:'},
    localStorage:{getItem:key=>store.get(key) ?? null, setItem:(key,value)=>store.set(key,value), removeItem:key=>store.delete(key)},
    setInterval(fn, delay){const id=++serial;intervals.set(id,{fn,delay});return id;},
    clearInterval(id){intervals.delete(id);},
    setTimeout(fn, delay){const id=++serial;timeouts.set(id,{fn,delay});return id;},
    clearTimeout(id){timeouts.delete(id);},
    requestAnimationFrame(fn){frames.push(fn);return ++serial;},
    addEventListener(name, fn){(windowEvents[name] ||= []).push(fn);},
    scrollY:0,
    scrollTo(options){this.scrollY=options.top;scrollCalls.push(options.behavior);},
    matchMedia(query){return {matches:query === '(prefers-reduced-motion: reduce)' && reducedMotion};},
    speechSynthesis:{speaking:false,utterance:null,cancel(){this.speaking=false;},speak(utterance){this.speaking=true;this.utterance=utterance;},getVoices(){return [];}},
    SpeechSynthesisUtterance: class {constructor(text){this.text=text;}},
    URL:{createObjectURL(){return 'blob:test';}, revokeObjectURL(){}}, Blob,
    history:{replaceState(_a,_b,url){sandbox.location.hash=url;}},
  };
  sandbox.window = sandbox;
  if (recording) {
    const stream = {getTracks:()=>[{stop(){}}]};
    sandbox.navigator.mediaDevices = {getUserMedia:async()=>stream};
    sandbox.MediaRecorder = class {
      constructor(_stream, options={}){this.state='inactive';this.mimeType=options.mimeType || 'audio/webm';}
      static isTypeSupported(){return true;}
      start(){this.state='recording';}
      stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'],{type:this.mimeType})});queueMicrotask(()=>this.onstop?.());}
    };
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(`window.IELTS_QUESTIONS=${JSON.stringify(fixtures)};window.IELTS_SOURCES=[];`, context);
  for (const file of ['core.js','app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'), context, {filename:file});
  const dispatch = (name,event) => {for (const handler of events[name] || []) handler(event);};
  return {
    store, nodes, context, scrollCalls,
    get html(){return nodes.get('main').innerHTML;},
    get state(){return JSON.parse(store.get(KEY) || '{}');},
    get session(){return JSON.parse(store.get(SESSION) || 'null');},
    get now(){return clock;},
    get speaking(){return sandbox.speechSynthesis.speaking;},
    click(action, extra={}){const target={dataset:{action,...extra},closest(){return this;}};dispatch('click',{target});},
    clickRouteLink(hash){
      let prevented=false;
      const target={closest:selector=>selector==='a[href^="#"]'?{hash}:null};
      dispatch('click',{target,button:0,preventDefault(){prevented=true;}});
      return prevented;
    },
    input(value){const target=nodes.get('answer');assert.ok(target, 'an answer input is rendered');target.value=value;dispatch('input',{target});},
    change(target){dispatch('change',{target});},
    frame(){for(const callback of frames.splice(0))callback();},
    route(hash){sandbox.location.hash=hash;for(const fn of windowEvents.hashchange || [])fn();},
    tick(milliseconds){clock+=milliseconds;for(const {fn,delay} of [...intervals.values()])if(delay===500||delay===1000)fn();},
    async importBackup(backup){dispatch('change',{target:{id:'import-backup',value:'backup.json',files:[{size:JSON.stringify(backup).length,text:async()=>JSON.stringify(backup)}]}});await new Promise(resolve=>setImmediate(resolve));},
  };
}

function displayedQuestionIndexes(app) {
  return Array.from(app.nodes.get('session-questions').innerHTML.matchAll(/data-index="(\d+)"/g), match => Number(match[1]));
}

test('practice records one attempt, preserves answers across reload, and clears only finished session', () => {
  const first=boot(); first.click('question',{id:'reading-0'}); first.input('ALPHA'); first.click('submit-answer');
  assert.match(first.html,/data-motion="focus"/);
  assert.doesNotMatch(first.html,/toggle-question-mark|question-filter/);
  assert.equal(first.state.progress['reading-0'].attempts,1);
  assert.equal(first.state.progress['reading-0'].lastCorrect,true);
  first.click('exit-session');
  const reloaded=boot({store:first.store,now:first.now+60000}); reloaded.click('resume');
  assert.equal(reloaded.nodes.get('answer').value,'ALPHA');
  assert.match(reloaded.html,/回答正确/);
  reloaded.click('next-question');
  assert.equal(reloaded.session,null);
  assert.match(reloaded.html,/data-motion="complete"/);
  assert.match(reloaded.html,/class="atelier-tile"[\s\S]*?class="atelier-dot"[\s\S]*?class="atelier-check"/);
  assert.equal(reloaded.state.progress['reading-0'].attempts,1);
  assert.equal(reloaded.state.history.length,1);
});

test('the startup mark dismisses after the first paint, immediately with reduced motion', () => {
  const app=boot();
  const splash=app.nodes.get('app-splash');
  assert.match(app.html,/YOUR DAILY PRACTICE/);
  assert.equal(splash.classList.contains('is-ready'),false);
  app.frame();
  assert.equal(splash.classList.contains('is-ready'),false);
  app.frame();
  assert.equal(splash.classList.contains('is-ready'),true);
  assert.equal(splash.getAttribute('aria-hidden'),'true');
  const reducedSplash=boot({reducedMotion:true}).nodes.get('app-splash');
  assert.equal(reducedSplash.classList.contains('is-ready'),true);
  assert.equal(reducedSplash.hidden,true);
});

test('dashboard resumes a saved quick practice at the last question with its draft', () => {
  const first=boot({hash:'#practice/reading'});
  first.click('quick');
  first.click('jump-question',{index:'1'});
  first.input('my unfinished answer');
  first.click('exit-session');

  const restored=boot({store:first.store});
  assert.match(restored.html,/分类速刷 · 阅读/);
  assert.match(restored.html,/第 2 \/ 40 题/);
  assert.match(restored.html,/data-action="resume"[^>]*>继续练习/);
  assert.doesNotMatch(restored.html,/id="resume-time"/);
  restored.click('resume');
  assert.equal(restored.session.index,1);
  assert.equal(restored.session.startedAt,first.session.startedAt);
  assert.equal(restored.nodes.get('answer').value,'my unfinished answer');
  assert.doesNotMatch(restored.html,/class="panel resume-card"/);
  assert.equal(restored.clickRouteLink('#dashboard'),true);
  assert.match(restored.html,/class="panel resume-card"/);
  assert.equal(restored.session.answers['reading-1'],'my unfinished answer');
});

test('dashboard countdown and resumed mock use the original stage deadline', () => {
  const first=boot({hash:'#mock'});
  first.click('single-mock',{skill:'reading'});
  const deadline=first.session.deadline;
  first.click('exit-session');

  const restored=boot({store:first.store,now:first.now+60000});
  assert.match(restored.html,/仿真训练 · 阅读/);
  assert.match(restored.html,/剩余 59:00/);
  restored.tick(5000);
  assert.equal(restored.nodes.get('resume-time').textContent,'剩余 58:55');
  restored.click('resume');
  assert.equal(restored.session.deadline,deadline);
  restored.tick(500);
  assert.equal(restored.nodes.get('timer').textContent,'58:55');
});

test('objective duplicate submission does not inflate practice statistics', () => {
  const app=boot();app.click('question',{id:'reading-0'});app.input('alpha');
  app.click('submit-answer');app.click('submit-answer');
  assert.equal(app.state.progress['reading-0'].attempts,1);
});

test('same-passage reading questions reuse the scrolled passage and refresh the prompt', () => {
  const app=boot();
  app.click('single-mock',{skill:'reading'});
  const passage=app.nodes.get('session-passage');
  const timer=app.nodes.get('timer');
  passage.scrollTop=240;
  app.click('next-question');
  assert.equal(app.nodes.get('session-passage'),passage);
  assert.equal(passage.scrollTop,240);
  assert.equal(app.nodes.get('timer'),timer);
  assert.match(app.nodes.get('session-answer').innerHTML,/Write the code for question 2/);
  assert.match(app.nodes.get('session-details').innerHTML,/第 2 \/ 40 题/);
  app.click('jump-question',{index:'10'});
  assert.notEqual(app.nodes.get('session-passage'),passage);
  assert.equal(app.nodes.get('session-passage').scrollTop,0);
  assert.match(app.html,/Material 2/);
});

test('the mobile reading switch restores independent document positions and retains the answer', () => {
  const app=boot({mobileReading:true});
  app.click('single-mock',{skill:'reading'});
  const toggle=app.nodes.get('reading-toggle');
  const answer=app.nodes.get('answer');
  app.input('in-progress answer');
  app.context.scrollY=385;
  app.click('toggle-reading-pane');
  assert.equal(toggle.textContent,'回到题目');
  assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(app.nodes.get('session-training').classList.contains('show-reading-material'),true);
  assert.equal(app.context.scrollY,188);

  app.context.scrollY=960;
  app.click('toggle-reading-pane');
  assert.equal(toggle.textContent,'看原文');
  assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(app.nodes.get('session-training').classList.contains('show-reading-material'),false);
  assert.equal(app.context.scrollY,385);
  assert.equal(app.nodes.get('answer'),answer);
  assert.equal(answer.value,'in-progress answer');
  app.click('toggle-reading-pane');
  assert.equal(app.context.scrollY,960);
});

test('mobile same-passage jumps return to the question and retain the material position', () => {
  const app=boot({mobileReading:true});
  app.click('single-mock',{skill:'reading'});
  app.click('toggle-reading-pane');
  app.context.scrollY=960;
  app.click('jump-question',{index:'1'});
  assert.equal(app.nodes.get('reading-toggle').textContent,'看原文');
  assert.match(app.nodes.get('session-answer').innerHTML,/Write the code for question 2/);
  app.click('toggle-reading-pane');
  assert.equal(app.context.scrollY,960);

  app.click('jump-question',{index:'10'});
  app.click('toggle-reading-pane');
  assert.equal(app.context.scrollY,188);
  assert.match(app.html,/Material 2/);
});

test('the reading switch is inactive on desktop and absent without a separate reading passage', () => {
  const desktop=boot();
  desktop.click('question',{id:'reading-0'});
  desktop.click('toggle-reading-pane');
  assert.equal(desktop.nodes.get('session-training').classList.contains('show-reading-material'),false);

  const app=boot({mobileReading:true});
  app.click('question',{id:'reading-39'});
  assert.doesNotMatch(app.html,/id="reading-toggle"/);
  const listening=boot({mobileReading:true});
  listening.click('question',{id:'listening-0'});
  assert.doesNotMatch(listening.html,/id="reading-toggle"/);
});

test('submitting a reading answer reveals feedback in place and disables the retained answer input', () => {
  const app=boot();
  app.click('question',{id:'reading-0'});
  const passage=app.nodes.get('session-passage');
  const answer=app.nodes.get('answer');
  passage.scrollTop=120;
  app.input('alpha');
  app.click('submit-answer');
  assert.equal(app.nodes.get('session-passage'),passage);
  assert.equal(passage.scrollTop,120);
  assert.equal(app.nodes.get('answer'),answer);
  assert.equal(answer.disabled,true);
  assert.match(app.nodes.get('feedback').innerHTML,/回答正确/);
  assert.equal(app.nodes.get('feedback').classList.contains('feedback-enter'),true);
});

test('page fade is only attached when a different top-level section renders', () => {
  const app=boot();
  assert.doesNotMatch(app.html,/class="page-enter"/);
  app.route('#practice');
  assert.match(app.html,/class="page-enter"/);
  app.change({id:'type-filter',value:'填空'});
  assert.doesNotMatch(app.html,/class="page-enter"/);
  app.route('#practice/reading');
  assert.doesNotMatch(app.html,/class="page-enter"/);
  app.route('#review');
  assert.match(app.html,/class="page-enter"/);
});

test('training start and a different passage honor reduced motion when scrolling to the top', () => {
  const app=boot({reducedMotion:true});
  app.click('single-mock',{skill:'reading'});
  app.click('next-question');
  app.click('jump-question',{index:'10'});
  assert.deepEqual(app.scrollCalls,['auto','auto']);
});

test('subjective work saves its draft but enters learning history only once after self assessment', () => {
  const app=boot();app.click('question',{id:'writing-1'});app.input('An original draft with a clear overview.');
  app.click('submit-answer');
  assert.equal(app.state.progress?.['writing-1'],undefined);
  app.click('self-rate',{correct:'false'});app.click('self-rate',{correct:'true'});
  assert.equal(app.state.progress['writing-1'].attempts,1);
  assert.equal(app.state.progress['writing-1'].lastCorrect,false);
  assert.equal(app.state.history[0].answered,1);
  assert.match(app.store.get('ielts-atelier-drafts-v1'),/clear overview/);
});

test('mock deadline survives reload and expired time is carried into next stage', () => {
  const first=boot();first.click('start-mock');first.input('alpha');
  const originalDeadline=first.session.deadline;
  first.click('exit-session');
  const restored=boot({store:first.store,now:originalDeadline+300000});restored.click('resume');restored.tick(1);
  assert.equal(restored.session.stageIndex,1);
  assert.equal(restored.session.answers['listening-0'],'alpha');
  assert.equal(restored.session.deadline,originalDeadline+3600000);
  assert.match(restored.html,/Reading/);
});

test('automatic expiry invalidates a pending stage-confirmation callback', () => {
  const app=boot();app.click('start-mock');app.click('advance-stage');
  assert.equal(app.nodes.get('confirm-dialog').open,true);
  app.tick(1800001);
  assert.equal(app.session.stageIndex,1);
  app.click('dialog-ok');
  assert.equal(app.session.stageIndex,1);
});

test('mock submission saves final typed answer and grades omitted objective answers as wrong', () => {
  const app=boot();app.click('single-mock',{skill:'listening'});app.click('jump-question',{index:'39'});app.input('alpha');
  app.click('advance-stage');app.click('dialog-ok');
  assert.equal(app.session,null);
  assert.equal(Object.keys(app.state.progress).length,40);
  assert.equal(app.state.progress['listening-39'].lastCorrect,true);
  assert.equal(app.state.progress['listening-0'].lastCorrect,false);
  assert.equal(app.state.history.filter(h=>h.correct).length,1);
  assert.equal(app.state.history.reduce((total,item)=>total+item.answered,0),1);
  assert.match(app.html,/未作答的客观题计为错误/);
  assert.doesNotMatch(app.html,/重练本场错题/);
  app.route('#dashboard');
  assert.match(app.html,/今日已练[\s\S]*?<div class="stat-value">1<small>\/ 8 题/);
});

test('mock question filters follow answers and marking, and their numbers jump to the original questions', () => {
  const app=boot({hash:'#mock'});
  app.click('single-mock',{skill:'reading'});
  const filterButton=app.nodes.get('question-filter-marked');
  app.click('question-filter',{value:'marked'});
  assert.match(app.nodes.get('session-questions').innerHTML,/暂无已标记的题目/);
  app.click('toggle-question-mark');
  assert.equal(app.nodes.get('question-mark').getAttribute('aria-pressed'),'true');
  assert.equal(app.nodes.get('question-filter-marked'),filterButton);
  assert.deepEqual(displayedQuestionIndexes(app),[0]);
  app.click('question-filter',{value:'all'});
  app.click('jump-question',{index:'3'});
  app.click('toggle-question-mark');
  app.input('alpha');
  app.click('question-filter',{value:'unanswered'});
  assert.equal(displayedQuestionIndexes(app).length,39);
  assert.equal(displayedQuestionIndexes(app).includes(3),false);
  app.input('  ');
  assert.equal(displayedQuestionIndexes(app).includes(3),true);
  app.input('beta');
  assert.equal(displayedQuestionIndexes(app).includes(3),false);
  app.click('question-filter',{value:'marked'});
  assert.deepEqual(displayedQuestionIndexes(app),[0,3]);
  app.click('jump-question',{index:'0'});
  assert.equal(app.session.index,0);
  assert.match(app.nodes.get('session-questions').innerHTML,/q-number answered marked[^>]*data-index="3"/);
  app.click('toggle-question-mark');
  assert.deepEqual(displayedQuestionIndexes(app),[3]);
  app.click('jump-question',{index:'3'});
  assert.equal(app.session.index,3);
  assert.equal(app.nodes.get('answer').value,'beta');
  assert.deepEqual(app.session.marked,{'reading-3':true});
});

test('saved mock sessions restore marks and filter, and older sessions default to all questions', () => {
  const app=boot({hash:'#mock'});
  app.click('single-mock',{skill:'reading'});
  const oldStore=new Map(app.store);
  app.click('jump-question',{index:'1'});
  app.click('toggle-question-mark');
  app.input('alpha');
  app.click('question-filter',{value:'marked'});
  app.click('exit-session');
  const resumed=boot({store:app.store});
  resumed.click('resume');
  assert.equal(resumed.session.index,1);
  assert.equal(resumed.nodes.get('answer').value,'alpha');
  assert.deepEqual(displayedQuestionIndexes(resumed),[1]);
  assert.match(resumed.html,/id="question-filter-marked"[^>]*aria-pressed="true"/);
  assert.match(resumed.nodes.get('session-answer').innerHTML,/id="question-mark" aria-pressed="true"/);

  const legacy=boot({store:oldStore});
  legacy.click('resume');
  assert.equal(displayedQuestionIndexes(legacy).length,40);
  assert.match(legacy.html,/id="question-filter-all"[^>]*aria-pressed="true"/);
  legacy.click('toggle-question-mark');
  assert.deepEqual(legacy.session.marked,{'reading-0':true});
});

test('the stage filter resets when advancing and previous-stage questions cannot be reopened', () => {
  const app=boot({hash:'#mock'});
  app.click('start-mock');
  app.click('toggle-question-mark');
  app.click('question-filter',{value:'marked'});
  app.click('advance-stage');
  assert.match(app.nodes.get('confirm-message').textContent,/有 1 题带有待检查标记/);
  app.click('dialog-ok');
  assert.equal(app.session.stageIndex,1);
  assert.equal(app.session.questionFilter,'all');
  assert.deepEqual(displayedQuestionIndexes(app),Array.from({length:40},(_,i)=>40+i));
  app.click('question-filter',{value:'marked'});
  assert.deepEqual(displayedQuestionIndexes(app),[]);
  app.click('jump-question',{index:'0'});
  assert.equal(app.session.index,40);
});

test('mock results separate wrong and blank by question type and retry only this session’s wrong answers', () => {
  const app=boot();
  app.click('question',{id:'reading-3'});
  app.input('earlier wrong answer');
  app.click('submit-answer');
  app.click('next-question');

  app.click('single-mock',{skill:'listening'});
  app.input('alpha');
  app.click('jump-question',{index:'20'});
  app.input('wrong');
  app.click('jump-question',{index:'21'});
  app.input('   ');
  app.click('advance-stage');
  app.click('dialog-ok');

  assert.match(app.html,/1<small> \/ 40 道客观题答对/);
  assert.match(app.html,/答错 1 题 · 未答 38 题/);
  assert.match(app.html,/听力 · 填空<\/th>\s*<td>1 \/ 20<\/td><td>0<\/td><td>19<\/td>/);
  assert.match(app.html,/听力 · 判断题<\/th>\s*<td>0 \/ 20<\/td><td>1<\/td><td>19<\/td>/);
  const retry=app.html.match(/data-action="retry-wrong" data-ids="([^"]+)"[^>]*>重练本场错题（1）/);
  assert.ok(retry);
  app.click('retry-wrong',{ids:retry[1]});
  assert.deepEqual(app.session.ids,['listening-20']);
  assert.equal(app.session.mode,'review');
});

test('a fully unanswered mock stays out of today’s activity and the study streak', () => {
  const app=boot({hash:'#mock'});
  app.click('single-mock',{skill:'reading'});
  app.click('advance-stage');
  app.click('dialog-ok');
  assert.match(app.html,/答错 0 题 · 未答 40 题/);
  app.route('#dashboard');
  assert.match(app.html,/今日已练[\s\S]*?<div class="stat-value">0<small>\/ 8 题/);
  assert.match(app.html,/连续练习[\s\S]*?<div class="stat-value">0<small>天/);
});

test('starting another exercise keeps pending work until explicit replacement confirmation', () => {
  const app=boot();app.click('question',{id:'reading-0'});app.input('unfinished');app.click('exit-session');
  app.click('question',{id:'reading-1'});
  assert.equal(app.nodes.get('confirm-dialog').open,true);
  assert.deepEqual(app.session.ids,['reading-0']);
  app.click('dialog-cancel');
  assert.equal(app.session.answers['reading-0'],'unfinished');
  app.click('question',{id:'reading-1'});app.click('dialog-ok');
  assert.deepEqual(app.session.ids,['reading-1']);
});

test('backup import restores vocabulary reviews and progress after confirmation', async () => {
  const original=boot();original.click('question',{id:'reading-0'});original.input('wrong');original.click('submit-answer');original.click('next-question');
  original.click('vocab-save',{word:'evidence'});original.click('vocab-rate',{word:'evidence',correct:'true'});
  const backup=original.state;
  const restored=boot();await restored.importBackup(backup);
  assert.equal(restored.nodes.get('confirm-dialog').open,true);
  assert.equal(restored.state.progress,undefined);
  restored.click('dialog-ok');
  assert.equal(restored.state.progress['reading-0'].attempts,1);
  assert.equal(restored.state.vocabulary.evidence.saved,true);
  assert.equal(restored.state.vocabulary.evidence.intervalDays,1);
  assert.equal(restored.state.vocabulary.evidence.dueAt,backup.vocabulary.evidence.dueAt);
});

test('unknown or inherited hash routes fall back to the dashboard', () => {
  const app=boot({hash:'#toString'});
  assert.match(app.html,/YOUR DAILY PRACTICE/);
  app.route('#practice/constructor');
  assert.match(app.html,/QUESTION LIBRARY/);
  assert.match(app.html,/85 道题/);
});

test('listening narration continues across questions in one group and stops on another group', () => {
  const app=boot();app.click('single-mock',{skill:'listening'});app.click('play-audio');
  assert.equal(app.speaking,true);
  const mark=app.nodes.get('audio-motion');
  const narration=app.context.speechSynthesis.utterance;
  assert.equal(mark.dataset.motion,'loading');
  narration.onstart();
  assert.equal(mark.dataset.motion,'listening');
  app.click('next-question');
  assert.equal(app.session.index,1);
  assert.equal(app.speaking,true);
  assert.equal(app.nodes.get('audio-motion'),mark);
  assert.equal(mark.dataset.motion,'listening');
  app.click('jump-question',{index:'10'});
  assert.equal(app.speaking,false);
  narration.onstart();narration.onend();
  assert.equal(app.speaking,false);
  assert.equal(app.nodes.get('audio-motion').dataset.motion,'idle');
});

test('the listening mark returns to idle on completion, stop and playback error', () => {
  const app=boot();app.click('question',{id:'listening-0'});
  const mark=app.nodes.get('audio-motion');
  const voice=app.context.speechSynthesis;
  app.click('play-audio');voice.utterance.onstart();voice.utterance.onend();
  assert.equal(mark.dataset.motion,'idle');
  assert.match(app.nodes.get('audio-status').textContent,/播放完成/);
  app.click('play-audio');const canceled=voice.utterance;app.click('stop-audio');canceled.onstart();
  assert.equal(mark.dataset.motion,'idle');
  assert.match(app.nodes.get('audio-status').textContent,/已停止/);
  app.click('play-audio');voice.utterance.onerror({error:'audio-hardware'});
  assert.equal(mark.dataset.motion,'idle');
  assert.match(app.nodes.get('audio-status').textContent,/语音暂不可用/);
});

test('sentence practice replays one sentence and retains its position and transcript preference within a passage', () => {
  const app=boot({hash:'#practice/listening'});
  app.click('quick');
  app.click('jump-question',{index:'10'});
  assert.match(app.html,/第 1 \/ 3 句/);
  assert.match(app.html,/id="sentence-source"[^>]*hidden/);
  app.nodes.get('speech-rate').value='0.85';
  app.click('sentence-text');
  assert.equal(app.nodes.get('sentence-source').textContent,'The office opens today.');

  const voice=app.context.speechSynthesis;
  app.click('sentence-replay');
  const first=voice.utterance;
  assert.equal(first.text,'The office opens today.');
  assert.equal(first.rate,0.85);
  first.onend();
  assert.equal(voice.utterance,first);
  assert.match(app.nodes.get('audio-status').textContent,/播放完成/);
  app.click('sentence-replay');
  assert.equal(voice.utterance.text,first.text);

  app.click('sentence-next');
  assert.equal(voice.utterance.text,'Bring your blue badge.');
  app.click('jump-question',{index:'11'});
  assert.equal(app.nodes.get('sentence-position').textContent,'第 2 / 3 句');
  assert.equal(app.nodes.get('sentence-source').textContent,voice.utterance.text);
  app.click('sentence-text');
  assert.equal(app.nodes.get('sentence-source').hidden,true);
  assert.equal(app.nodes.get('sentence-source').textContent,'');
  app.click('sentence-next');
  assert.equal(app.nodes.get('sentence-next').textContent,'从第一句开始');
  app.click('sentence-next');
  assert.equal(voice.utterance.text,'The office opens today.');
  app.click('jump-question',{index:'20'});
  assert.equal(app.speaking,false);
  assert.match(app.html,/第 1 \/ 2 句/);
});

test('submitted listening mocks unlock one sentence player per material selection and stop playback when leaving', () => {
  const app=boot({hash:'#mock'});
  app.click('single-mock',{skill:'listening'});
  assert.doesNotMatch(app.html,/sentence-player-title|review-listening-material/);
  app.click('sentence-replay');
  assert.equal(app.speaking,false);
  app.click('advance-stage');
  app.click('dialog-ok');

  const select=app.html.match(/<select id="review-listening-material">([\s\S]*?)<\/select>/);
  assert.equal([...select[1].matchAll(/<option /g)].length,4);
  assert.match(app.html,/第 1 \/ 1 句/);
  assert.match(app.html,/id="sentence-next" disabled/);
  app.click('sentence-text');
  app.click('sentence-replay');
  assert.equal(app.context.speechSynthesis.utterance.text,'The code is alpha.');
  app.change({id:'review-listening-material',value:'listening-10'});
  assert.equal(app.speaking,false);
  assert.equal(app.nodes.get('sentence-next').disabled,false);
  assert.equal(app.nodes.get('sentence-source').hidden,true);
  assert.equal(app.nodes.get('sentence-position').textContent,'第 1 / 3 句');
  app.click('sentence-next');
  assert.equal(app.context.speechSynthesis.utterance.text,'Bring your blue badge.');
  app.route('#review');
  assert.equal(app.speaking,false);
  assert.doesNotMatch(app.html,/sentence-player-title/);
});

test('recording playback and download remain available after opening feedback for the same question', async () => {
  const app=boot({recording:true});app.click('question',{id:'speaking-1'});
  const mark=app.nodes.get('record-motion');
  app.click('prepare-speaking');
  assert.equal(mark.dataset.motion,'focus');
  app.click('record-start');
  assert.equal(mark.dataset.motion,'loading');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(mark.dataset.motion,'speaking');
  app.tick(1000);
  assert.match(app.nodes.get('record-status').textContent,/正在录音/);
  app.click('record-stop');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(mark.dataset.motion,'idle');
  assert.match(app.nodes.get('record-result').innerHTML,/<audio/);
  app.click('submit-answer');
  assert.match(app.nodes.get('record-result').innerHTML,/<audio/);
  assert.match(app.nodes.get('record-result').innerHTML,/download=/);
});

test('a microphone request that resolves after leaving the question releases its stream', async () => {
  const app=boot({recording:true});app.click('question',{id:'speaking-1'});
  let grant, stopped=0;
  app.context.navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{grant=resolve;});
  app.click('record-start');
  assert.equal(app.nodes.get('record-motion').dataset.motion,'loading');
  app.route('#mock');app.click('resume');
  grant({getTracks:()=>[{stop(){stopped++;}}]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stopped,1);
  assert.equal(app.nodes.get('record-motion').dataset.motion,'idle');
});
