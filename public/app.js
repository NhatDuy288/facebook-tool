const $=id=>document.getElementById(id);
let current=null, dirty=false, formLoaded=false, selectedPost=null, requestBusy=false, disconnected=false;
const phases={idle:'Đã dừng',initializing:'Đang lấy mốc',ready:'Đã có mốc',watching:'Đang theo dõi',stopping:'Đang dừng',error:'Cần kiểm tra'};
const states={ready:'Chưa gửi',preparing:'Đang chuẩn bị',submitting:'Đang gửi',succeeded:'Thành công',failed:'Lỗi trước khi gửi',unknown:'Chưa rõ kết quả',cancelled:'Đã dừng',simulated:'Chỉ ghi nhận',skipped:'Đã tắt'};
const actionNames={like:'Like',share:'Share',comment:'Comment'};
function selectView(view){for(const name of ['overview','timing']){const active=name===view;$(name+'-panel').hidden=!active;$(name+'-tab').classList.toggle('active',active);$(name+'-tab').setAttribute('aria-selected',String(active));$(name+'-tab').tabIndex=active?0:-1}}
for(const name of ['overview','timing']){$(name+'-tab').onclick=()=>selectView(name);$(name+'-tab').onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'overview':e.key==='End'?'timing':name==='overview'?'timing':'overview';selectView(next);$(next+'-tab').focus()}}}
const durationSeconds=ms=>typeof ms==='number'&&Number.isFinite(ms)&&ms>=0?ms/1000:null;
const unmeasuredCodes=['ALREADY_LIKED','RECONCILED_EXISTING','MANUALLY_CONFIRMED'];
function actionProcessing(result){
  if(!result||unmeasuredCodes.includes(result.code))return {seconds:null,legacy:false};
  if(result.timing?.version===2)return {seconds:durationSeconds(result.timing.processingMs),legacy:false};
  const ms=Date.parse(result.finishedAt)-Date.parse(result.startedAt);
  return {seconds:durationSeconds(ms),legacy:durationSeconds(ms)!==null};
}
function timingForJob(job){
  const published=job.post.creation_time*1000,timing=job.timing?.version===2?job.timing:null;
  const origin=timing?.origin||job.origin||'unknown',calibrated=!!timing&&origin==='watch';
  const detection=calibrated?durationSeconds(timing.publicationDelayMs):null,actions={};
  for(const name of ['like','share','comment']){
    const a=job.actions.find(a=>a.name===name),at=a?.timing?.version===2?a.timing:null;
    const measured=a?.state==='succeeded'&&!unmeasuredCodes.includes(a.code);
    const processing=actionProcessing(a);
    actions[name]={seconds:calibrated&&measured?durationSeconds(at?.fromPublicationMs):null,state:a?.state||'ready',code:a?.code,processing:processing.seconds,legacyProcessing:processing.legacy,queue:durationSeconds(at?.queueMs),fromDetection:durationSeconds(at?.fromDetectionMs),fromRequest:durationSeconds(at?.fromRequestMs),uncertaintySeconds:durationSeconds(at?.uncertaintyMs),trace:at?.trace,preparation:at?.preparation};
  }
  const enabled=Object.entries(actions).filter(([,a])=>a.state!=='skipped');
  const complete=enabled.length>0&&enabled.every(([,a])=>a.state==='succeeded'&&a.seconds!==null);
  const total=complete?Math.max(...enabled.map(([,a])=>a.seconds)):null;
  const slowest=complete?enabled.filter(([,a])=>a.seconds===total).map(([name])=>name):[];
  const uncertaintySeconds=durationSeconds(timing?.uncertaintyMs);
  const uncertainties=enabled.map(([,a])=>a.uncertaintySeconds??uncertaintySeconds).filter(value=>value!==null);
  const totalUncertainty=complete&&uncertainties.length?Math.max(...uncertainties):null;
  const summary=origin==='existing-test'?'Thử bài có sẵn':!timing?'Thiếu dữ liệu đo':job.mode==='dry-run'?'Chỉ ghi nhận':!enabled.length?'Không bật thao tác':complete?slowest.map(name=>actionNames[name]).join(' / ')+' xong cuối':enabled.some(([,a])=>['failed','unknown','cancelled'].includes(a.state))?'Chưa hoàn tất':enabled.every(([,a])=>a.state==='succeeded')?'Thiếu dữ liệu đo':'Đang xử lý';
  return {published,detection,actions,total,slowest,summary,origin,calibrated,uncertaintySeconds,totalUncertainty,timing};
}
function secondsText(value){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)return '—';
  const rounded=Math.round(value*10)/10;
  if(rounded>=60){const minutes=Math.floor(rounded/60),seconds=Math.round((rounded%60)*10)/10;return minutes.toLocaleString('vi-VN')+' phút '+seconds.toLocaleString('vi-VN',{maximumFractionDigits:1})+' giây'}
  return rounded.toLocaleString('vi-VN',{minimumFractionDigits:1,maximumFractionDigits:1})+' giây';
}
const estimateText=value=>value===null?'—':'≈ '+secondsText(value);
function timingMissingText(t){return t.origin==='existing-test'?'Thử bài có sẵn':'Thiếu dữ liệu đo'}
const expandedTimingJobs=new Set();
const stageLabels={prepare_action:'Nhận nhánh và lưu trạng thái',navigate_original_post:'Tải bài gốc',verify_original_post:'Xác minh tài khoản và bài gốc',find_post_scope:'Tìm vùng bài viết',find_action_bar:'Tìm thanh Like / Share / Comment',check_existing_reaction:'Kiểm tra đã thích hay chưa',open_comment_editor:'Mở ô bình luận',fill_comment:'Điền bình luận',open_share_composer:'Mở hộp soạn chia sẻ',share_open_find_button:'Tìm nút chia sẻ',share_open_click_button:'Bấm mở chia sẻ',share_open_wait_surface:'Chờ hộp soạn hoặc menu chia sẻ',share_open_click_feed:'Chọn chia sẻ lên bảng feed',share_open_wait_editor:'Chờ ô soạn chia sẻ sẵn sàng',share_menu_fallback:'Mở hộp soạn qua menu chia sẻ',verify_share_destination:'Xác minh đích chia sẻ',set_share_audience:'Kiểm tra và chọn đối tượng chia sẻ',fill_share:'Điền nội dung chia sẻ',verify_share_before_submit:'Kiểm tra chia sẻ trước khi gửi',prepare_submission:'Kiểm tra tài khoản và lưu ý định gửi',submit:'Bấm gửi / nhấn Enter',wait_server:'Chờ và đọc phản hồi Facebook',verify_like:'Kiểm tra nút đã thích',comment_readback_open_tab:'Mở tab kiểm tra bình luận',comment_readback_navigate:'Tải lại bài để tìm bình luận',comment_readback_verify:'Xác minh bài khi đọc lại',comment_readback_scope:'Tìm vùng bài khi đọc lại',comment_readback_wait:'Chờ bình luận hiển thị',comment_readback_find:'Tìm và xác nhận bình luận đã đăng',share_verify_response:'Xác minh chia sẻ từ phản hồi',share_verify_current_page:'Xác minh chia sẻ trên trang hiện có',share_readback_navigate:'Tải bài vừa chia sẻ',share_readback_verify:'Xác minh bài chia sẻ thuộc tài khoản',share_readback_scope:'Tìm vùng bài vừa chia sẻ',share_readback_audience:'Xác minh đối tượng bài đã chia sẻ',cleanup:'Dọn dẹp nhánh'};
function traceDuration(ms){return durationSeconds(ms)===null?'—':ms<1000?ms.toLocaleString('vi-VN',{maximumFractionDigits:1})+' ms':(ms/1000).toLocaleString('vi-VN',{maximumFractionDigits:3})+' giây'}
function traceMilestone(t,a,offset){
  if(durationSeconds(offset)===null)return '—';
  if(t.detection!==null&&a.queue!==null)return estimateText(t.detection+a.queue+offset/1000)+' từ lúc đăng';
  if(t.origin==='existing-test'&&a.queue!==null)return secondsText(a.queue+offset/1000)+' từ lúc bấm thử';
  return traceDuration(offset)+' từ đầu nhánh';
}
function renderActionTrace(name,t){
  const a=t.actions[name],trace=a.trace,section=el('section','action-trace');section.dataset.action=name;
  section.append(el('strong','trace-title',actionNames[name]+' · '+states[a.state]));
  if(!trace||trace.version!==1){section.append(el('p','muted small','Lượt này chưa có dữ liệu đo từng bước.'));return section}
  const marks=trace.milestones||{},server=marks.serverConfirmed,ack=marks.serverAcknowledged;
  const grid=el('div','trace-milestones');
  const verified=a.state==='succeeded'&&!unmeasuredCodes.includes(a.code)?trace.finishedMs:null;
  for(const [label,offset] of [['Bắt đầu bấm gửi',marks.submitStarted],[server===undefined&&ack!==undefined?'Facebook phản hồi · cần kiểm tra':'Facebook xác nhận',server??ack],['Tool xác minh xong',verified]]){
    const metric=el('div');metric.append(el('span','muted small',label),el('strong','',traceMilestone(t,a,offset)));grid.append(metric);
  }
  section.append(grid);
  if(server===undefined&&ack!==undefined)section.append(el('p','trace-note small','Phản hồi chưa đủ bằng chứng. Tool cần đọc lại kết quả trước khi xác nhận thành công.'));
  if(durationSeconds(verified)!==null&&durationSeconds(server??ack)!==null)section.append(el('p','trace-note small','Từ phản hồi Facebook đến xác minh xong: '+traceDuration(Math.max(0,verified-(server??ack)))));
  section.append(el('p','muted small','Thời gian bước là khoảng riêng của bước đó. Cột cuối cộng dồn từ lúc nhánh bắt đầu; các nhánh chạy song song.'));
  const table=el('table','trace-table'),head=el('thead'),headers=el('tr');
  for(const label of ['Bước','Thời gian bước','Đến mốc từ đầu nhánh'])headers.append(el('th','',label));head.append(headers);table.append(head);
  const body=el('tbody'),steps=Array.isArray(trace.steps)?trace.steps:[];
  const longest=steps.length?Math.max(...steps.map(step=>Math.max(0,step.endMs-step.startMs))):0;
  for(const step of steps){
    const duration=Math.max(0,step.endMs-step.startMs),tr=el('tr',duration===longest&&longest>0?'trace-longest':'');
    const label=el('td','',stageLabels[step.stage]||'Bước xử lý');
    if(step.status!=='completed')label.append(el('span','timing-detail',step.status==='running'&&['preparing','submitting'].includes(a.state)?'Đang chạy':'Bị gián đoạn'));
    tr.append(label,el('td','',traceDuration(duration)),el('td','',traceDuration(step.endMs)));body.append(tr);
  }
  table.append(body);section.append(table);return section;
}
function renderTimingDetails(job,t){
  const row=el('tr','timing-diagnostics-row'),cell=el('td'),details=el('details','timing-diagnostics');cell.colSpan=7;
  details.open=expandedTimingJobs.has(job.id);details.ontoggle=()=>{if(details.open)expandedTimingJobs.add(job.id);else expandedTimingJobs.delete(job.id)};
  details.append(el('summary','','Chi tiết: từng bước, Facebook xác nhận và tool xác minh xong'));
  const note=t.origin==='existing-test'?'Đây là lần thử trên bài có sẵn. Tính thời gian từ lúc bấm thử; không dùng lần thử này để đo tốc độ phát hiện bài mới.':!t.timing?'Lượt cũ thiếu dữ liệu hiệu chỉnh đồng hồ. Các số đo từ lúc đăng bài được để trống để tránh báo sai.':'Các khoảng xử lý bên dưới được đo trực tiếp, không bị ảnh hưởng bởi lệch giờ máy với Facebook.';
  details.append(el('p','muted small',note));
  if(t.timing){
    const grid=el('div','timing-read-metrics');
    for(const [label,ms] of [['Đọc danh sách bài',t.timing.readDurationMs],['Khoảng cách hai lượt đọc',t.timing.readIntervalMs],['Chờ thực tế trước lượt đọc',t.timing.pollWaitMs],['Cấu hình chờ',typeof t.timing.pollSeconds==='number'?t.timing.pollSeconds*1000:null]]){const metric=el('div');metric.append(el('span','muted small',label),el('strong','',secondsText(durationSeconds(ms))));grid.append(metric)}
    details.append(grid);
    const preparation=Object.values(t.actions).find(a=>a.preparation)?.preparation;
    if(preparation){const setup=el('div','timing-read-metrics');for(const [label,ms] of [['Hoàn tất lượt đọc sau phát hiện',preparation.readRemainderMs],['Chờ giao việc',preparation.dispatchWaitMs],['Chuẩn bị các tab',preparation.tabsMs]]){const metric=el('div');metric.append(el('span','muted small',label),el('strong','',traceDuration(ms)));setup.append(metric)}details.append(setup)}
    const offset=t.timing.clockOffsetMs;
    if(typeof offset==='number'&&Number.isFinite(offset))details.append(el('p','timing-clock-note small',Math.abs(offset)<1000?'Giờ máy đã khớp gần với Facebook.':'Giờ máy '+(offset<0?'nhanh hơn':'chậm hơn')+' Facebook '+secondsText(Math.abs(offset)/1000)+'. Đã hiệu chỉnh khi tính từ lúc đăng bài.'));
  }
  const table=el('table','timing-action-details'),head=el('thead'),headers=el('tr');
  for(const text of ['Thao tác','Chờ trước thao tác','Xử lý thao tác',t.origin==='existing-test'?'Từ lúc bấm thử':'Từ lúc phát hiện'])headers.append(el('th','',text));head.append(headers);table.append(head);
  const body=el('tbody');
  for(const name of ['like','share','comment']){const a=t.actions[name],tr=el('tr');tr.append(el('td','',actionNames[name]),el('td','',secondsText(a.queue)));const processing=el('td','',secondsText(a.processing));if(a.legacyProcessing)processing.append(el('span','timing-detail','Dữ liệu cũ · tính bằng giờ máy'));tr.append(processing,el('td','',secondsText(t.origin==='existing-test'?a.fromRequest:a.fromDetection)));body.append(tr)}
  table.append(body);details.append(table);
  for(const name of ['like','share','comment'])if(!['skipped','simulated'].includes(t.actions[name].state))details.append(renderActionTrace(name,t));
  cell.append(details);row.append(cell);return row;
}
function renderTimings(s){
  const root=$('timing-rows');root.replaceChildren();$('timing-count').textContent=s.jobs.length+' lượt xử lý';
  if(!s.jobs.length){const tr=el('tr'),td=el('td','empty','Chưa có bài được ghi nhận. Bài mới sẽ xuất hiện khi tool phát hiện.');td.colSpan=7;tr.append(td);root.append(tr);return}
  for(const job of s.jobs){
    const t=timingForJob(job),tr=el('tr','timing-job-row'),post=el('td'),link=el('a','',job.post.post_id);
    link.href=job.post.permalink||`https://www.facebook.com/permalink.php?story_fbid=${job.post.post_id}&id=${job.sourceId}`;link.target='_blank';link.rel='noreferrer';post.append(link,el('span','timing-detail',(Object.values(s.sources||{}).find(source=>source.sourceId===job.sourceId)?.name||job.sourceId)+' · '+(job.mode==='dry-run'?'Chỉ ghi nhận':job.mode==='test'?'Chia sẻ Chỉ mình tôi':'Chia sẻ Công khai')),el('span','timing-origin',t.origin==='watch'?'Bài mới khi theo dõi':t.origin==='existing-test'?'Thử bài có sẵn':'Lượt cũ · thiếu phép đo'));
    const published=el('td','timing-date',Number.isFinite(t.published)&&t.published>0?new Date(t.published).toLocaleString('vi-VN'):'—');
    const detected=el('td',t.detection===null?'timing-unavailable':'timing-number',t.detection===null?timingMissingText(t):estimateText(t.detection));
    tr.append(post,published,detected);
    for(const name of ['like','share','comment']){const a=t.actions[name],td=el('td',(a.seconds===null?'timing-unavailable':'timing-number')+(t.slowest.includes(name)?' timing-slowest':''),a.seconds===null?'—':estimateText(a.seconds));let detail=a.seconds!==null?'Đã xác nhận':a.state==='skipped'?'Đã tắt':a.state==='simulated'?'Chỉ ghi nhận':a.code==='ALREADY_LIKED'?'Đã thích từ trước':t.origin==='existing-test'?'Thử bài có sẵn':a.state==='succeeded'?'Thiếu dữ liệu đo':states[a.state];td.append(el('span','timing-detail',detail));tr.append(td)}
    const total=el('td','timing-total'+(t.total===null?' timing-unavailable':''),estimateText(t.total));total.append(el('span','timing-detail',t.summary));tr.append(total);root.append(tr,renderTimingDetails(job,t));
  }
}
const actionErrors={UI_UNSUPPORTED:'Giao diện chưa được nhận diện',AUDIENCE_UNVERIFIED:'Chưa xác minh quyền riêng tư',DESTINATION_UNVERIFIED:'Chưa xác minh đích chia sẻ',POST_UNVERIFIED:'Chưa xác minh bài gốc',REACTION_UNVERIFIED:'Cần kiểm tra cảm xúc hiện có',READ_FAILED:'Chưa kết nối hoặc đọc được giao diện',LOGIN_REQUIRED:'Cần đăng nhập lại',ACTOR_CHANGED:'Tài khoản đã thay đổi'};
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function toast(text,error=false){$('toast').hidden=false;$('toast').textContent=text;$('toast').className=error?'error':'';setTimeout(()=>{$('toast').hidden=true},7000)}
async function api(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Tool-Key':window.toolKey,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const json=await r.json();if(!r.ok)throw Error(json.message||'Không thực hiện được yêu cầu.');return json}
async function saveConfig(){const c=readForm();if(c.mode==='live'&&current?.config.mode!=='live'&&!confirm('Bật chế độ thực tế: chia sẻ công khai và gửi các thao tác đang bật lên bài mới của nguồn đã chọn?'))return false;const result=await api('/api/config',c);if(JSON.stringify(readForm())!==JSON.stringify(c))throw Error('Cấu hình vừa thay đổi trong lúc lưu. Hãy thử lại.');if(current)current.config=result.config;loadForm(result.config);return true}
async function command(action,extra={}){if(requestBusy&&action!=='stop')return;requestBusy=true;try{if(['baseline','start'].includes(action)&&dirty&&!await saveConfig())return;const result=await api('/api/command',{action,...extra});if(action==='reconcile')toast(result.confirmed?'Đã đọc lại và xác nhận kết quả. Không gửi thêm.':'Chưa xác nhận được kết quả. Hãy kiểm tra Facebook trước khi thử lại.',!result.confirmed);await refresh()}catch(e){toast(e.message,true)}finally{requestBusy=false}}
function readForm(){return{version:1,target:$('target').value,mode:$('mode').value,pollSeconds:Number($('poll-seconds').value),keepSession:$('keep-session').checked,comments:$('comments').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),shareText:$('share-text').value,hashtags:$('hashtags').value.trim().split(/\s+/).filter(Boolean),actions:{like:$('enable-like').checked,share:$('enable-share').checked,comment:$('enable-comment').checked}}}
function loadForm(c){$('target').value=c.target;$('mode').value=c.mode;$('poll-seconds').value=c.pollSeconds;$('keep-session').checked=c.keepSession;$('comments').value=c.comments.join('\n');$('share-text').value=c.shareText;$('hashtags').value=c.hashtags.join(' ');for(const a of Object.keys(c.actions))$('enable-'+a).checked=c.actions[a];formLoaded=true;dirty=false;updateFormHint()}
function updateSourceLink(){$('source-url').href=$('target').selectedOptions[0].dataset.url}
function updateFormHint(){updateSourceLink();const mode=$('mode').value;$('mode-note').textContent=mode==='dry-run'?'Chạy thử chỉ ghi lại nội dung dự kiến, chưa gửi Like, Share hay Comment.':mode==='test'?'Chia sẻ: Chỉ mình tôi. Like và Comment hiển thị theo quyền xem của bài gốc.':'Chia sẻ: Công khai. Like và Comment hiển thị trên bài gốc.';$('mode-note').classList.toggle('live',mode==='live');$('saved').textContent=dirty?'Có thay đổi chưa lưu':'Đã lưu';$('saved').classList.toggle('pending',dirty)}
$('config-form').addEventListener('input',()=>{dirty=true;updateFormHint()});$('config-form').addEventListener('change',()=>{dirty=true;updateFormHint()});
$('config-form').addEventListener('submit',async e=>{e.preventDefault();if(requestBusy)return;requestBusy=true;try{if(!await saveConfig())return;toast('Đã lưu. Nội dung mới áp dụng cho công việc tiếp theo.');await refresh()}catch(e){toast(e.message,true)}finally{requestBusy=false}});
$('login').onclick=()=>command('login');$('baseline').onclick=()=>command('baseline');$('start').onclick=()=>command('start');$('stop').onclick=()=>command('stop');$('shutdown').onclick=()=>command('shutdown');
$('test-existing').onclick=()=>{if(dirty)return toast('Hãy lưu cấu hình trước khi thử.',true);if(!selectedPost)return toast('Chọn một bài trong danh sách trước.',true);if(confirm('Gửi các thao tác đang bật lên bài test '+selectedPost+'? Chia sẻ sẽ đặt Chỉ mình tôi.'))command('test_existing',{postId:selectedPost})};
function renderPosts(s){$('window-note').textContent=s.readWindow?.expanded?'Hiển thị 3 bài theo giờ đăng; lượt vừa rồi kiểm tra mở rộng để đối chiếu thứ tự/bài ghim hoặc nổi bật.':'Mỗi lần Bắt đầu lấy mốc mới. Bài có sẵn và bài trong lúc tắt tool được bỏ qua.';$('window-count').textContent=s.posts.length+' / '+(s.windowSize||3);const body=$('posts');body.replaceChildren();if(!s.posts.length){const tr=el('tr');const td=el('td','empty','Chưa lấy mốc.');td.colSpan=3;tr.append(td);body.append(tr);return}if(!s.posts.some(p=>p.post_id===selectedPost))selectedPost=s.posts[0].post_id;for(const p of s.posts){const tr=el('tr'),id=el('td'),a=el('a','',p.post_id);a.href=p.permalink||`https://www.facebook.com/permalink.php?story_fbid=${p.post_id}&id=${s.source.sourceId}`;a.target='_blank';a.rel='noreferrer';id.append(a);const choice=el('td'),radio=el('input');radio.type='radio';radio.name='test-post';radio.checked=p.post_id===selectedPost;radio.setAttribute('aria-label','Chọn bài '+p.post_id);radio.onchange=()=>{selectedPost=p.post_id};choice.append(radio);tr.append(id,el('td','muted',new Date(p.creation_time*1000).toLocaleString('vi-VN')),choice);body.append(tr)}}
function renderJobs(s){
  const root=$('jobs');root.replaceChildren();if(!s.jobs.length){root.append(el('div','empty','Chưa có công việc. Công việc mới xuất hiện khi phát hiện bài hợp lệ.'));return}
  for(const j of s.jobs){
    const t=timingForJob(j),card=el('div','job'),head=el('div','job-head'),a=el('a','','Bài '+j.post.post_id);
    a.href=j.post.permalink||`https://www.facebook.com/permalink.php?story_fbid=${j.post.post_id}&id=${j.sourceId}`;a.target='_blank';a.rel='noreferrer';
    const localRecorded=Date.parse(t.timing?.detectedAt||t.timing?.requestedAt||j.createdAt),offset=t.timing?.clockOffsetMs;
    const aligned=typeof offset==='number'&&Number.isFinite(offset);
    const recorded=Number.isFinite(localRecorded)?new Date(localRecorded+(aligned?offset:0)).toLocaleString('vi-VN'):'—';
    head.append(a,el('span','muted',(t.origin==='existing-test'?'Bấm thử: ':'Ghi nhận: ')+recorded+(aligned?'':' (giờ máy)')));card.append(head);
    if(t.origin==='existing-test')card.append(el('div','job-timing-note','Thử bài có sẵn · đo từ lúc bấm thử, không đo phát hiện bài mới.'));
    if(!t.timing)card.append(el('div','job-timing-note','Lượt cũ thiếu dữ liệu đo từ lúc đăng bài.'));
    card.append(el('div','job-content','Bình luận: '+(j.plan.comment??'Đã tắt')+' · Chia sẻ: '+j.plan.share));
    const actions=el('div','job-actions');
    for(const result of j.actions){
      const at=t.actions[result.name],box=el('div','action-result');box.append(el('strong','',actionNames[result.name]),el('span','state '+result.state,states[result.state]));
      if(result.code){const info=el('span','muted small',result.code==='ALREADY_LIKED'?'Đã thích từ trước':result.code==='MANUALLY_CONFIRMED'?'Đã kiểm tra thủ công':result.state==='unknown'?'Kiểm tra Facebook trước khi gửi lại':result.state==='failed'?(actionErrors[result.code]||'Cần kiểm tra Facebook'):'');box.append(info)}
      if(at.processing!==null)box.append(el('span','muted small','Xử lý thao tác: '+secondsText(at.processing)+(at.legacyProcessing?' (dữ liệu cũ · giờ máy)':'')));
      if(at.seconds!==null)box.append(el('span','action-publication small','Từ lúc đăng: '+estimateText(at.seconds)));
      else if(t.origin==='existing-test'&&at.fromRequest!==null)box.append(el('span','action-publication small','Từ lúc bấm thử: '+secondsText(at.fromRequest)));
      if(result.externalUrl){const link=el('a','small','Xem kết quả ↗');link.href=result.externalUrl;link.target='_blank';link.rel='noreferrer';box.append(link)}
      if(result.state==='unknown'){
        const check=el('button','secondary','Đối soát với Facebook');check.disabled=['watching','initializing','stopping'].includes(s.phase)||!!s.activeJob;check.onclick=()=>command('reconcile',{jobId:j.id,name:result.name});box.append(check);
        for(const [label,outcome] of [['Đã kiểm tra: thành công','done'],['Đã kiểm tra: chưa gửi','not_sent']]){const b=el('button','secondary',label);b.disabled=['watching','initializing','stopping'].includes(s.phase)||!!s.activeJob;b.onclick=()=>{if(confirm(outcome==='done'?'Bạn đã xác nhận thao tác này thành công trên Facebook?':'Bạn đã kiểm tra chắc chắn thao tác này chưa gửi? Sau đó có thể tiếp tục phần chưa gửi.'))command('resolve',{jobId:j.id,name:result.name,result:outcome})};box.append(b)}
      }
      actions.append(box);
    }
    card.append(actions);if(j.actions.some(a=>['ready','failed','cancelled'].includes(a.state))&&j.mode!=='dry-run'){const b=el('button','secondary job-resume','Tiếp tục phần chưa gửi');b.disabled=s.activeJob===j.id||!['ready','watching'].includes(s.phase)||j.accountId!==s.account?.id||j.sourceId!==s.source.sourceId||j.mode!==s.config.mode;b.onclick=()=>command('resume',{jobId:j.id});card.append(b)}root.append(card);
  }
}
function render(s){renderTimings(s);current=s;if(!formLoaded||!dirty&&JSON.stringify(readForm())!==JSON.stringify(s.config))loadForm(s.config);const busy=['watching','initializing','stopping'].includes(s.phase)||!!s.activeJob;$('phase').className='pill '+s.phase;$('phase').textContent=phases[s.phase]||s.phase;$('note').textContent=s.note;$('account').textContent=s.account?`Tài khoản theo dõi: ${s.account.name||s.account.id} · ID ${s.account.id}`:'Chưa xác minh tài khoản theo dõi';updateSourceLink();$('reads').textContent=s.metrics.reads+' / '+s.metrics.queries;$('latency').textContent=s.metrics.lastQueryMs===null?'—':s.metrics.lastQueryMs+' ms';$('bytes').textContent=(s.metrics.decodedBytes/1048576).toFixed(1)+' MB';$('last-read').textContent=s.lastReadAt?new Date(s.lastReadAt).toLocaleTimeString('vi-VN'):'—';$('next-comment').textContent=s.nextComment||'Nhánh bình luận đang tắt';$('share-preview').textContent=[s.config.shareText,s.config.hashtags.join(' ')].filter(Boolean).join('\n');$('audience-preview').textContent=s.config.mode==='live'?'Đối tượng chia sẻ: Công khai':s.config.mode==='test'?'Đối tượng chia sẻ: Chỉ mình tôi':'Chỉ ghi nhận, chưa đăng chia sẻ';$('baseline').disabled=busy||s.closing;$('start').disabled=busy||s.closing;$('stop').disabled=s.closing||s.phase==='stopping';for(const id of ['target','mode','keep-session'])$(id).disabled=busy;$('test-controls').hidden=!(s.phase==='ready'&&s.config.target==='test-profile'&&s.config.mode==='test');$('test-existing').disabled=busy;$('queue').textContent=s.activeJob?'Đang xử lý · '+s.queuedJobs+' việc chờ':s.queuedJobs?s.queuedJobs+' việc chờ':'';$('runtime-info').textContent='Node: '+s.metrics.nodeMemoryMB+' MB (chưa gồm Chrome).';renderPosts(s);renderJobs(s);const logs=$('logs');logs.replaceChildren();for(const l of s.logs){const line=el('div','log '+l.level),time=el('time','',new Date(l.at).toLocaleTimeString('vi-VN'));time.title=new Date(l.at).toLocaleString('vi-VN');line.append(time,el('span','',l.text));logs.append(line)}if(s.closing){$('note').textContent='Tool đang đóng. Phiên đăng nhập và cấu hình đã lưu trên laptop.'}}
async function refresh(){try{const s=await api('/api/status');if(s.closing&&!s.config){$('phase').textContent='Đang đóng';$('note').textContent='Tool đang đóng. Phiên đăng nhập và cấu hình đã lưu trên laptop.';return}render(s);if(disconnected){disconnected=false;toast('Đã kết nối lại với tool.')}}catch(e){if(!disconnected){disconnected=true;$('phase').textContent='Mất kết nối';$('phase').className='pill error';$('note').textContent='Không kết nối được tiến trình tool. Mở lại Start-Tool.cmd nếu đã đóng.'}}}
refresh();setInterval(refresh,2000);
