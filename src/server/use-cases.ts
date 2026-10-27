// A browser-only teaching sandbox. These are pretend inputs, not live sessions.
export const USE_CASE_STYLES = `
[hidden]{display:none!important}
.nav-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.page-tabs{border:0;padding:4px;background:var(--paper);border-radius:16px}
.page-panel{display:flex;flex-direction:column;gap:88px;min-width:0}
.wrap:has(#page-use-cases:not([hidden])){gap:36px}
.learn-link{display:inline-block;margin-top:18px;font-weight:800;text-underline-offset:4px}
.learn-intro{max-width:760px;display:flex;flex-direction:column;gap:16px}
.learn-intro h1{font-size:clamp(34px,4vw,48px)}
.learn-intro .eyebrow{align-self:flex-start;margin:0}
.learn-intro p{font-size:20px;color:var(--muted);max-width:60ch}
.learn-panel{gap:30px}
.practice-note{padding:16px 20px;border-radius:18px;background:var(--sky);font-size:16px}
.practice-note strong{display:block;color:var(--ink)}
.practice-note p{color:var(--muted)}
.case-shell{background:var(--paper);border:2px solid var(--line);border-radius:26px;overflow:hidden}
.case-tabs{padding:12px;gap:8px}
.case-tabs button{font-size:16px;padding:12px 18px}
.case-content{padding:clamp(18px,3vw,34px);display:flex;flex-direction:column;gap:28px}
.case-heading{display:flex;flex-direction:column;gap:10px;max-width:68ch}
.case-heading p{color:var(--muted)}
.learn-step{display:flex;align-items:center;gap:10px;font:600 21px var(--display);margin-bottom:14px}
.secret-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.secret-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.secret-card{background:var(--sky);border:2px solid transparent;border-radius:20px;padding:20px;min-width:0}
.secret-card.friend{background:var(--lilac)}
.secret-card.third{background:var(--wax-soft)}
.secret-card h3{margin-bottom:12px}
.secret-card label{display:block;font-size:16px;font-weight:700}
.secret-card small{display:block;color:var(--muted);font-size:14px;margin-top:10px}
.money-control{display:flex;align-items:center;gap:5px;font:600 32px var(--display);margin-top:8px}
.money-control input{width:130px;max-width:100%;font:inherit;background:var(--paper);color:var(--ink);border:2px solid var(--line);border-radius:12px;padding:8px 10px}
.case-content input:focus-visible,.case-content select:focus-visible,.try-buttons button:focus-visible{outline:3px solid var(--wax);outline-offset:3px}
.case-content [aria-invalid="true"]{border-color:var(--wax)}
.question-card{border:2px dashed var(--wax);border-radius:20px;padding:20px}
.question-card p{font-size:20px;font-weight:700}
.question-card .money-control{font-size:26px}
.try-buttons{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.try-buttons button{font:700 14px var(--body);background:var(--paper);color:var(--ink);border:2px solid var(--line);border-radius:99px;padding:7px 14px;cursor:pointer}
.answer-card{padding:22px;background:var(--mint-soft);border-radius:20px;border:2px solid var(--mint)}
.answer-card[data-outcome="no"]{background:var(--wax-soft);border-color:var(--wax)}
.answer-card[data-outcome="pending"]{background:var(--bg);border-color:var(--line)}
.answer-card .answer{font:600 clamp(23px,3vw,30px)/1.2 var(--display);margin-bottom:10px}
.answer-card .shared-note{font-size:15px;color:var(--muted)}
.teaching{margin-top:16px;padding:0 2px;display:flex;flex-direction:column;gap:6px}
.teaching h3{font:800 16px var(--body)}
.teaching p{color:var(--muted)}
.try-next{font-size:16px;background:var(--bg);padding:12px 16px;border-radius:14px}
.real-life{border-top:2px solid var(--line);padding-top:18px;font-size:16px;color:var(--muted)}
.real-life strong{color:var(--ink)}
.time-fields{display:flex;gap:12px;flex-wrap:wrap}
.time-fields label{flex:1;min-width:90px}
.time-fields select{display:block;width:100%;margin-top:6px;padding:10px 8px;border:2px solid var(--line);border-radius:12px;font:700 17px var(--body);background:var(--paper);color:var(--ink)}
.lunch-options{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.lunch-options span{background:var(--bg);border-radius:12px;padding:8px 12px;font-weight:700}
.learn-bottom{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.learn-bottom .card{gap:12px}
.learn-bottom ol{padding-left:22px;margin:0;color:var(--muted);display:flex;flex-direction:column;gap:8px}
@media(max-width:650px){nav{align-items:flex-start;flex-wrap:wrap}.nav-actions{gap:8px}.page-tabs button{padding:8px 10px}.secret-grid,.secret-grid.three,.learn-bottom{grid-template-columns:1fr}.case-tabs button{flex:1;padding:10px 8px;font-size:14px}.learn-intro p{font-size:18px}}
`;

function money(id: string, label: string, value: number) {
  return `<label for="${id}">${label}</label><div class="money-control"><span aria-hidden="true">$</span><input id="${id}" type="number" min="1" max="1000" step="1" value="${value}" aria-label="${label}, in dollars" inputmode="numeric"></div>`;
}
function time(id: string, label: string, value: number) {
  return `<label for="${id}">${label}<select id="${id}">${[12,13,14,15,16,17,18].map(h => `<option value="${h}"${h === value ? " selected" : ""}>${h === 12 ? 12 : h - 12} pm</option>`).join("")}</select></label>`;
}
function answer(id: string, note: string) {
  return `<div><div class="learn-step"><span class="num">3</span>What everyone gets back</div>
    <div class="answer-card" id="${id}-card" role="status" aria-live="polite" aria-atomic="true"><p class="answer" id="${id}-answer"></p><p class="shared-note">${note}</p></div>
    <div class="teaching"><h3>Why? A peek behind the curtain, just for learning.</h3><p id="${id}-why"></p></div></div>`;
}

export function useCasesHtml() {
  return `<div class="learn-intro"><span class="eyebrow">Sealed, explained simply</span><h1>Two secrets.<br>One useful answer.</h1><p>Your AI is your helper. Your friend has a helper too. Sealed lets them answer a question together without swapping all your private details.</p></div>
  <div class="practice-note"><strong>This is a pretend playground.</strong><p>You can see everyone's numbers here so you can learn. In real life, each person keeps their own secret. Nothing here sends a message, buys a toy or books a plan.</p></div>
  <div class="case-shell">
    <div class="tabs case-tabs" role="tablist" aria-label="Choose an example">
      <button type="button" role="tab" id="tab-toy" aria-controls="case-toy" aria-selected="true" tabindex="0">Buy a toy</button>
      <button type="button" role="tab" id="tab-time" aria-controls="case-time" aria-selected="false" tabindex="-1">Find playtime</button>
      <button type="button" role="tab" id="tab-lunch" aria-controls="case-lunch" aria-selected="false" tabindex="-1">Lunch with friends</button>
    </div>
    <section class="case-content" role="tabpanel" id="case-toy" aria-labelledby="tab-toy">
      <div class="case-heading"><h2>Can I buy Sam's toy?</h2><p>You want Sam's toy. You don't want to say your biggest budget. Sam doesn't want to say the lowest price they'll accept. So you check one price together.</p></div>
      <div><div class="learn-step"><span class="num">1</span>Each person has a secret</div><div class="secret-grid">
        <div class="secret-card"><h3>Your pretend secret</h3>${money("toy-max", "Most you would pay", 10)}<small>You tell your helper: “Don't spend more than this.”</small></div>
        <div class="secret-card friend"><h3>Sam's pretend secret</h3>${money("toy-min", "Least Sam would accept", 6)}<small>Sam tells their helper: “Don't sell for less than this.”</small></div>
      </div></div>
      <div><div class="learn-step"><span class="num">2</span>Ask one question</div><div class="question-card"><p id="toy-question">Would $8 work for both of us?</p>${money("toy-price", "Price to check", 8)}<div class="try-buttons"><button type="button" data-preset="toy-yes">Try $8: yes</button><button type="button" data-preset="toy-no">Try $12: no</button></div></div></div>
      ${answer("toy", "Both learn whether this price works. Neither gets the other's exact secret number. A yes does not buy the toy.")}
      <p class="try-next"><strong>Your turn:</strong> With secrets of $10 and $6, would $5 work? Change the price and see.</p>
      <p class="real-life"><strong>In real life:</strong> Your AI and a seller's AI could check a price for a used bike or a design job. They check the price you chose; Sealed does not pick the “best” price.</p>
    </section>
    <section class="case-content" role="tabpanel" id="case-time" aria-labelledby="tab-time" hidden>
      <div class="case-heading"><h2>When can we play for one hour?</h2><p>You and Sam have busy afternoons. Your helpers need one time that works for both of you. They don't need to share everything else on your calendars.</p></div>
      <div><div class="learn-step"><span class="num">1</span>Each person has some free time</div><div class="secret-grid">
        <div class="secret-card"><h3>Your pretend free time</h3><div class="time-fields">${time("time-a-start", "You: from", 14)}${time("time-a-end", "You: until", 16)}</div><small>Other plans on your calendar stay yours.</small></div>
        <div class="secret-card friend"><h3>Sam's pretend free time</h3><div class="time-fields">${time("time-b-start", "Sam: from", 15)}${time("time-b-end", "Sam: until", 17)}</div><small>Sam doesn't have to say why other times are busy.</small></div>
      </div></div>
      <div><div class="learn-step"><span class="num">2</span>Ask one question</div><div class="question-card"><p>What's the first whole hour we can both play today?</p><div class="try-buttons"><button type="button" data-preset="time-yes">Try a shared hour</button><button type="button" data-preset="time-no">Try no shared hour</button></div></div></div>
      ${answer("time", "Both get one shared time, or “no time found.” They don't get each other's full free-time list. Nothing is booked.")}
      <p class="try-next"><strong>Your turn:</strong> Move Sam's start to 4 pm. Is there still a whole hour before you finish at 4 pm?</p>
      <p class="real-life"><strong>In real life:</strong> Your AI and your friend's AI could find a time for dinner, a meeting or a call without sharing your full calendars.</p>
    </section>
    <section class="case-content" role="tabpanel" id="case-lunch" aria-labelledby="tab-lunch" hidden>
      <div class="case-heading"><h2>Which lunch can all three of us afford?</h2><p>You, Sam and Jo want lunch together. Nobody wants to announce how much money they have. Your helpers check the menu against all three budgets.</p></div>
      <div><div class="learn-step"><span class="num">1</span>Everyone has a secret budget</div><div class="secret-grid three">
        <div class="secret-card"><h3>You</h3>${money("lunch-you", "Your lunch budget", 10)}</div>
        <div class="secret-card friend"><h3>Sam</h3>${money("lunch-sam", "Sam's lunch budget", 8)}</div>
        <div class="secret-card third"><h3>Jo</h3>${money("lunch-jo", "Jo's lunch budget", 6)}</div>
      </div></div>
      <div><div class="learn-step"><span class="num">2</span>Ask one question</div><div class="question-card"><p>Which choices fit everyone's budget?</p><div class="lunch-options"><span>Sandwich · $5 each</span><span>Pizza · $8 each</span><span>Sushi · $12 each</span></div><div class="try-buttons"><button type="button" data-preset="lunch-more">Give everyone $15</button><button type="button" data-preset="lunch-none">Give Jo only $3</button><button type="button" data-preset="lunch-reset">Start again</button></div></div></div>
      ${answer("lunch", "Everyone gets the choices that fit. The answer doesn't list anybody's budget. Nobody places an order.")}
      <p class="try-next"><strong>Your turn:</strong> Start again, then give Jo $8. Does pizza fit everyone now?</p>
      <p class="real-life"><strong>In real life:</strong> A group's AIs could compare restaurants, hotels or birthday gifts without posting everyone's spending limit in a group chat.</p>
    </section>
  </div>
  <div class="learn-bottom">
    <div class="card"><h3>What do the AI helpers do?</h3><ol><li>You tell your helper what you want and your limit.</li><li>Your friend does the same with their helper.</li><li>The helpers send locked answers to Sealed's checker, called the sealer.</li><li>The checker sends back the small answer. You decide what to do next.</li></ol></div>
    <div class="card"><h3>Who can see the secrets?</h3><p>The checker opens them to do the maths. Today, Sealed runs that checker, so you must trust it. It sends the answer back without sending everyone the original secrets.</p><p>An answer still gives a clue: “yes to $8” tells Sam you can pay at least $8. That is why real Sealed limits repeated questions.</p></div>
  </div>`;
}

export const USE_CASE_SCRIPT = `
const el = (id) => document.getElementById(id);
const dollars = (n) => '$' + n;
const hour = (h) => (h === 12 ? 12 : h - 12) + ' pm';
function moneyValues(ids) {
  const fields = ids.map(el);
  fields.forEach((field) => field.setAttribute('aria-invalid', String(!field.checkValidity() || field.value === '')));
  if (fields.some((field) => field.getAttribute('aria-invalid') === 'true')) return null;
  return fields.map((field) => Number(field.value));
}
function showAnswer(id, text, why, outcome) {
  el(id + '-answer').textContent = text;
  el(id + '-why').textContent = why;
  el(id + '-card').dataset.outcome = outcome;
}
function updateToy() {
  const values = moneyValues(['toy-max', 'toy-min', 'toy-price']);
  if (!values) { el('toy-question').textContent = 'Which price should we check?'; showAnswer('toy', 'Add three pretend dollar amounts.', 'Use whole numbers from $1 to $1,000.', 'pending'); return; }
  const [max, min, price] = values;
  el('toy-question').textContent = 'Would ' + dollars(price) + ' work for both of us?';
  const yes = price <= max && price >= min;
  const reasons = [];
  if (price > max) reasons.push(dollars(price) + ' is more than your ' + dollars(max) + ' limit.');
  if (price < min) reasons.push(dollars(price) + ' is less than the ' + dollars(min) + ' Sam needs.');
  showAnswer('toy', (yes ? 'Yes — ' : 'No — ') + dollars(price) + (yes ? ' works for both of you.' : ' does not work for both of you.'), yes ? 'You can pay up to ' + dollars(max) + ', so ' + dollars(price) + ' is okay for you. Sam wants at least ' + dollars(min) + ', so ' + dollars(price) + ' is okay for Sam too.' : reasons.join(' '), yes ? 'yes' : 'no');
}
function updateTime() {
  const [as, ae, bs, be] = ['time-a-start', 'time-a-end', 'time-b-start', 'time-b-end'].map(id => Number(el(id).value));
  el('time-a-end').setAttribute('aria-invalid', String(ae <= as));
  el('time-b-end').setAttribute('aria-invalid', String(be <= bs));
  if (ae <= as || be <= bs) { showAnswer('time', 'The finish needs to be after the start.', 'Choose a later “until” time for each person.', 'pending'); return; }
  const start = Math.max(as, bs), end = Math.min(ae, be), yes = end - start >= 1;
  showAnswer('time', yes ? 'Play from ' + hour(start) + ' to ' + hour(start + 1) + '.' : 'No shared hour found.', yes ? 'You are free from ' + hour(as) + ' to ' + hour(ae) + '. Sam is free from ' + hour(bs) + ' to ' + hour(be) + '. The first whole hour inside both is ' + hour(start) + ' to ' + hour(start + 1) + '.' : 'You are free from ' + hour(as) + ' to ' + hour(ae) + ', and Sam from ' + hour(bs) + ' to ' + hour(be) + '. There is no whole hour inside both.', yes ? 'yes' : 'no');
}
function updateLunch() {
  const values = moneyValues(['lunch-you', 'lunch-sam', 'lunch-jo']);
  if (!values) { showAnswer('lunch', 'Add a pretend budget for each friend.', 'Use whole numbers from $1 to $1,000.', 'pending'); return; }
  const menu = [{name:'Sandwich', price:5}, {name:'Pizza', price:8}, {name:'Sushi', price:12}];
  const fits = menu.filter(option => values.every(budget => budget >= option.price));
  const skipped = menu.filter(option => !fits.includes(option));
  showAnswer('lunch', fits.length ? fits.map(option => option.name + ' — ' + dollars(option.price) + ' each').join(' · ') : 'None of these lunches fits everyone.', fits.length ? 'All three budgets cover ' + fits.map(option => 'the ' + dollars(option.price) + ' ' + option.name.toLowerCase()).join(' and ') + '.' + (skipped.length ? ' The other choices cost more than at least one friend can spend.' : ' Everyone can choose any of these lunches.') : 'Even the cheapest choice costs $5 each. At least one friend has less than $5.', fits.length ? 'yes' : 'no');
}
const presets = {
  'toy-yes': {'toy-max':10, 'toy-min':6, 'toy-price':8},
  'toy-no': {'toy-max':10, 'toy-min':6, 'toy-price':12},
  'time-yes': {'time-a-start':14, 'time-a-end':16, 'time-b-start':15, 'time-b-end':17},
  'time-no': {'time-a-start':14, 'time-a-end':15, 'time-b-start':16, 'time-b-end':17},
  'lunch-more': {'lunch-you':15, 'lunch-sam':15, 'lunch-jo':15},
  'lunch-none': {'lunch-you':10, 'lunch-sam':8, 'lunch-jo':3},
  'lunch-reset': {'lunch-you':10, 'lunch-sam':8, 'lunch-jo':6},
};
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
  Object.entries(presets[button.dataset.preset]).forEach(([id, value]) => { el(id).value = String(value); });
  updateToy(); updateTime(); updateLunch();
}));
el('case-toy').addEventListener('input', updateToy);
el('case-time').addEventListener('change', updateTime);
el('case-lunch').addEventListener('input', updateLunch);
updateToy(); updateTime(); updateLunch();
`;
