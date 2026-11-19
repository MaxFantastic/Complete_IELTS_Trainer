/* IELTS Atelier — dependency-free, local-first study workspace. */
(() => {
  'use strict';
  const C = window.IELTSCore;
  const BASE = window.IELTS_QUESTIONS || [];
  const SOURCES = window.IELTS_SOURCES || [];
  const KEY = 'ielts-atelier-v1', CUSTOM = 'ielts-atelier-bank-v1', DRAFT = 'ielts-atelier-drafts-v1', SESSION = 'ielts-atelier-session-v1';
  const SKILLS = {listening:{name:'听力',en:'Listening',symbol:'♬'},speaking:{name:'口语',en:'Speaking',symbol:'☏'},reading:{name:'阅读',en:'Reading',symbol:'▤'},writing:{name:'写作',en:'Writing',symbol:'✎'}};
  const PAGES = {dashboard:'学习概览',practice:'分类题库',mock:'仿真训练',review:'错题与复习',vocabulary:'重点词汇',sources:'近五年真题索引',settings:'学习设置'};
  const QUESTION_FILTERS = {all:'全部',unanswered:'未答',marked:'已标记'};
  const RECORD_IDLE = '需要麦克风权限。录音仅保留于本次页面，可回放并下载。';
  const defaults = {version:1,progress:{},vocabulary:{},settings:{module:'general',targetBand:7,dailyGoal:8,reminderTime:'20:00',remindersEnabled:true},history:[]};
  let storageError = false;
  function read(key,fallback){try{return JSON.parse(localStorage.getItem(key)) || fallback;}catch{return fallback;}}
  function write(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{storageError=true;toast('当前浏览器无法保存数据，请导出备份后再离开。');return false;}}
  let state=read(KEY,defaults); state={...defaults,...state,settings:{...defaults.settings,...state.settings}};
  let custom=read(CUSTOM,[]), questions=[...BASE,...custom], drafts=read(DRAFT,{});
  let renderedRoute=null;
  let readingOffsets={material:null,answer:null};
  let playback=null;
  let sentenceStudy=null;
  let session=null,timer=null,recorder=null,recordStream=null,recordURL=null,recordMime='audio/webm',recordPending=null,confirmCallback=null;
  let filter={skill:'all',type:'all',search:'',origin:'all'},sourceFilter={year:'all',skill:'all'},vocabFilter='all';
  const $=(s)=>document.querySelector(s), esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const attr=esc, isObjective=q=>Array.isArray(q.answer)&&q.answer.length>0;
  const bank=()=>questions.filter(q=>q.module==='both'||q.module===state.settings.module);
  const currentQ=()=>session&&questions.find(q=>q.id===session.ids[session.index]);
  const formatTime=s=>`${String(Math.floor(Math.max(0,s)/60)).padStart(2,'0')}:${String(Math.max(0,s)%60).padStart(2,'0')}`;
  const wordCount=s=>(String(s).trim().match(/\b[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*\b/g)||[]).length;
  function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toast.timeout);toast.timeout=setTimeout(()=>$('#toast').classList.remove('show'),4000);}
  function save(){state.history=state.history.slice(-3000);write(KEY,state);updateChrome();}
  function ask(title,message,callback){$('#confirm-title').textContent=title;$('#confirm-message').textContent=message;confirmCallback=callback;$('#confirm-dialog').showModal();}
  function heading(k,title,description,action=''){return `<div class="page-heading"><div><div class="eyebrow">${k}</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;}
  function button(text,action,extra='',cls=''){return `<button class="btn ${cls}" data-action="${action}" ${extra}>${text}</button>`;}
  function empty(title,description){return `<div class="empty"><h2>${title}</h2><p>${description}</p></div>`;}

  function motionMark(state,id=''){
    return `<span class="atelier-mark"${id?` id="${id}"`:''} data-motion="${state}" aria-hidden="true">
      <span class="atelier-tile"><span class="atelier-dot"></span><span class="atelier-bars"></span><span class="atelier-check"></span></span>
    </span>`;
  }

  function setMediaStatus(kind,state,message){
    const mark=$(`#${kind}-motion`);
    const status=$(`#${kind}-status`);
    if(mark)mark.dataset.motion=state;
    if(status)status.textContent=message;
  }

  function dismissSplash(){
    const splash=$('#app-splash');
    if(!splash)return;
    const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const ready=()=>{
      splash.classList.add('is-ready');
      splash.setAttribute('aria-hidden','true');
      if(reduced)splash.hidden=true;
      else setTimeout(()=>{splash.hidden=true;},340);
    };
    if(reduced)ready();
    else window.requestAnimationFrame(()=>window.requestAnimationFrame(ready));
  }
  function updateChrome(){const label=state.settings.module==='general'?'General Training':'Academic';$('#module-label').textContent=label;$('#date-label').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'short'});$('#review-badge').textContent=Object.values(state.progress).filter(p=>p.lastCorrect===false).length;}
  function todayRecords(){return state.history.filter(h=>h.date===C.localDateKey());}
  function streak(){let n=0,d=new Date(),dates=new Set(state.history.filter(h=>h.answered>0).map(h=>h.date));if(!dates.has(C.localDateKey(d)))d.setDate(d.getDate()-1);while(dates.has(C.localDateKey(d))){n++;d.setDate(d.getDate()-1);}return n;}

  function resumableSession(){
    const saved=read(SESSION,null);
    if(!Array.isArray(saved?.ids)||!Number.isInteger(saved.index)||!saved.ids[saved.index])return null;
    const available=new Set(questions.map(q=>q.id));
    return saved.ids.every(id=>available.has(id))?saved:null;
  }

  function resumeTime(deadline){
    const seconds=Math.ceil((deadline-Date.now())/1000);
    return seconds>0?`剩余 ${formatTime(seconds)}`:'当前科目时间已到';
  }

  function resumeCard(saved){
    if(!saved)return '';
    const question=questions.find(q=>q.id===saved.ids[saved.index]);
    const modes={mock:'仿真训练',daily:'每日小练',quick:'分类速刷',review:'复习练习',practice:'自由练习'};
    const mode=Object.hasOwn(modes,saved.mode)?modes[saved.mode]:'练习';
    return `<section class="panel resume-card">
      <div><h2>${mode} · ${SKILLS[question.skill].name}</h2>
        <p class="muted">第 ${saved.index+1} / ${saved.ids.length} 题${saved.deadline?` · <span id="resume-time">${resumeTime(saved.deadline)}</span>`:''}</p>
      </div>${button('继续练习 →','resume')}
    </section>`;
  }

  function dashboard(saved){
    const qs=bank(),summary=C.summarize(state.progress,qs),rec=C.recommend(qs,state.progress),today=todayRecords().reduce((s,h)=>s+h.answered,0),wrong=qs.filter(q=>state.progress[q.id]?.lastCorrect===false).length;
    const daily=C.selectDaily(qs,state.progress,C.localDateKey(),Number(state.settings.dailyGoal));
    const card=Object.entries(SKILLS).map(([key,s])=>{const all=qs.filter(q=>q.skill===key),done=all.filter(q=>state.progress[q.id]).length;return `<a class="skill-card ${key}" href="#practice/${key}"><span class="skill-symbol">${s.symbol}</span><div class="english">${s.en} <span class="row-arrow" style="float:right">↗</span></div><div class="chinese">${s.name}专项 · ${key==='writing'?'构建清晰表达':key==='speaking'?'让表达自然发生':key==='reading'?'读懂信息与逻辑':'捕捉每个关键信息'}</div><div class="progress-track"><span style="width:${all.length?done/all.length*100:0}%"></span></div><div class="skill-meta"><span>${all.length} 道可练题</span><span>已练 ${done}</span></div></a>`;}).join('');
    const days=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-6+i);const key=C.localDateKey(d);return {key,label:i===6?'今天':d.toLocaleDateString('zh-CN',{weekday:'short'}),n:state.history.filter(h=>h.date===key).reduce((s,h)=>s+h.answered,0)};});const max=Math.max(8,...days.map(d=>d.n));
    return heading('A LITTLE EVERY DAY','每一天，离目标更近一点。',`四项能力，一起进步。今天也为自己的 ${esc(state.settings.targetBand)} 分目标留一点时间。`,button('每日小练 ↗','daily'))+resumeCard(saved)+
      `<section class="hero"><div class="hero-copy"><div class="eyebrow">YOUR DAILY PRACTICE</div><h2>把大目标，<br>拆成今天的小进步。</h2><p>为你安排 ${daily.length} 道练习，兼顾听说读写与待复习内容。</p><div class="actions">${button('开始今日训练 <span>→</span>','daily','','light')}<span class="subtle">${state.settings.module==='academic'?'Academic':'General Training'} · 自适应选题</span></div></div><div class="hero-art" aria-hidden="true"><div class="orbit"></div><span class="orbit-text">a little<br>better.</span><span class="floating-label one">✓ ONE STEP AT A TIME</span><span class="floating-label two">每天一点，未来可期 ↗</span><span class="art-star">✳</span></div></section>
      <div class="stats"><div class="stat"><div class="stat-label">今日已练 <span>↗</span></div><div class="stat-value">${today}<small>/ ${state.settings.dailyGoal} 题</small></div><div class="stat-note">${today>=state.settings.dailyGoal?'今日目标已达成':'慢慢来，保持节奏'}</div></div><div class="stat"><div class="stat-label">连续练习 <span>☀</span></div><div class="stat-value">${streak()}<small>天</small></div><div class="stat-note">每一次开始都算数</div></div><div class="stat"><div class="stat-label">客观题正确率 <span>◎</span></div><div class="stat-value">${objectiveStats().accuracy}<small>%</small></div><div class="stat-note">依据听力与阅读作答记录</div></div><div class="stat"><div class="stat-label">等待复习 <span>↺</span></div><div class="stat-value">${rec.dueIds.length}<small>题</small></div><div class="stat-note">错题本现有 ${wrong} 题</div></div></div>
      <section><div class="section-title"><h2>四项能力，专注练习</h2><a href="#practice">查看全部题库 ↗</a></div><div class="skill-grid">${card}</div></section>
      <div class="dashboard-bottom"><section class="panel"><div class="section-title"><h2>这一周的积累</h2><span class="muted" style="font-size:10px">最近 7 天 · 已练题数</span></div><div class="week-chart">${days.map((d,i)=>`<div class="day-column ${i===6?'today':''}"><span>${d.n}</span><div class="bar-wrap"><div class="bar" style="height:${Math.max(3,d.n/max*100)}%" title="${d.key}: ${d.n} 题"></div></div><span>${d.label}</span></div>`).join('')}</div><div class="week-caption"><span>累计练习 ${summary.answered} / ${summary.total} 道题</span><span>进步有迹可循 ↗</span></div></section><section class="panel"><div class="section-title"><h2>你的下一步</h2><span class="tag">SMART REVIEW</span></div><div class="review-box"><h3>${rec.dueIds.length?'复习，让知识记得更牢':'先完成一次四科小练'}</h3><p>${rec.dueIds.length?`有 ${rec.dueIds.length} 道题到期，优先巩固薄弱点。`: '系统将根据作答表现与间隔时间，为你安排下一次练习。'}${summary.attempts?` 当前建议关注${SKILLS[rec.weakestSkill]?.name||'四项能力'}。`:''}</p></div><div class="actions">${button('打开复习清单 →','review-now','','ghost')}<a href="#settings" class="muted" style="font-size:10px;margin-left:auto">设置训练提醒</a></div></section></div>
      <p class="source-footer">近五年资料范围：2022—2026 年出版索引。站内题目为原创仿真或个人导入；官方题目见来源页。</p>`;
  }
  function objectiveStats(){return C.summarize(state.progress,questions.filter(isObjective));}
  function questionRow(q,i){const s=SKILLS[q.skill],p=state.progress[q.id];return `<article class="question-row"><div class="skill-symbol">${s.symbol}</div><div class="row-copy"><h3>${esc(q.title)}</h3><p class="question-preview">${esc(q.prompt.slice(0,115))}${q.prompt.length>115?"…":""}</p><div class="row-meta"><span class="tag">${s.name} · ${esc(q.type)}</span><span>${esc(q.topic)}</span><span>${q.origin==='original'?'原创仿真':'个人导入'}</span>${p?`<span>${p.lastCorrect?'✓ 已掌握':'↺ 待巩固'}</span>`:''}</div></div>${button('练习 ↗','question',`data-id="${attr(q.id)}"`,'secondary')}</article>`;}
  function practice(){const qs=bank();const selected=qs.filter(q=>(filter.skill==='all'||q.skill===filter.skill)&&(filter.type==='all'||q.type===filter.type)&&(filter.origin==='all'||q.origin===filter.origin)&&(!filter.search||`${q.title} ${q.topic} ${q.prompt} ${q.type}`.toLowerCase().includes(filter.search.toLowerCase())));const types=[...new Set(qs.filter(q=>filter.skill==='all'||q.skill===filter.skill).map(q=>q.type))];
    return heading('QUESTION LIBRARY','找到你的练习节奏。','按技能、题型和主题筛选，逐题速刷或连续练习。',button('速刷当前分类 →','quick'))+
      `<div class="tabs" role="group" aria-label="技能筛选">${[['all','全部技能'],...Object.entries(SKILLS).map(([k,v])=>[k,v.name])].map(([k,n])=>`<button class="tab ${filter.skill===k?'active':''}" data-action="skill-filter" data-value="${k}">${n}</button>`).join('')}</div><div class="filters"><input id="question-search" aria-label="搜索题目" placeholder="搜索主题、题型或关键词…" value="${attr(filter.search)}"><select id="type-filter" aria-label="题型"><option value="all">全部题型</option>${types.map(t=>`<option ${t===filter.type?'selected':''}>${esc(t)}</option>`).join('')}</select><select id="origin-filter" aria-label="题目来源"><option value="all">全部站内来源</option><option value="original" ${filter.origin==='original'?'selected':''}>原创仿真</option><option value="imported" ${filter.origin==='imported'?'selected':''}>个人导入</option></select></div><div class="section-title"><span class="muted">${selected.length} 道题 · ${state.settings.module==='academic'?'学术类':'培训类'}</span><a href="#sources">2022—2026 真题索引 ↗</a></div><div class="question-list">${selected.length?selected.map(questionRow).join(''):empty('没有找到匹配题目','试试其他题型，或在设置中导入你有权使用的题库。')}</div>`;}
  function filtered(){return bank().filter(q=>(filter.skill==='all'||q.skill===filter.skill)&&(filter.type==='all'||q.type===filter.type)&&(filter.origin==='all'||q.origin===filter.origin)&&(!filter.search||`${q.title} ${q.topic} ${q.prompt} ${q.type}`.toLowerCase().includes(filter.search.toLowerCase())));}
  function review(){const qs=bank(),due=qs.filter(q=>state.progress[q.id]?.dueAt<=Date.now()),wrong=qs.filter(q=>state.progress[q.id]?.lastCorrect===false);return heading('RECALL & GROW','把薄弱点，变成得分点。','答错后次日复习；答对后按 1、3、7、14、30、60 天逐步拉长间隔。',button('复习到期题目 →','review-now'))+`<div class="two-col"><div class="panel"><span class="eyebrow muted">DUE TODAY</span><div class="stat-value">${due.length}<small>题到期</small></div><p class="muted">包含到期错题与已掌握题目的间隔复习。</p></div><div class="panel"><span class="eyebrow muted">NEEDS ATTENTION</span><div class="stat-value">${wrong.length}<small>题待巩固</small></div><div class="actions">${button('速刷全部错题 →','wrong-now','','ghost')}</div></div></div><div class="section-title" style="margin-top:28px"><h2>错题与自评待巩固题</h2><span class="muted">纠正后自动移出</span></div><div class="question-list">${wrong.length?wrong.map(questionRow).join(''):empty('这里暂时没有错题','完成练习后，听读错题与口写自评待巩固题会自动归入这里。')}</div>`;}
  function mockPage(){const listening=bank().filter(q=>q.skill==='listening'),reading=bank().filter(q=>q.skill==='reading');return heading('EXAM SIMULATION','先练节奏，再上考场。','按科目计时，整场结束后统一查看客观题结果。')+`<div class="notice">本站仿真题为原创练习材料，材料长度与难度不等同官方试卷。听力使用设备合成语音；仿真训练用于练习流程与时间分配，不预测 IELTS 分数。全程包含口语自主录音环节。</div><div class="steps">${[['Listening','30 分钟 · 40 题'],['Reading','60 分钟 · 40 题'],['Writing','60 分钟 · 2 任务'],['Speaking','14 分钟 · 3 部分']].map(([t,d])=>`<div class="step"><b>${t}</b><small>${d}</small></div>`).join('')}</div><div class="two-col"><div class="panel mock-card"><span class="tag">FULL PRACTICE</span><h2>The full experience.</h2><p>听力 → 阅读 → 写作 → 口语。各科单独倒计时；离开或刷新后时间继续计算，返回可恢复。</p>${button('开始四科仿真 →','start-mock')}<p>当前模块：${state.settings.module==='academic'?'Academic':'General Training'}。可用听力 ${listening.length} 题，阅读 ${reading.length} 题。</p></div><div class="panel mock-card"><span class="tag">FOCUSED PRACTICE</span><h2>One skill at a time.</h2><p>集中练一个薄弱项，使用该科时限训练；小题可跳转，结束后统一批改。</p><div class="actions">${Object.entries(SKILLS).map(([k,v])=>button(v.name,'single-mock',`data-skill="${k}"`,'secondary')).join('')}</div></div></div><div class="notice">这里采用听力 30 分钟练习计时，不含纸笔考额外的答案誊写时间。口语实际考试一般为 11—14 分钟，本站取 14 分钟作独立练习时限。<a href="#sources">查看官方考试说明</a></div>${read(SESSION,null)?`<div class="panel"><h3>你有一场未完成的训练</h3><div class="actions" style="margin-top:14px">${button('恢复训练','resume')}${button('丢弃未完成训练','discard-session','','secondary')}</div></div>`:''}`;}
  function vocabItems(){const map=new Map();for(const q of bank())for(const v of q.vocabulary||[]){if(!map.has(v.word.toLowerCase()))map.set(v.word.toLowerCase(),{...v,skill:q.skill,questionId:q.id});}return [...map.values()];}
  function vocabulary(){const vs=vocabItems(),visible=vs.filter(v=>vocabFilter==='all'||vocabFilter==='due'&&(!state.vocabulary[v.word]?.dueAt||state.vocabulary[v.word].dueAt<=Date.now())||vocabFilter==='saved'&&state.vocabulary[v.word]?.saved);return heading('WORDS IN CONTEXT','让词汇，在语境里留下来。',`${vs.length} 个重点词汇 · 来自本站练习材料 · 点击释义进行回忆训练。`)+`<div class="tabs">${[['all','全部词汇'],['due','今日待复习'],['saved','我的收藏']].map(([k,v])=>`<button class="tab ${vocabFilter===k?'active':''}" data-action="vocab-filter" data-value="${k}">${v}</button>`).join('')}</div><div class="vocab-grid">${visible.length?visible.map(v=>`<article class="word-card"><div class="section-title"><span class="tag">${SKILLS[v.skill].en}</span><button class="btn ghost" data-action="speak-word" data-word="${attr(v.word)}" aria-label="朗读 ${attr(v.word)}">♬ 发音</button></div><h2 class="word">${esc(v.word)}</h2><details><summary class="word-meaning">回忆一下，再看释义</summary><p>${esc(v.meaning)}</p></details><p class="word-example">${esc(v.example)}</p><button class="btn ghost" data-action="question" data-id="${attr(v.questionId)}">回到原题 ↗</button><div class="word-actions">${button('记住了','vocab-rate',`data-word="${attr(v.word)}" data-correct="true"`,'secondary')}${button('再复习','vocab-rate',`data-word="${attr(v.word)}" data-correct="false"`,'secondary')}${button(state.vocabulary[v.word]?.saved?'★ 已收藏':'☆ 收藏','vocab-save',`data-word="${attr(v.word)}"`,'ghost')}</div></article>`).join(''):empty('词汇清单已清空','今天的复习已完成，或还没有收藏词汇。')}</div>`;}
  function sources(){const selected=SOURCES.filter(s=>(sourceFilter.year==='all'||String(s.year)===sourceFilter.year)&&(sourceFilter.skill==='all'||s.skills.includes(sourceFilter.skill)));return heading('AUTHENTIC SOURCES · 2022—2026','近五年真题，来源可追溯。','年度出版资料与官方免费练习，按听说读写归类。')+`<div class="notice"><strong>收录边界：</strong>2022—2026 指出版年份，并非实际考试日期。这里提供年度真题出版索引和官方免费样题入口，未完整复制付费试卷，也不声称覆盖近五年每场考试。未注明年份的官方样题单列；站内“速刷”使用原创题或你导入的授权题。</div><div class="year-strip">${[2022,2023,2024,2025,2026].map(y=>`<button class="year-box ${sourceFilter.year===String(y)?'active':''}" data-action="source-year" data-value="${y}"><strong>${y}</strong><small>年度出版资料 ↗</small></button>`).join('')}</div><div class="filters"><select id="source-year" aria-label="来源年份"><option value="all">全部年份 + 未标年样题</option>${[2022,2023,2024,2025,2026].map(y=>`<option ${String(y)===sourceFilter.year?'selected':''}>${y}</option>`).join('')}<option value="null" ${sourceFilter.year==='null'?'selected':''}>官方未标年资料</option></select><select id="source-skill" aria-label="资料技能"><option value="all">听说读写全部</option>${Object.entries(SKILLS).map(([k,v])=>`<option value="${k}" ${sourceFilter.skill===k?'selected':''}>${v.name}</option>`).join('')}</select></div><div class="source-grid">${selected.map(s=>`<article class="source-card"><div class="row-meta"><span class="tag">${s.year?`${s.year} 出版`:'未标考试年份'}</span><span>${esc(s.provider)}</span></div><h3>${esc(s.title)}</h3><div class="row-meta">${s.skills.map(k=>`<span class="tag">${SKILLS[k]?.name||k}</span>`).join('')}</div><p>${esc(s.description)}</p><p>${esc(s.coverage)} ${esc(s.access)}</p><a class="btn secondary" href="${attr(s.url)}" target="_blank" rel="noopener noreferrer">打开官方来源 ↗</a></article>`).join('')||empty('没有该分类的来源','选择全部年份查看未标年官方样题。')}</div><div class="notice">已购买的纸质真题可在原书或官方数字资源中练习；你拥有使用权的题目可按 JSON 模板导入本站，支持四科分类、速刷与错题记录。不要将私人导入内容直接上传公开仓库。</div>`;}
  function settings(){return heading('MAKE IT YOURS','适合你的，才是好节奏。','设置学习目标，备份进度，随时换一台设备继续。')+`<div class="two-col"><section class="panel"><h2>我的学习计划</h2><form id="settings-form"><label class="setting-field">考试类别<select name="module"><option value="academic" ${state.settings.module==='academic'?'selected':''}>Academic 学术类</option><option value="general" ${state.settings.module==='general'?'selected':''}>General Training 培训类</option></select></label><label class="setting-field">目标分数<select name="targetBand">${[5,5.5,6,6.5,7,7.5,8,8.5,9].map(n=>`<option ${n===Number(state.settings.targetBand)?'selected':''}>${n}</option>`).join('')}</select></label><label class="setting-field">每日练习量<select name="dailyGoal">${[4,8,12,16,20].map(n=>`<option value="${n}" ${n===Number(state.settings.dailyGoal)?'selected':''}>${n} 题 / 天</option>`).join('')}</select></label><label class="setting-field">每日提醒时间<input name="reminderTime" type="time" value="${attr(state.settings.reminderTime)}" required><small>用于站内提示与日历文件，按设备当地时间。</small></label><label><input type="checkbox" name="remindersEnabled" ${state.settings.remindersEnabled?'checked':''}> 打开站内训练提醒</label><div class="actions" style="margin-top:20px"><button class="btn" type="submit">保存计划</button>${button('导出日历提醒','calendar','','secondary')}</div></form><div class="notice">智能建议基于错题、正确率和复习间隔，不使用在线 AI。关闭网页后不会后台推送；可把每日日历提醒导入 iOS 日历或桌面日历，提醒通知由日历设置决定。</div></section><section class="panel"><h2>数据与离线使用</h2><p class="muted" style="margin-top:12px;font-size:12px">答题记录保存在当前浏览器，不上传服务器。PC 与 iPhone 的记录通过导出 / 导入迁移，不自动同步。</p><div class="data-actions">${button('↓ 导出学习备份','export','','secondary')}<label class="btn secondary">↑ 导入学习备份<input id="import-backup" type="file" accept=".json,application/json" hidden></label><a href="./question-template.json" download class="btn secondary">↓ 下载授权题库导入模板</a><label class="btn secondary">＋ 导入个人题库<input id="import-bank" type="file" accept=".json,application/json" hidden></label>${button('导出个人题库','export-bank','','secondary')}</div><p class="muted" style="margin-top:15px;font-size:11px">内置 ${BASE.length} 题 · 个人导入 ${custom.length} 题。备份含作答、词汇、历史与设置；草稿另行保存在本机。</p><div class="notice">iPhone：用 Safari 打开 HTTPS 网站 → 分享 → 添加到主屏幕。在线打开一次后可离线练内置题；语音依赖设备已安装的英语声音，官方外链需要联网。</div><h3>口语与写作反馈</h3><p class="muted" style="font-size:12px;margin-top:10px">听读支持标准答案判题；口写提供录音、字数、范例与自评清单，不给出未经校准的 AI 分数。录音只留在当前练习页，请下载后再离开。</p></section></div>`;}
  function render(){
    if(session){renderSession();return;}
    if(sentenceStudy&&playback)stopPlayback();
    sentenceStudy=null;
    clearInterval(timer);
    let [route,arg]=location.hash.slice(1).split('/');
    route=Object.hasOwn(PAGES,route)?route:'dashboard';
    if(route==='practice'&&Object.hasOwn(SKILLS,arg)){filter.skill=arg;filter.type='all';}
    document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===route));
    $('#page-label').textContent=PAGES[route];
    const saved=route==='dashboard'?resumableSession():null;
    const page=({dashboard,practice,mock:mockPage,review,vocabulary,sources,settings}[route])(saved);
    const changed=renderedRoute!==null&&renderedRoute!==route;
    $('#main').innerHTML=`<div${changed?' class="page-enter"':''}>${page}</div>`;
    if(saved?.deadline){
      const countdown=$('#resume-time');
      timer=setInterval(()=>{countdown.textContent=resumeTime(saved.deadline);},1000);
    }
    renderedRoute=route;
    updateChrome();
  }

  function navigate(route){
    const hash=`#${route}`;
    if(location.hash!==hash){location.hash=hash;return;}
    openRoute();
  }

  function openRoute(){
    if(session){
      setAnswer(readAnswer());
      session=null;
      stopMedia();
    }
    render();
    scrollToTop();
  }

  function scrollToTop(smooth=false){
    const reduceMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({top:0,behavior:smooth&&!reduceMotion?'smooth':'auto'});
  }

  function record(q,answer,correct){
    const now=Date.now();
    const previous=state.progress[q.id]||{};
    const text=String(answer??'');
    state.progress[q.id]={
      ...previous,attempts:(previous.attempts||0)+1,correct:(previous.correct||0)+(correct?1:0),
      lastCorrect:correct,lastAnswer:text.slice(0,20000),updatedAt:now,...C.nextReview(previous,correct,now)
    };
    const answered=!isObjective(q)||hasAnswer(text);
    state.history.push({
      date:C.localDateKey(new Date(now)),at:now,skill:q.skill,mode:session?.mode||'practice',
      questionIds:[q.id],answered:answered?1:0,correct:correct?1:0,durationSeconds:0
    });
  }
  function persistSession(){if(session)write(SESSION,{...session});}
  function start(ids,mode='practice',stages=null,replace=false){if(!ids.length){toast('当前分类没有可练题目。');return;}if(!replace&&read(SESSION,null)){ask('开始新的训练？','还有一场已保存的训练。开始新训练会替换未完成进度；也可以取消后回到学习概览继续练习。',()=>start(ids,mode,stages,true));return;}stopMedia();session={ids,index:0,mode,answers:{},checked:{},ratings:{},startedAt:Date.now(),stages,stageIndex:0,deadline:stages?Date.now()+stages[0].seconds*1000:null};persistSession();renderSession();scrollToTop(true);startClock();}
  function startMock(skill){const qs=bank();let stages=[];for(const k of skill?[skill]:['listening','reading','writing','speaking']){let candidates=qs.filter(q=>q.skill===k);if(k==='writing'){const t1=candidates.find(q=>/Task\s*1/i.test(q.type+' '+q.title)),t2=candidates.find(q=>/Task\s*2/i.test(q.type+' '+q.title));candidates=[t1,t2].filter(Boolean);}else if(k==='speaking'){candidates=[1,2,3].map(p=>candidates.find(q=>new RegExp('Part\\s*'+p,'i').test(q.type+' '+q.title))).filter(Boolean);}else candidates=candidates.slice(0,40);if(!candidates.length||(k==='writing'&&candidates.length!==2)||(k==='speaking'&&candidates.length!==3)){toast(`${SKILLS[k].name}材料暂不够，请先导入该类授权题目。`);return;}stages.push({skill:k,ids:candidates.map(q=>q.id),seconds:{listening:1800,reading:3600,writing:3600,speaking:840}[k]});}if(stages.some(s=>['listening','reading'].includes(s.skill)&&s.ids.length<40)){toast('当前模块听读不足 40 题，请先补充授权题库后进行整科仿真。');return;}start(stages.flatMap(s=>s.ids),'mock',stages);}
  function hasAnswer(value){return typeof value==='string'&&Boolean(value.trim());}

  function setAnswer(value){
    const q=currentQ();
    if(!q)return;
    const wasAnswered=hasAnswer(session.answers[q.id]);
    session.answers[q.id]=value;
    if(!isObjective(q)){drafts[q.id]=value;write(DRAFT,drafts);}
    persistSession();
    if(session.mode==='mock'&&hasAnswer(value)!==wasAnswered)updateQuestionNavigator();
  }
  function readAnswer(){const q=currentQ();if(!q)return '';if(q.options)return $('input[name="answer"]:checked')?.value||session.answers[q.id]||'';return $('#answer')?.value||session.answers[q.id]||'';}
  function sessionMaterial(q){
    const label={listening:'LISTEN & NOTICE',speaking:'SPEAK WITH CONFIDENCE',writing:'PLAN · WRITE · REFINE',reading:'READ & UNDERSTAND'}[q.skill];
    let material;
    if(q.skill==='listening') material=audioPanel(q);
    else if(q.passage) material=`<div class="passage" id="session-passage">${esc(q.passage)}</div>`;
    else if(q.skill==='reading') material='<div class="notice">本题使用题干中的材料。</div>';
    else if(q.skill==='speaking') material='<div class="notice">先整理观点，再按提示开口。Part 2 可先准备 1 分钟，再连续表达 1—2 分钟。</div>';
    else material='<div class="notice">先审题与规划段落，再开始写作。Task 1 建议 20 分钟，Task 2 建议 40 分钟。</div>';
    return `<span class="eyebrow muted">${label}</span>
      <h2 id="session-material-title" style="margin-top:12px">${esc(q.title)}</h2>
      ${material}
      ${q.skill==='speaking'?recordPanel():''}
      ${q.skill==='writing'?`<p class="muted" style="font-size:12px;margin-top:18px">最低建议字数：${q.minWords||250} 词。内容实时存为本机草稿。</p>`:''}`;
  }

  function answerField(q,answer,checked){
    const disabled=checked!==undefined?'disabled':'';
    if(q.options){
      return q.options.map((option,index)=>`<label class="option">
        <input type="radio" name="answer" value="${attr(option)}" ${answer===option?'checked':''} ${disabled}>
        <span>${String.fromCharCode(65+index)}. ${esc(option)}</span></label>`).join('');
    }
    if(isObjective(q)){
      return `<label class="muted" for="answer">输入答案（按题干要求控制词数）</label>
        <input id="answer" class="answer-input" autocomplete="off" spellcheck="false" value="${attr(answer)}" ${disabled}>`;
    }
    const writing=q.skill==='writing';
    return `<textarea id="answer" aria-label="英文作答与练习笔记" rows="${writing?12:6}" placeholder="${writing?'Write your response here…':'记录表达要点或口语复盘…'}">${esc(answer)}</textarea>
      <div class="word-count"><span id="word-count">${wordCount(answer)}</span> words · 自动保存草稿</div>`;
  }

  function sessionAnswer(q){
    const answer=session.answers[q.id]??(!isObjective(q)?drafts[q.id]:'')??'';
    const checked=session.checked[q.id];
    const mock=session.mode==='mock';
    const submitLabel=isObjective(q)?'提交答案':'查看练习反馈';
    const nextLabel=session.index===session.ids.length-1?'完成练习 →':'下一题 →';
    const mark=mock?button('标记待检查','toggle-question-mark',`id="question-mark" aria-pressed="${isMarked(q.id)}"`,'secondary question-mark'):'';
    return `<span class="tag">${esc(q.topic)}</span> <span class="tag">${esc(q.type)}</span>
      <h2 id="session-question" tabindex="-1">${esc(q.prompt)}</h2>
      ${answerField(q,answer,checked)}
      <div id="feedback" tabindex="-1">${checked!==undefined?feedback(q,checked):''}</div>
      <div class="actions" style="margin-top:22px">
        ${mock?button('保存答案','save-answer'):checked===undefined?button(submitLabel,'submit-answer'):''}
        ${mark}
        ${button(nextLabel,'next-question','','secondary')}
      </div>
      ${mock?'<p class="muted" style="font-size:10px;margin-top:12px">答案已实时保存；整场结束后显示解析。口语、写作需完成后自评。</p>':''}`;
  }

  function showReadingPane(pane){
    const material=pane==='material';
    const toggle=$('#reading-toggle');
    $('#session-training').classList.toggle('show-reading-material',material);
    toggle.setAttribute('aria-expanded',String(material));
    toggle.textContent=material?'回到题目':'看原文';
  }

  function toggleReadingPane(){
    const toggle=$('#reading-toggle');
    if(!toggle?.getClientRects().length)return;
    const current=toggle.getAttribute('aria-expanded')==='true'?'material':'answer';
    const next=current==='material'?'answer':'material';
    readingOffsets[current]=-$(`#session-${current}`).getBoundingClientRect().top;
    showReadingPane(next);
    const position=$(`#session-${next}`).getBoundingClientRect().top+window.scrollY;
    window.scrollTo({top:position+(readingOffsets[next]??-12),behavior:'auto'});
  }

  function currentQuestionIds(){return session.stages?.[session.stageIndex]?.ids??session.ids;}

  function isMarked(id){return session.marked?.[id]===true;}

  function questionNavigator(){
    const ids=currentQuestionIds();
    const mock=session.mode==='mock';
    const selected=mock&&Object.hasOwn(QUESTION_FILTERS,session.questionFilter)?session.questionFilter:'all';
    const counts={all:ids.length,unanswered:0,marked:0};
    const numbers=[];
    for(const id of ids){
      const answered=hasAnswer(session.answers[id]);
      const marked=mock&&isMarked(id);
      if(!answered)counts.unanswered++;
      if(marked)counts.marked++;
      if((selected==='unanswered'&&answered)||(selected==='marked'&&!marked))continue;
      const index=session.ids.indexOf(id);
      const current=index===session.index;
      const classes=`q-number${current?' active':answered?' answered':''}${marked?' marked':''}`;
      const label=`第 ${index+1} 题${marked?'，已标记':''}`;
      numbers.push(`<button class="${classes}" data-action="jump-question" data-index="${index}" aria-label="${label}"${current?' aria-current="step"':''}>${index+1}</button>`);
    }
    const emptyLabel=selected==='marked'?'当前科目暂无已标记的题目。':'当前科目的题目已全部作答。';
    return {selected,counts,numbers:numbers.join('')||`<p class="muted">${emptyLabel}</p>`};
  }

  function renderQuestionNavigator(view){
    const numbers=`<div id="session-questions" class="question-numbers" aria-label="跳转题目">${view.numbers}</div>`;
    if(session.mode!=='mock')return numbers;
    const filters=Object.entries(QUESTION_FILTERS).map(([key,label])=>button(
      `${label} <span id="question-count-${key}">${view.counts[key]}</span>`, 'question-filter',
      `id="question-filter-${key}" data-value="${key}" aria-controls="session-questions" aria-pressed="${view.selected===key}"`,
      'secondary question-filter'
    )).join('');
    return `<section class="mock-question-nav" aria-label="题号与筛选">
      <div class="actions" role="group" aria-label="按题目状态筛选">${filters}</div>
      ${numbers}
    </section>`;
  }

  function updateQuestionNavigator(view=questionNavigator()){
    $('#session-questions').innerHTML=view.numbers;
    if(session.mode!=='mock')return;
    for(const key of Object.keys(QUESTION_FILTERS)){
      $(`#question-filter-${key}`).setAttribute('aria-pressed',String(view.selected===key));
      $(`#question-count-${key}`).textContent=view.counts[key];
    }
  }

  function selectQuestionFilter(key){
    if(session?.mode!=='mock'||!Object.hasOwn(QUESTION_FILTERS,key))return;
    session.questionFilter=key;
    persistSession();
    updateQuestionNavigator();
  }

  function toggleQuestionMark(){
    const q=currentQ();
    if(!q||session.mode!=='mock')return;
    const marked=session.marked??={};
    const pressed=!isMarked(q.id);
    if(pressed)marked[q.id]=true;
    else delete marked[q.id];
    persistSession();
    $('#question-mark').setAttribute('aria-pressed',String(pressed));
    updateQuestionNavigator();
  }

  function renderSession(keepMaterial=false){
    const q=currentQ();
    if(!q){finish();return;}
    const stage=session.stages?.[session.stageIndex];
    const progress=`${(session.index+1)/session.ids.length*100}%`;
    const questionType=`${SKILLS[q.skill].en} · ${q.type}`;
    const stageNumber=stage?` · 第 ${session.stageIndex+1} / ${session.stages.length} 科`:'';
    const details=`<span class="muted">第 ${session.index+1} / ${session.ids.length} 题${stageNumber}</span>
      <span class="tag">${q.origin==='original'?'原创仿真':'个人导入'} · ${esc(q.level)}</span>`;
    const navigator=questionNavigator();

    if(keepMaterial){
      $('#session-question-type').textContent=questionType;
      $('#session-progress').style.width=progress;
      $('#session-details').innerHTML=details;
      $('#session-material-title').textContent=q.title;
      $('#session-answer').innerHTML=sessionAnswer(q);
      updateQuestionNavigator(navigator);
      return;
    }

    const mock=session.mode==='mock';
    const canReadPassage=q.skill==='reading'&&Boolean(q.passage);
    sentenceStudy=!mock&&q.skill==='listening'?createSentenceStudy(q.transcript):null;
    readingOffsets={material:null,answer:null};
    const label=mock?'EXAM SIMULATION':session.mode==='daily'?'DAILY PRACTICE':'FOCUSED PRACTICE';
    const time=session.deadline?formatTime(Math.ceil((session.deadline-Date.now())/1000)):'自由练习';
    const endLabel=session.stageIndex===session.stages?.length-1?'交卷并结束':'结束当前科目，进入下一科 →';
    const focus=q.skill==='reading'||q.skill==='writing';
    $('#page-label').textContent=mock?'仿真训练':'练习进行中';
    $('#main').innerHTML=`<div class="session-header">
      <div class="atelier-status">${focus?motionMark('focus'):''}<div><span class="eyebrow muted">${label}</span><h2 id="session-question-type">${esc(questionType)}</h2></div></div>
      <div class="actions"><span id="timer" class="timer">${time}</span>${button('保存并退出','exit-session','','secondary')}</div>
    </div>
    <div class="progress-track"><span id="session-progress" style="width:${progress}"></span></div>
    <div id="session-details" class="section-title">${details}</div>
    <div id="session-training" class="training-grid${canReadPassage?' reading-training':''}">
      <section id="session-material" class="reading-pane">${sessionMaterial(q)}</section>
      <section id="session-answer" class="answer-pane">${sessionAnswer(q)}</section>
    </div>
    ${renderQuestionNavigator(navigator)}
    ${stage?button(endLabel,'advance-stage','','secondary'):button('结束本次练习','finish-session','','secondary')}
    ${canReadPassage?`<div class="reading-switch"><div class="reading-switch-bar">
      ${button('看原文','toggle-reading-pane','id="reading-toggle" aria-controls="session-material" aria-expanded="false"')}
    </div></div>`:''}`;
  }

  function speechRateControl(){
    return `<select id="speech-rate" aria-label="朗读速度"><option value="0.85">0.85×</option><option value="1" selected>1.0×</option><option value="1.15">1.15×</option></select>`;
  }

  function speechRate(){return Number($('#speech-rate')?.value||1);}

  function audioStatus(message){
    return `<div class="atelier-status">${motionMark('idle','audio-motion')}<p id="audio-status" role="status">${message}</p></div>`;
  }

  function createSentenceStudy(transcript){
    const sentences=C.splitTranscript(transcript);
    return sentences.length?{sentences,index:0,showText:false}:null;
  }

  function sentencePlayer(){
    if(!sentenceStudy)return '';
    const total=sentenceStudy.sentences.length;
    return `<section class="sentence-player" aria-labelledby="sentence-player-title">
      <div class="section-title"><h3 id="sentence-player-title">逐句精听</h3><span id="sentence-position" class="muted" role="status">第 1 / ${total} 句</span></div>
      <div class="actions">
        ${button('重播当前句','sentence-replay')}
        ${button('下一句','sentence-next',`id="sentence-next"${total===1?' disabled':''}`,'secondary')}
        ${button('显示本句原文','sentence-text','id="sentence-toggle" aria-controls="sentence-source" aria-expanded="false"','secondary')}
      </div>
      <p id="sentence-source" class="sentence-source" lang="en" hidden></p>
    </section>`;
  }

  function updateSentencePlayer(){
    const {sentences,index,showText}=sentenceStudy;
    const next=$('#sentence-next');
    const toggle=$('#sentence-toggle');
    const text=$('#sentence-source');
    $('#sentence-position').textContent=`第 ${index+1} / ${sentences.length} 句`;
    next.disabled=sentences.length===1;
    next.textContent=index===sentences.length-1&&sentences.length>1?'从第一句开始':'下一句';
    toggle.setAttribute('aria-expanded',String(showText));
    toggle.textContent=showText?'隐藏本句原文':'显示本句原文';
    text.hidden=!showText;
    text.textContent=showText?sentences[index]:'';
  }

  function playCurrentSentence(){
    if(sentenceStudy)playSpeech([sentenceStudy.sentences[sentenceStudy.index]],speechRate());
  }

  function nextSentence(){
    if(!sentenceStudy||sentenceStudy.sentences.length===1)return;
    sentenceStudy.index=(sentenceStudy.index+1)%sentenceStudy.sentences.length;
    updateSentencePlayer();
    playCurrentSentence();
  }

  function toggleSentenceText(){
    if(!sentenceStudy)return;
    sentenceStudy.showText=!sentenceStudy.showText;
    updateSentencePlayer();
  }

  function audioPanel(q){
    const transcript=session.mode==='mock'
      ?'<p class="muted" style="font-size:11px">仿真模式隐藏听力原文，交卷后可查看。</p>'
      :`<details><summary>查看听力原文（练习辅助）</summary><div class="passage">${esc(q.transcript)}</div></details>`;
    return `<div class="audio-panel">
      <div class="row-meta"><span class="tag">DEVICE VOICE</span><span>同组题共用一段材料</span></div>
      ${audioStatus('合成语音练习，非官方真人录音。首次播放请点击按钮。')}
      <div class="actions">${button('▶ 播放材料','play-audio')}${button('■ 停止','stop-audio','','secondary')}
        ${speechRateControl()}
      </div>
      ${sentencePlayer()}
    </div>${transcript}`;
  }

  function recordedAudio(){return recordURL?`<audio controls src="${recordURL}"></audio><a class="inline-link" href="${recordURL}" download="ielts-speaking-${currentQ()?.id}.${recordMime.includes('mp4')?'m4a':'webm'}">下载本次录音 ↓</a>`:'';}
  function recordPanel(){
    return `<div class="record-controls">
      <div class="actions">${button('● 开始录音','record-start')}${button('■ 停止录音','record-stop','','secondary')}${button('1 分钟准备','prepare-speaking','','secondary')}</div>
      <div class="atelier-status">${motionMark('idle','record-motion')}<p id="record-status" class="muted">${RECORD_IDLE}</p></div>
      <div id="record-result">${recordedAudio()}</div>
    </div>`;
  }

  function feedback(q,correct){if(isObjective(q))return `<div class="feedback ${correct?'':'incorrect'}"><b>${correct?'✓ 回答正确':'↺ 这道题再巩固一下'}</b><p>参考答案：${esc(q.answer.join(' / '))}</p><p>${esc(q.explanation)}</p>${q.transcript?`<details><summary>听力原文</summary><p>${esc(q.transcript)}</p></details>`:''}</div>`;const value=session?.answers[q.id]||drafts[q.id]||'';return `<div class="feedback"><b>练习反馈 · 自评，不是官方评分</b><p>${q.skill==='writing'?`当前 ${wordCount(value)} 词，建议至少 ${q.minWords||250} 词。${wordCount(value)<(q.minWords||250)?'可以进一步展开论证或补充关键细节。':'接下来检查逻辑、语法与用词。'}`:'回放录音，留意停顿、重复与论点展开。'}</p><p>${esc(q.explanation)}</p><div class="checklist">${(q.checklist||['回答了题目的所有部分','观点清晰，有具体的细节或例子','词汇与语法准确且有变化']).map(x=>`<label><input type="checkbox">${esc(x)}</label>`).join('')}</div>${q.model?`<details><summary>查看原创参考表达</summary><p>${esc(q.model)}</p></details>`:''}<p>本次表现如何？</p><div class="actions">${button('还需巩固','self-rate',`data-correct="false"`,'secondary')}${button('基本掌握','self-rate',`data-correct="true"`,'secondary')}</div></div>`;}
  function submit(){
    const q=currentQ();
    if(!q||session.checked[q.id]!==undefined)return;
    const answer=readAnswer();
    const objective=isObjective(q);
    if(objective&&!answer.trim()){toast('先填写答案，再提交。');return;}
    setAnswer(answer);
    const checked=objective?C.grade(q,answer):null;
    session.checked[q.id]=checked;
    if(objective){record(q,answer,checked);save();}
    persistSession();

    if(objective){
      document.querySelectorAll('#session-answer input[name="answer"], #session-answer input#answer').forEach(input=>{input.disabled=true;});
    }
    const panel=$('#feedback');
    panel.classList.add('feedback-enter');
    panel.innerHTML=feedback(q,checked);
    const submitButton=$('#session-answer [data-action="submit-answer"]');
    if(submitButton&&document.activeElement===submitButton)panel.focus({preventScroll:true});
    submitButton?.remove();
  }

  function move(index){
    if(index===session.index||!currentQuestionIds().includes(session.ids[index]))return;
    const from=currentQ();
    const to=questions.find(q=>q.id===session.ids[index]);
    const samePassage=from?.skill==='reading'&&to?.skill==='reading'&&from.passage&&from.passage===to.passage;
    const sameListeningGroup=from?.skill==='listening'&&to?.skill==='listening'&&from.groupId&&from.groupId===to.groupId;
    const keepMaterial=samePassage||(sameListeningGroup&&from.transcript===to.transcript);
    const toggle=samePassage?$('#reading-toggle'):null;
    const mobileReading=Boolean(toggle?.getClientRects().length);
    if(toggle){
      if(mobileReading&&toggle.getAttribute('aria-expanded')==='true'){
        readingOffsets.material=-$('#session-material').getBoundingClientRect().top;
      }
      readingOffsets.answer=null;
      showReadingPane('answer');
    }
    if(!sameListeningGroup)stopMedia();
    session.index=index;
    persistSession();
    renderSession(keepMaterial);
    if(keepMaterial){
      const question=$('#session-question');
      question.focus({preventScroll:true});
      question.scrollIntoView({block:mobileReading?'start':'nearest'});
    }else scrollToTop(true);
  }

  function next(){setAnswer(readAnswer());if(session.mode!=='mock'&&session.checked[currentQ().id]===undefined){toast('请先提交答案或查看反馈，也可用下方题号跳题。');return;}if(session.mode!=='mock'&&!isObjective(currentQ())&&session.ratings[currentQ().id]===undefined){toast('请先选择自评结果：还需巩固或基本掌握。');return;}const stage=session.stages?.[session.stageIndex];if(stage&&session.ids[session.index]===stage.ids.at(-1)){confirmAdvance();return;}if(session.index+1>=session.ids.length)finish();else move(session.index+1);}
  function startClock(){clearInterval(timer);if(!session?.deadline)return;timer=setInterval(()=>{if(!session)return;let remaining=Math.ceil((session.deadline-Date.now())/1000);if($('#timer')){$('#timer').textContent=formatTime(remaining);$('#timer').classList.toggle('urgent',remaining<120);}if(remaining<=0)advance(true);},500);}
  function confirmAdvance(){
    if(!session?.stages)return;
    setAnswer(readAnswer());
    const captured=session;
    const stageIndex=session.stageIndex;
    const ids=currentQuestionIds();
    const unanswered=ids.filter(id=>!hasAnswer(session.answers[id])).length;
    const marked=ids.filter(isMarked).length;
    const status=[unanswered?`本阶段还有 ${unanswered} 题未填写。`:'',marked?`有 ${marked} 题带有待检查标记。`:''].join('');
    ask('结束当前科目？',`${status}提交后不能返回当前科目修改答案。`,()=>{
      if(session===captured&&session.stageIndex===stageIndex)advance(false);
    });
  }

  function advance(expired){
    if(!session?.stages)return;
    if(expired){$('#confirm-dialog').close();confirmCallback=null;}
    stopMedia();
    const previousDeadline=session.deadline;
    session.stageIndex++;
    if(session.stageIndex>=session.stages.length){finish();return;}
    const stage=session.stages[session.stageIndex];
    session.index=session.ids.indexOf(stage.ids[0]);
    session.questionFilter='all';
    session.deadline=(expired?previousDeadline:Date.now())+stage.seconds*1000;
    persistSession();
    renderSession();
    toast(expired?'本阶段时间已到，已进入下一科。':'已进入下一科。');
    startClock();
  }
  function resultBreakdown(graded){
    if(!graded.length)return '';
    const byType=new Map();
    for(const {question,answered,correct} of graded){
      const key=`${question.skill}:${question.type}`;
      if(!byType.has(key)){
        byType.set(key,{label:`${SKILLS[question.skill].name} · ${question.type}`,total:0,correct:0,wrong:0,unanswered:0});
      }
      const row=byType.get(key);
      row.total++;
      if(correct)row.correct++;
      else if(answered)row.wrong++;
      else row.unanswered++;
    }
    return `<section class="panel result-breakdown">
      <h2 id="result-breakdown-title">客观题按题型统计</h2>
      <table aria-labelledby="result-breakdown-title">
        <thead><tr><th scope="col">科目与题型</th><th scope="col">答对 / 总题数</th><th scope="col">答错</th><th scope="col">未答</th></tr></thead>
        <tbody>${Array.from(byType.values(),row=>`<tr><th scope="row">${esc(row.label)}</th>
          <td>${row.correct} / ${row.total}</td><td>${row.wrong}</td><td>${row.unanswered}</td></tr>`).join('')}</tbody>
      </table>
    </section>`;
  }

  function listeningReview(graded){
    const groups=new Map();
    for(const {question} of graded){
      if(question.skill!=='listening')continue;
      const transcript=question.transcript?.trim();
      if(transcript&&!groups.has(transcript))groups.set(transcript,question);
    }
    const materials=[...groups.values()];
    sentenceStudy=createSentenceStudy(materials[0]?.transcript);
    if(!sentenceStudy)return '';
    const materialControl=materials.length===1
      ?`<p class="muted">${esc(materials[0].title)}</p>`
      :`<label class="listening-material" for="review-listening-material">选择听力材料
        <select id="review-listening-material">${materials.map(q=>`<option value="${attr(q.id)}">${esc(q.title)}</option>`).join('')}</select>
      </label>`;
    return `<section class="panel listening-review" aria-labelledby="listening-review-title">
      <h2 id="listening-review-title">听力复盘</h2>
      ${materialControl}
      <div class="audio-panel">
        ${audioStatus('合成语音精听，点击播放当前句。')}
        <div class="actions">${button('■ 停止','stop-audio','','secondary')}${speechRateControl()}</div>
        ${sentencePlayer()}
      </div>
    </section>`;
  }

  function changeReviewListening(id){
    if(!$('#review-listening-material'))return;
    const question=questions.find(q=>q.skill==='listening'&&q.id===id);
    const study=createSentenceStudy(question?.transcript);
    if(!study)return;
    stopPlayback();
    sentenceStudy=study;
    setMediaStatus('audio','idle','合成语音精听，点击播放当前句。');
    updateSentencePlayer();
  }

  function finish(){
    if(!session)return;
    const finished=session;
    const mock=finished.mode==='mock';
    clearInterval(timer);
    stopMedia();

    const graded=[],subjective=[];
    for(const id of finished.ids){
      const question=questions.find(q=>q.id===id);
      if(!question)continue;
      if(!isObjective(question)){
        if(mock||finished.checked[id]!==undefined)subjective.push(question);
        continue;
      }
      const answer=finished.answers[id]??'';
      const correct=mock?C.grade(question,answer):finished.checked[id];
      if(correct===undefined)continue;
      if(mock)record(question,answer,correct);
      graded.push({question,answer,answered:hasAnswer(answer),correct});
    }
    if(mock&&graded.length)save();
    try{localStorage.removeItem(SESSION);}catch{}
    session=null;

    const correct=graded.filter(item=>item.correct).length;
    const wrongIds=graded.filter(item=>item.answered&&!item.correct).map(item=>item.question.id);
    const unanswered=graded.length-correct-wrongIds.length;
    const accuracy=graded.length?Math.round(correct/graded.length*100):0;
    const retry=wrongIds.length?button(`重练本场错题（${wrongIds.length}）`,'retry-wrong',`data-ids="${attr(wrongIds.join(','))}"`):'';
    $('#main').innerHTML=heading('SESSION COMPLETE','又积累了一点。','把反馈变成下一次练习的起点。')+`
      <div class="panel">
        <div class="atelier-status result-motion">${motionMark('complete')}<span class="eyebrow muted">OBJECTIVE QUESTIONS</span></div>
        <div class="result-score">${correct}<small> / ${graded.length} 道客观题答对</small></div>
        <p class="muted">${accuracy}% 正确率 · 答错 ${wrongIds.length} 题${mock?` · 未答 ${unanswered} 题 · 未作答的客观题计为错误`:''} · 本结果不换算 IELTS 分数</p>
        <div class="actions" style="margin-top:24px">
          ${retry}${button('回到学习概览','home','',retry?'secondary':'')}${button('查看错题本','go-review','','secondary')}
        </div>
      </div>
      ${resultBreakdown(graded)}
      ${listeningReview(graded)}
      ${subjective.length?`<div class="notice">口语 / 写作需手动自评后才进入学习记录与复习计划。草稿已保存，点击下方题目进入反馈。</div>${subjective.map(questionRow).join('')}`:''}
      ${graded.length?`<div class="section-title" style="margin-top:28px"><h2>答案与解析</h2></div>
        <div class="question-list">${graded.map(({question,answer,answered,correct})=>`<details class="panel">
          <summary>${correct?'✓':answered?'↺':'—'} ${esc(question.title)} · ${esc(question.prompt)}</summary>
          <p style="margin-top:14px">你的答案：${answered?esc(answer):'未作答'}</p>
          ${feedback(question,correct)}
        </details>`).join('')}</div>`:''}`;
    scrollToTop();
  }

  function clearSpeakingPrep(){
    clearInterval(recordPanel.prepTimer);
    recordPanel.prepTimer=null;
  }

  function prepareSpeaking(){
    if(recordPending||recorder?.state==='recording')return;
    clearSpeakingPrep();
    let seconds=60;
    setMediaStatus('record','focus','准备时间 01:00');
    recordPanel.prepTimer=setInterval(()=>{
      seconds--;
      if(seconds>0){setMediaStatus('record','focus',`准备时间 ${formatTime(seconds)}`);return;}
      clearSpeakingPrep();
      setMediaStatus('record','idle','准备结束，开始你的 1—2 分钟表达。');
    },1000);
  }

  function stopPlayback(){
    const wasPlaying=Boolean(playback);
    playback=null;
    window.speechSynthesis?.cancel();
    if(wasPlaying)setMediaStatus('audio','idle','已停止。');
  }

  function stopMedia(){
    stopPlayback();
    const activeRecorder=recorder;
    const wasRecording=activeRecorder?.state==='recording';
    recorder=null;
    if(activeRecorder&&activeRecorder.state!=='inactive')activeRecorder.stop();
    recordStream?.getTracks().forEach(track=>track.stop());
    recordStream=null;
    if(recordURL){
      URL.revokeObjectURL(recordURL);
      recordURL=null;
      const result=$('#record-result');
      if(result)result.innerHTML='';
    }
    if(recordPending||wasRecording||recordPanel.prepTimer){
      setMediaStatus('record','idle',wasRecording?'录音已停止。':RECORD_IDLE);
    }
    recordPending=null;
    clearSpeakingPrep();
  }

  function speak(text,rate=1){
    playSpeech(C.splitTranscript(text),rate);
  }

  function playSpeech(messages,rate){
    if(!messages.length)return;
    const voiceEngine=window.speechSynthesis;
    if(!voiceEngine){toast('当前浏览器不支持朗读，请查看原文或使用 Safari / Chrome。');return;}
    stopPlayback();
    const run={};
    playback=run;
    let index=0;
    function end(message){
      if(playback!==run)return;
      playback=null;
      setMediaStatus('audio','idle',message);
    }
    function fail(error){
      if(playback!==run)return;
      if(error==='interrupted'||error==='canceled'){end('已停止。');return;}
      end('语音暂不可用，请检查英语声音设置。');
      if(!$('#audio-status'))toast('语音暂不可用，请检查英语声音设置。');
    }
    function nextMessage(){
      if(playback!==run)return;
      if(index>=messages.length){end('播放完成，可重播。');return;}
      const utterance=new SpeechSynthesisUtterance(messages[index++]);
      utterance.lang='en-GB';
      utterance.rate=rate;
      const voices=voiceEngine.getVoices();
      utterance.voice=voices.find(voice=>voice.lang==='en-GB')||voices.find(voice=>voice.lang.startsWith('en'))||null;
      utterance.onstart=()=>{if(playback===run)setMediaStatus('audio','listening','正在播放 · 可点击停止');};
      utterance.onend=nextMessage;
      utterance.onerror=event=>fail(event.error);
      try{voiceEngine.speak(utterance);}catch{fail();}
    }
    setMediaStatus('audio','loading','正在准备语音…');
    nextMessage();
  }

  async function startRecording(){
    if(recordPending||recorder?.state==='recording')return;
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){
      toast('录音需要 HTTPS 与支持 MediaRecorder 的浏览器；可用设备录音工具练习。');
      return;
    }
    const activeSession=session;
    const questionId=currentQ()?.id;
    const status=$('#record-status');
    const stillHere=()=>session===activeSession&&currentQ()?.id===questionId&&$('#record-status')===status;
    const request={};
    recordPending=request;
    stopPlayback();
    clearSpeakingPrep();
    setMediaStatus('record','loading','正在等待麦克风权限…');
    let stream=null;
    let activeRecorder=null;
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(recordPending!==request||!stillHere()){
        stream.getTracks().forEach(track=>track.stop());
        return;
      }
      const type=['audio/mp4','audio/webm;codecs=opus','audio/webm'].find(candidate=>MediaRecorder.isTypeSupported(candidate));
      activeRecorder=new MediaRecorder(stream,type?{mimeType:type}:{});
      recordStream=stream;
      recorder=activeRecorder;
      const chunks=[];
      activeRecorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      activeRecorder.onstop=()=>{
        stream.getTracks().forEach(track=>track.stop());
        if(recordStream===stream)recordStream=null;
        if(recorder!==activeRecorder||!stillHere())return;
        const blob=new Blob(chunks,{type:activeRecorder.mimeType});
        if(recordURL)URL.revokeObjectURL(recordURL);
        recordMime=activeRecorder.mimeType;
        recordURL=URL.createObjectURL(blob);
        $('#record-result').innerHTML=recordedAudio();
        setMediaStatus('record','idle','录音已停止。离开题目会清除录音，请先下载。');
      };
      activeRecorder.start();
      setMediaStatus('record','speaking','● 正在录音，请开始表达…');
    }catch{
      stream?.getTracks().forEach(track=>track.stop());
      if(recordStream===stream)recordStream=null;
      if(recorder===activeRecorder)recorder=null;
      if(recordPending===request&&stillHere()){
        setMediaStatus('record','idle','未能启用麦克风，请检查权限后重试。');
        toast('未能启用麦克风，请检查权限后重试。');
      }
    }finally{
      if(recordPending===request)recordPending=null;
    }
  }

  function download(name,data,type='application/json'){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function calendar(){const value=$('input[name="reminderTime"]')?.value||state.settings.reminderTime;const d=new Date();const [h,m]=value.split(':');d.setHours(Number(h),Number(m),0,0);if(d<Date.now())d.setDate(d.getDate()+1);const stamp=`${C.localDateKey(d).replaceAll('-','')}T${String(h).padStart(2,'0')}${String(m).padStart(2,'0')}00`;const utc=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');download('ielts-daily-reminder.ics',['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//IELTS Atelier//Study//ZH','CALSCALE:GREGORIAN','BEGIN:VEVENT',`UID:ielts-${Date.now()}@atelier.local`,`DTSTAMP:${utc}`,`DTSTART:${stamp}`,'DURATION:PT20M','RRULE:FREQ=DAILY','SUMMARY:IELTS 听说读写每日小练','DESCRIPTION:打开雅思练习室，完成每日小练并复习到期错题。','BEGIN:VALARM','TRIGGER:PT0M','ACTION:DISPLAY','DESCRIPTION:今天也为雅思留一点时间','END:VALARM','END:VEVENT','END:VCALENDAR',''].join('\r\n'),'text/calendar;charset=utf-8');toast('已导出日历提醒，导入日历后可启用通知。');}
  function validateBank(data){if(!Array.isArray(data)||!data.length||data.length>2000)throw Error('题库应为包含 1—2000 道题的 JSON 数组。');const ids=new Set(BASE.map(q=>q.id));return data.map(q=>{if(!q||typeof q!=='object'||!Object.hasOwn(SKILLS,q.skill)||!['academic','general','both'].includes(q.module))throw Error('题目缺少有效的 skill 或 module。');if(typeof q.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(q.id)||ids.has(q.id)||['__proto__','constructor','prototype'].includes(q.id))throw Error('题目 ID 无效、重复或与内置题冲突。');ids.add(q.id);const clean={origin:'imported',year:null};for(const k of ['id','skill','module','type','title','topic','level','groupId','passage','transcript','prompt','explanation','model']){if(q[k]!=null){if(typeof q[k]!=='string'||q[k].length>50000)throw Error('文本字段格式不正确或过长。');clean[k]=q[k];}}for(const k of ['type','title','topic','prompt','explanation'])if(!clean[k])throw Error(`缺少 ${k} 字段。`);clean.level ||= '进阶';if(['listening','reading'].includes(q.skill)){if(!Array.isArray(q.answer)||!q.answer.length||q.answer.some(a=>typeof a!=='string'||!a.trim()||a.length>500))throw Error('听读题必须提供非空 answer 数组。');clean.answer=q.answer;}for(const k of ['options','checklist'])if(q[k]!=null){if(!Array.isArray(q[k])||q[k].length>30||q[k].some(v=>typeof v!=='string'||v.length>2000))throw Error(`${k} 格式不正确。`);clean[k]=q[k];}if(q.skill==='listening'&&!clean.transcript)throw Error('听力题需要 transcript。');if(q.options&&q.answer?.some(a=>!q.options.includes(a)))throw Error('选择题答案必须与选项全文一致。');if(q.vocabulary){if(!Array.isArray(q.vocabulary)||q.vocabulary.length>100)throw Error('词汇字段不正确。');clean.vocabulary=q.vocabulary.map(v=>{if(!v||['word','meaning','example'].some(k=>typeof v[k]!=='string'||v[k].length>1000)||['__proto__','constructor','prototype'].includes(v.word))throw Error('词汇内容无效。');return {word:v.word,meaning:v.meaning,example:v.example};});}if(q.minWords)clean.minWords=Math.max(1,Math.min(1000,Number(q.minWords)||250));return clean;});}
  async function importFile(input,isBank){const file=input.files[0];if(!file)return;if(file.size>5e6){toast('文件过大，请使用小于 5 MB 的 JSON 文件。');return;}try{const data=JSON.parse(await file.text());if(isBank){const clean=validateBank(data);ask('导入个人题库？',`将新增或更新 ${clean.length} 道题。仅在本机保存；请确保你有权使用这些内容。`,()=>{const map=new Map(custom.map(q=>[q.id,q]));clean.forEach(q=>map.set(q.id,q));const next=[...map.values()];if(write(CUSTOM,next)){custom=next;questions=[...BASE,...custom];render();toast('个人题库已导入。');}});}else{const clean=C.validateImport(data,questions);ask('恢复学习备份？','将用备份替换当前学习记录与设置。建议先导出当前进度。个人题库需单独导入。',()=>{state={...defaults,...clean,settings:{...defaults.settings,...clean.settings},vocabulary:clean.vocabulary||{}};save();render();toast('学习备份已恢复。');});}}catch(e){toast(`导入失败：${e.message}`);}input.value='';}
  document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(!el)return;const a=el.dataset.action,q=currentQ();switch(a){case'dialog-cancel':$('#confirm-dialog').close();confirmCallback=null;break;case'dialog-ok':$('#confirm-dialog').close();const cb=confirmCallback;confirmCallback=null;cb?.();break;case'daily':start(C.selectDaily(bank(),state.progress,C.localDateKey(),Number(state.settings.dailyGoal)).map(q=>q.id),'daily');break;case'question':start([el.dataset.id]);break;case'skill-filter':filter.skill=el.dataset.value;filter.type='all';history.replaceState(null,'','#practice');render();break;case'quick':start(filtered().map(q=>q.id),'quick');break;case'review-now':{const ids=bank().filter(q=>state.progress[q.id]?.dueAt<=Date.now()).map(q=>q.id);ids.length?start(ids,'review'):(navigate('review'),toast('目前没有到期题目，可速刷错题或开始每日小练。'));break;}case'wrong-now':start(bank().filter(q=>state.progress[q.id]?.lastCorrect===false).map(q=>q.id),'review');break;case'vocab-filter':vocabFilter=el.dataset.value;render();break;case'vocab-rate':{const word=el.dataset.word;state.vocabulary[word]={...state.vocabulary[word],...C.nextReview(state.vocabulary[word]||{},el.dataset.correct==='true')};save();toast('词汇复习计划已更新。');render();break;}case'vocab-save':{const w=el.dataset.word;state.vocabulary[w]={...state.vocabulary[w],saved:!state.vocabulary[w]?.saved};save();render();break;}case'speak-word':speak(el.dataset.word);break;case'source-year':sourceFilter.year=el.dataset.value;render();break;case'start-mock':startMock();break;case'single-mock':startMock(el.dataset.skill);break;case'play-audio':speak(q.transcript,speechRate());break;case'sentence-replay':playCurrentSentence();break;case'sentence-next':nextSentence();break;case'sentence-text':toggleSentenceText();break;case'stop-audio':stopPlayback();setMediaStatus('audio','idle','已停止。');break;case'record-start':startRecording();break;case'record-stop':if(recorder?.state==='recording')recorder.stop();break;case'prepare-speaking':prepareSpeaking();break;case'submit-answer':submit();break;case'self-rate':if(session.ratings[q.id]!==undefined){toast('本题自评已记录。');break;}session.ratings[q.id]=el.dataset.correct==='true';record(q,session.answers[q.id],session.ratings[q.id]);save();persistSession();toast('自评已记录，可继续下一题。');break;case'save-answer':setAnswer(readAnswer());toast('答案已保存。');break;case'next-question':next();break;case'toggle-reading-pane':toggleReadingPane();break;case'toggle-question-mark':toggleQuestionMark();break;case'question-filter':selectQuestionFilter(el.dataset.value);break;case'jump-question':setAnswer(readAnswer());move(Number(el.dataset.index));break;case'advance-stage':confirmAdvance();break;case'finish-session':ask('结束本次练习？','只统计已提交题目。草稿会保留在本机。',finish);break;case'exit-session':{const timed=Boolean(session.deadline);setAnswer(readAnswer());persistSession();session=null;clearInterval(timer);stopMedia();navigate('mock');toast(timed?'训练已保存，仿真倒计时仍继续。':'训练已保存，可从学习概览继续。');break;}case'resume':{const saved=resumableSession();if(!saved){toast('无法恢复，请重新开始训练。');break;}session=saved;renderSession();scrollToTop();startClock();break;}case'retry-wrong':start(el.dataset.ids.split(','),'review');break;case'discard-session':ask('丢弃未完成的训练？','已提交的学习记录会保留，未提交的本次答案将移除。',()=>{localStorage.removeItem(SESSION);render();});break;case'home':navigate('dashboard');break;case'go-review':navigate('review');break;case'calendar':calendar();break;case'export':download(`ielts-backup-${C.localDateKey()}.json`,JSON.stringify(state,null,2));break;case'export-bank':download('ielts-personal-bank.json',JSON.stringify(custom,null,2));break;}});
  document.addEventListener('input',e=>{if(e.target.id==='answer'){setAnswer(e.target.value);if($('#word-count'))$('#word-count').textContent=wordCount(e.target.value);}if(e.target.id==='question-search'){const pos=e.target.selectionStart;filter.search=e.target.value;render();$('#question-search').focus();$('#question-search').setSelectionRange(pos,pos);}});
  document.addEventListener('change',e=>{const t=e.target;if(t.name==='answer')setAnswer(t.value);if(t.id==='review-listening-material')changeReviewListening(t.value);if(t.id==='type-filter'){filter.type=t.value;render();}if(t.id==='origin-filter'){filter.origin=t.value;render();}if(t.id==='source-year'){sourceFilter.year=t.value;render();}if(t.id==='source-skill'){sourceFilter.skill=t.value;render();}if(t.id==='import-backup')importFile(t,false);if(t.id==='import-bank')importFile(t,true);});
  document.addEventListener('submit',e=>{if(e.target.id!=='settings-form')return;e.preventDefault();const f=new FormData(e.target);state.settings={...state.settings,module:f.get('module'),targetBand:Number(f.get('targetBand')),dailyGoal:Number(f.get('dailyGoal')),reminderTime:f.get('reminderTime'),remindersEnabled:f.has('remindersEnabled')};save();toast('学习计划已保存。');});
  document.addEventListener('click',e=>{
    if((!session&&!sentenceStudy)||e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
    const hash=e.target.closest('a[href^="#"]')?.hash;
    if(!hash||hash!==location.hash||!Object.hasOwn(PAGES,hash.slice(1)))return;
    // Clicking the current section does not dispatch hashchange.
    e.preventDefault();
    openRoute();
  });
  window.addEventListener('hashchange',openRoute);
  window.addEventListener('pagehide',()=>{persistSession();stopMedia();});
  function checkReminder(){if(!state.settings.remindersEnabled||session)return;const now=new Date(),[h,m]=state.settings.reminderTime.split(':').map(Number),done=todayRecords().reduce((s,r)=>s+r.answered,0);if(now.getHours()*60+now.getMinutes()>=h*60+m&&done<state.settings.dailyGoal&&checkReminder.last!==C.localDateKey()){checkReminder.last=C.localDateKey();toast(`到训练时间了，今天还差 ${state.settings.dailyGoal-done} 题，开始每日小练吧。`);}}
  try{render();}finally{dismissSplash();}
  setTimeout(checkReminder,1500);setInterval(checkReminder,60000);
  if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
