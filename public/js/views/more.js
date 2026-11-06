// Messages, Alerts, Settings and Audit log.
import { h, api, money, num, info, card, pageHead, loading, errorBox, empty, toast, confirmDialog, field, ago, short, localTime, table, cap, segmented, centsInput, readCents, applyTheme, setCurrency, confirmStepUp } from '../lib.js';
const RANK = { readonly: 0, support: 1, finance: 2, owner: 3 };
import { T } from '../glossary.js';

const TRIGGER_LABEL = { now: 'Sent now', scheduled: 'Scheduled', first_visit: 'On first visit', wallet_connect: 'When they connect a wallet', first_deposit: 'On first deposit' };

export function messagesView(ctx) {
  const root = h('div', { class: 'page' }, pageHead('Messages', 'Send a message to chosen players: now, at a set time, or automatically when something happens. Players see it as a popup on the casino and in their inbox.'));
  const listBox = h('div', {}, loading());
  // Composer
  const title = h('input', { class: 'input', maxlength: 80, placeholder: 'Welcome bonus inside' });
  const bodyT = h('textarea', { class: 'input', rows: 4, maxlength: 1000, placeholder: 'Write your message. Keep it short and clear.' });
  const btnLabel = h('input', { class: 'input', maxlength: 30, placeholder: 'Play now' });
  const btnUrl = h('input', { class: 'input', placeholder: '/ or https://...' });
  const aud = h('select', { class: 'input' }, h('option', { value: 'players' }, 'Chosen players'), h('option', { value: 'segment' }, 'A group (filters)'), h('option', { value: 'all' }, 'Everyone active'));
  const ids = h('textarea', { class: 'input', rows: 3, placeholder: 'Paste player ids or wallet addresses, one per line or separated by commas' });
  const joined = h('input', { class: 'input', type: 'number', min: 1, placeholder: 'days' });
  const inactive = h('input', { class: 'input', type: 'number', min: 1, placeholder: 'days' });
  const minBet = h('input', { class: 'input', type: 'number', min: 0, placeholder: 'TICS' });
  const country = h('input', { class: 'input', maxlength: 2, placeholder: 'GB' });
  const device = h('select', { class: 'input' }, h('option', { value: '' }, 'Any device'), h('option', { value: 'mobile' }, 'Phones'), h('option', { value: 'tablet' }, 'Tablets'), h('option', { value: 'desktop' }, 'Computers'));
  const hasWallet = h('input', { type: 'checkbox' });
  const segmentBox = h('div', { class: 'form-grid', hidden: true }, field('Joined in the last', joined), field('Not seen for at least', inactive), field('Has bet at least (TICS)', minBet), field('Country code', country), field('Device', device),
    h('label', { class: 'check' }, hasWallet, ' Only players with a wallet connected'));
  const idsBox = field('Players', ids, 'Player ids are shown on the Players screen. Wallet addresses work once wallet connect is live.');
  const when = h('select', { class: 'input' }, h('option', { value: 'now' }, 'Send now'), h('option', { value: 'scheduled' }, 'At a set time'),
    ...(ctx.can('message:trigger') ? [h('option', { value: 'wallet_connect' }, 'Automatically, when the player connects their wallet'), h('option', { value: 'first_visit' }, 'Automatically, on their first visit')] : []));
  const sendAt = h('input', { class: 'input', type: 'datetime-local' });
  const sendAtBox = field('Send at (your local time)', sendAt); sendAtBox.hidden = true;
  const audienceCount = h('span', { class: 'muted' });
  const preview = h('div', { class: 'msg-preview' });
  const audience = () => aud.value === 'all' ? { type: 'all' } : aud.value === 'players' ? { type: 'players', ids: ids.value.split(/[\s,]+/).filter(Boolean) }
    : { type: 'segment', filters: Object.fromEntries(Object.entries({ joinedWithinDays: Number(joined.value) || null, inactiveDays: Number(inactive.value) || null,
      minBetCents: minBet.value ? Math.round(Number(minBet.value) * 100) : null, country: country.value.trim() || null, device: device.value || null, hasWallet: hasWallet.checked || null }).filter(([, v]) => v)) };
  let countTimer;
  const recount = () => { clearTimeout(countTimer); countTimer = setTimeout(async () => {
    try { const r = await api('/messages/audience', { method: 'POST', body: { audience: audience() } }); audienceCount.textContent = `${num(r.count)} player${r.count === 1 ? '' : 's'} will get this`; }
    catch (e) { audienceCount.textContent = e.message; }
  }, 300); };
  const renderPreview = () => preview.replaceChildren(h('div', { class: 'msg-card' }, h('b', {}, title.value || 'Your title'), h('p', {}, bodyT.value || 'Your message appears here.'),
    btnUrl.value ? h('span', { class: 'btn primary small' }, btnLabel.value || 'Open') : null));
  aud.onchange = () => { segmentBox.hidden = aud.value !== 'segment'; idsBox.hidden = aud.value !== 'players'; recount(); };
  when.onchange = () => { sendAtBox.hidden = when.value !== 'scheduled'; };
  [ids, joined, inactive, minBet, country, device, hasWallet].forEach(el => el.addEventListener('input', recount));
  [title, bodyT, btnLabel, btnUrl].forEach(el => el.addEventListener('input', renderPreview));
  renderPreview();
  const composer = card('New message', 'Write it, choose who gets it and when. You will see exactly how many players it reaches before sending.',
    h('div', { class: 'grid2 even' },
      h('form', { class: 'stack', onsubmit: async e => {
        e.preventDefault();
        const payload = { title: title.value, body: bodyT.value, buttonLabel: btnLabel.value, buttonUrl: btnUrl.value, audience: audience(), trigger: when.value,
          sendAt: when.value === 'scheduled' && sendAt.value ? new Date(sendAt.value).toISOString() : undefined };
        const explain = when.value === 'now' ? `It goes out right away. ${audienceCount.textContent}.` : when.value === 'scheduled' ? `It goes out at ${sendAt.value ? new Date(sendAt.value).toLocaleString() : '(pick a time)'}.`
          : 'It stays on and goes to each matching player the moment it happens, until you stop it.';
        if (!await confirmDialog({ title: `Send "${title.value || 'this message'}"?`, body: explain, confirmLabel: 'Send' })) return;
        try { const r = await api('/messages', { method: 'POST', body: payload }); toast(r.status === 'sent' ? `Sent to ${num(r.delivered)} players.` : 'Saved. It will go out automatically.'); loadList(); }
        catch (err) { toast(err.message, 'bad'); }
      } },
        field('Title', title), field('Message', bodyT), h('div', { class: 'form-grid' }, field('Button text (optional)', btnLabel), field('Button link (optional)', btnUrl, 'Where the button takes the player. Use / for the casino home page.')),
        field('Who gets it', aud, T.audience), idsBox, segmentBox, audienceCount,
        field('When', when, T.trigger), sendAtBox,
        h('div', { class: 'channels', tip: T.channels }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, disabled: true }), ' On the casino site'),
          h('label', { class: 'check muted' }, h('input', { type: 'checkbox', disabled: true }), ' Email (coming later)'), h('label', { class: 'check muted' }, h('input', { type: 'checkbox', disabled: true }), ' Telegram (coming later)')),
        ctx.can('message:send') ? h('button', { class: 'btn primary', type: 'submit' }, 'Review and send') : h('p', { class: 'muted' }, 'Your role cannot send messages.')),
      h('div', {}, h('p', { class: 'muted small' }, 'What the player sees'), preview)));
  root.append(composer, card('Sent and scheduled', 'Every message, with how many players got it, saw it and clicked the button.', listBox));
  async function loadList() {
    try {
      const { messages } = await api('/messages');
      listBox.replaceChildren(table([
        { label: 'Message', render: m => h('div', {}, h('b', {}, m.title), h('div', { class: 'muted small' }, m.body.slice(0, 80))) },
        { label: 'When', render: m => m.trigger === 'scheduled' ? `${TRIGGER_LABEL.scheduled}: ${localTime(m.send_at)}` : TRIGGER_LABEL[m.trigger] },
        { label: 'Status', render: m => h('span', { class: `pill ${m.status === 'active' ? 'on' : m.status === 'sent' ? 'warn' : 'off'}` }, m.status === 'active' ? 'Waiting / on' : cap(m.status)) },
        { label: 'Got it', align: 'right', render: m => num(m.delivered) }, { label: 'Seen', align: 'right', render: m => num(m.seen) }, { label: 'Clicked', align: 'right', render: m => num(m.clicked) },
        { label: '', render: m => m.status === 'active' && ctx.can('message:send') ? h('button', { class: 'btn small', onclick: async e => { e.stopPropagation(); if (!await confirmDialog({ title: 'Stop this message?', body: 'Players who already got it keep it. Nobody new will get it.' })) return; await api(`/messages/${m.id}/stop`, { method: 'POST' }); toast('Stopped.'); loadList(); } }, 'Stop') : '' },
      ], messages, { emptyText: 'No messages yet. Write your first one above.' }));
    } catch (e) { listBox.replaceChildren(errorBox(e, loadList)); }
  }
  loadList();
  return root;
}

let alertTab = 'open';
export function alertsView(ctx) {
  const root = h('div', { class: 'page' });
  const body = h('div', {}, loading());
  root.append(pageHead('Alerts', 'Things that need a look: big wins, losing days, payback drifting from target, failed checks. Each one is also sent to your Telegram.',
    segmented([['open', 'Open'], ['resolved', 'Resolved']], alertTab, v => { alertTab = v; load(); }),
    ctx.can('alert:resolve') ? h('button', { class: 'btn', onclick: async () => { const r = await api('/alerts/check', { method: 'POST' }); toast(`Checked. ${r.checked} rule result${r.checked === 1 ? '' : 's'}.`); load(); } }, 'Check now') : null), body);
  async function load() {
    try {
      const d = await api(`/alerts?status=${alertTab}`);
      const list = d.alerts.length ? h('div', { class: 'alert-list' }, d.alerts.map(a => h('div', { class: `alert-item ${a.severity}` }, h('span', { class: 'dot' }),
        h('div', { class: 'grow' }, h('b', {}, a.title), h('p', { class: 'muted' }, a.details || ''), h('small', { class: 'muted' }, `${ago(a.created_at)}${a.telegram_sent ? ' · sent to Telegram' : ''}${a.resolved_by ? ` · resolved by ${a.resolved_by}` : ''}`)),
        a.player_id ? h('a', { class: 'btn small', href: `#/players/${a.player_id}` }, 'Player') : null,
        a.round_id ? h('a', { class: 'btn small', href: `#/rounds/${encodeURIComponent(a.round_id)}` }, 'Round') : null,
        a.status === 'open' && ctx.can(a.severity === 'critical' ? 'alert:resolve_critical' : 'alert:resolve') ? h('button', { class: 'btn small primary', onclick: async () => { await api(`/alerts/${a.id}/resolve`, { method: 'POST' }); toast('Marked as resolved.'); load(); } }, 'Resolve') : null)))
        : empty(alertTab === 'open' ? 'All clear' : 'Nothing resolved yet', alertTab === 'open' ? 'No open alerts. New ones also go to your Telegram.' : 'Resolved alerts are kept here.');
      body.replaceChildren(list, limitsCard(ctx, d.limits, load));
    } catch (e) { body.replaceChildren(errorBox(e, load)); }
  }
  load();
  return root;
}

function limitsCard(ctx, limits, reload) {
  const can = ctx.can('settings:edit');
  const big = centsInput(limits.bigWinAlertCents, { disabled: !can }), loss = centsInput(limits.dailyHouseLossAlertCents, { disabled: !can }), up = centsInput(limits.playerUpAlertCents, { disabled: !can });
  const drift = h('input', { class: 'input', type: 'number', step: '0.5', min: '0.5', value: limits.rtpDriftPct, disabled: !can });
  const minRounds = h('input', { class: 'input', type: 'number', min: '50', value: limits.rtpDriftMinRounds, disabled: !can });
  const slotMult = h('input', { class: 'input', type: 'number', min: '1', max: '2000', value: limits.slotBigWinMultiple ?? 100, disabled: !can });
  const driftSlot = h('input', { class: 'input', type: 'number', step: '0.5', min: '1', max: '50', value: limits.rtpDriftPctSlot ?? 8, disabled: !can });
  const minRoundsSlot = h('input', { class: 'input', type: 'number', min: '1000', max: '1000000', value: limits.rtpDriftMinRoundsSlot ?? 20000, disabled: !can });
  return card('Alert limits', 'When each alert fires. Only real-money rounds count; demo play never raises an alert. Changes apply from the next check (every 2 minutes).', h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault();
    // Alert levels decide when you hear about money going out: your password and a fresh code.
    const step = await confirmStepUp({ title: 'Save alert limits?', confirmLabel: 'Save', body: 'Changes apply from the next check.' });
    if (!step) return;
    try { await api('/settings/limits', { method: 'PUT', body: { bigWinAlertCents: readCents(big), dailyHouseLossAlertCents: readCents(loss), playerUpAlertCents: readCents(up), rtpDriftPct: Number(drift.value), rtpDriftMinRounds: Number(minRounds.value), slotBigWinMultiple: Number(slotMult.value), rtpDriftPctSlot: Number(driftSlot.value), rtpDriftMinRoundsSlot: Number(minRoundsSlot.value), ...step } }); toast('Alert limits saved.'); reload(); }
    catch (err) { toast(err.message, 'bad'); }
  } }, h('div', { class: 'form-grid' }, field('Big win over (TICS)', big, T.bigWinLimit), field('Casino or a game down today by (TICS)', loss, T.dailyLossLimit), field('Player up overall by (TICS)', up, T.playerUpLimit),
    field('Payback off target by (points)', drift, T.driftLimit), field('Only after this many rounds', minRounds, 'Payback swings a lot over a few rounds. This avoids false alarms.'),
    field('Slot win counts as big from (times the bet)', slotMult, T.slotBigWin),
    field('Slot payback off target by (points)', driftSlot, T.driftLimitSlot), field('Slot: only after this many rounds', minRoundsSlot, T.driftMinRoundsSlot)),
    can ? h('button', { class: 'btn primary' }, 'Save alert limits') : null));
}

export function settingsView(ctx) {
  const root = h('div', { class: 'page' }, pageHead('Settings', 'House currency, play or real money, who can use this panel, and the look of the panel.'));
  const body = h('div', {}, loading()); root.append(body);
  async function load() {
    try { render(await api('/settings')); } catch (e) { body.replaceChildren(errorBox(e, load)); }
  }
  function render(s) {
    const owner = ctx.can('settings:edit');
    const cur = s.currency;
    const sym = h('input', { class: 'input', value: cur.symbol, disabled: !owner }), name = h('input', { class: 'input', value: cur.name, disabled: !owner });
    const network = h('select', { class: 'input', disabled: !owner }, h('option', { value: 'tron', selected: cur.network !== 'ethereum' }, 'Tron (TRC-20)'), h('option', { value: 'ethereum', selected: cur.network === 'ethereum' }, 'Ethereum (ERC-20)'));
    const contract = h('input', { class: 'input mono', value: cur.contract, disabled: !owner }), decimals = h('input', { class: 'input', type: 'number', value: cur.decimals, disabled: !owner });
    const rate = h('input', { class: 'input', type: 'number', step: 'any', value: cur.usdRate, disabled: !owner });
    const theme = localStorage.getItem('noir-admin-theme') || 'auto';
    const parts = [
      card('Look', 'How this panel looks on this device.', h('div', { class: 'gm' }, h('span', {}, 'Theme'), segmented([['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']], theme, v => applyTheme(v), 'Auto follows your phone or computer setting.'))),
      card('Real or demo', T.mode, h('p', { class: 'muted' }, 'Use the Real TICS / Demo switch at the top of every page to choose which money the panel shows. Real play for players is switched on or off on the Treasury page, under Payout settings.'),
        h('p', { class: 'small' }, h('a', { href: '#/treasury' }, 'Open Treasury →'))),
      card('House currency', T.currency, h('form', { class: 'stack', onsubmit: async e => {
        e.preventDefault();
        const symbol = sym.value.trim().toUpperCase();
        if (!await confirmDialog({ title: `Make ${symbol} the house currency?`, typed: symbol, body: 'In play money mode this changes the token name and details shown everywhere. Once real money is live, changing it will convert every balance at the rate you enter, so it will need extra checks.' })) return;
        try { const r = await api('/settings/currency', { method: 'PUT', body: { symbol, name: name.value, network: network.value, contract: contract.value, decimals: Number(decimals.value), usdRate: Number(rate.value), confirm: symbol } }); setCurrency(r); toast(`House currency is now ${r.symbol}.`); load(); }
        catch (err) { toast(err.message, 'bad'); }
      } }, h('div', { class: 'form-grid' }, field('Token symbol', sym, 'Short name, like USDT.'), field('Token name', name), field('Network', network, 'The blockchain the token lives on. USDT on Tron has the lowest fees.'), field('Contract address', contract, 'USDT on Tron is TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t. USDT on Ethereum is 0xdAC17F958D2ee523a2206206994597C13D831ec7.'),
        field('Decimals', decimals, 'How many decimal places the token uses on chain. USDT and USDC use 6.'), field('Price in US dollars', rate, 'Used to show profit in USD as well. 1 for dollar stablecoins.')),
        owner ? h('button', { class: 'btn primary' }, 'Save currency') : h('p', { class: 'muted' }, 'Only an owner can change this.'))),
    ];
    if (s.admins) {
      const email = h('input', { class: 'input', type: 'email', placeholder: 'name@example.com' }), aname = h('input', { class: 'input', placeholder: 'Their name' });
      const role = h('select', { class: 'input' }, Object.entries(s.roles).map(([k, v]) => h('option', { value: k, selected: k === 'readonly' }, v)));
      const showLink = link => confirmDialog({ title: 'Send them this setup link', confirmLabel: 'Done', body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'It works once and expires in 48 hours. They choose their own password and connect an authenticator app. Send it privately.'),
        h('input', { class: 'input mono', value: link, readonly: true, onfocus: e => e.target.select() }),
        h('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(link); toast('Link copied'); } }, 'Copy link')) });
      parts.push(card('People who can use this panel', T.roles, table([
        { label: 'Name', render: a => h('div', {}, h('b', {}, a.name), h('div', { class: 'muted small' }, a.email)) },
        { label: 'Role', render: a => a.id === ctx.admin.id ? s.roles[a.role] : h('select', { class: 'input small', onchange: async e => {
          const role = e.target.value;
          // Giving someone more power needs your password and a fresh code (and a new owner waits 48 hours for treasury actions).
          // Giving more power, or taking an owner's away, needs your password and a fresh code.
          const demotingOwner = a.role === 'owner' && role !== 'owner';
          const step = RANK[role] > RANK[a.role] || demotingOwner ? await confirmStepUp({ title: `Make ${a.name} ${s.roles[role]}?`, confirmLabel: 'Change role', danger: role === 'owner' || demotingOwner,
            body: role === 'owner' ? 'Owners can do everything, including moving money. A new owner can send to the treasury only 48 hours after this. Everyone gets an alert.'
              : demotingOwner ? 'They stop being an owner at once. Everyone gets an alert. There must always be at least one active owner.' : 'They get more rights at once.' }) : {};
          if (!step) { load(); return; }
          try { await api(`/admins/${a.id}`, { method: 'PUT', body: { role, ...step } }); toast('Role changed.'); } catch (err) { toast(err.message, 'bad'); load(); } } },
          Object.entries(s.roles).map(([k, v]) => h('option', { value: k, selected: k === a.role }, v))) },
        { label: 'Status', render: a => !a.active ? h('span', { class: 'pill off' }, 'Removed') : a.totp_enabled ? h('span', { class: 'pill on' }, 'Active') : h('span', { class: 'pill warn' }, 'Setup not finished') },
        { label: 'Last sign in', render: a => a.last_login_at ? ago(a.last_login_at) : 'Never' },
        { label: '', render: a => a.id === ctx.admin.id ? h('span', { class: 'muted small' }, 'You') : h('div', { class: 'actions' },
          h('button', { class: 'btn small', onclick: async () => {
            const step = await confirmStepUp({ title: a.totp_enabled ? `Reset ${a.name}'s sign in?` : `New setup link for ${a.name}?`, confirmLabel: 'Make link',
              body: 'They are signed out and must set a new password and authenticator app with the link.' });
            if (!step) return;
            try { const r = await api(`/admins/${a.id}/setup-link`, { method: 'POST', body: step }); showLink(r.setupLink); } catch (err) { toast(err.message, 'bad'); } } }, a.totp_enabled ? 'Reset sign in' : 'New setup link'),
          !a.active ? h('button', { class: 'btn small', onclick: async () => {
            const step = await confirmStepUp({ title: `Let ${a.name} back in?`, confirmLabel: 'Reactivate', body: 'They can sign in again with their own password and app.' });
            if (!step) return;
            try { await api(`/admins/${a.id}`, { method: 'PUT', body: { active: true, ...step } }); toast('Reactivated.'); load(); } catch (err) { toast(err.message, 'bad'); } } }, 'Reactivate') : null,
          a.active ? h('button', { class: 'btn small danger', onclick: async () => {
            const body = 'They are signed out at once and cannot sign in again. Their past actions stay in the audit log.';
            // Removing an owner needs your password and a fresh code (and alerts everyone).
            const step = a.role === 'owner' ? await confirmStepUp({ title: `Remove owner ${a.name}?`, danger: true, confirmLabel: 'Remove', body: `${body} Everyone gets an alert.` })
              : (await confirmDialog({ title: `Remove ${a.name}?`, danger: true, body }) ? {} : null);
            if (!step) return;
            try { await api(`/admins/${a.id}`, { method: 'PUT', body: { active: false, ...step } }); toast('Removed.'); load(); } catch (err) { toast(err.message, 'bad'); } } }, 'Remove') : null) },
      ], s.admins),
      h('form', { class: 'inline-form', onsubmit: async e => {
        e.preventDefault();
        const step = await confirmStepUp({ title: `Add ${aname.value || 'this person'} as ${s.roles[role.value]}?`, confirmLabel: 'Add person', danger: role.value === 'owner',
          body: role.value === 'owner' ? 'A new owner can do everything. Everyone gets an alert, and they can send to the treasury only 48 hours after setting up.' : 'You get a one-time setup link to send them.' });
        if (!step) return;
        try { const r = await api('/admins', { method: 'POST', body: { email: email.value, name: aname.value, role: role.value, ...step } }); await showLink(r.setupLink); load(); } catch (err) { toast(err.message, 'bad'); }
      } }, aname, email, role, h('button', { class: 'btn primary' }, 'Add person'))));
    }
    body.replaceChildren(...parts);
  }
  load();
  return root;
}

export function auditView() {
  const root = h('div', { class: 'page' }, pageHead('Audit log', 'Every change made in this panel, newest first. Entries can never be edited or deleted.'));
  const body = h('div', {}, loading()); root.append(body);
  const describe = e => {
    const pairs = e.after ? Object.entries(e.after).map(([k, v]) => `${k}: ${e.before && k in e.before ? `${JSON.stringify(e.before[k])} → ` : ''}${JSON.stringify(v)}`) : [];
    return pairs.join(', ').slice(0, 220);
  };
  (async () => {
    try {
      const { entries } = await api('/audit?limit=300');
      body.replaceChildren(table([
        { label: 'When', render: e => h('span', { tip: localTime(e.created_at) }, ago(e.created_at)) }, { label: 'Who', key: 'admin_email' },
        { label: 'What', render: e => e.action.replace(/[._]/g, ' ') }, { label: 'On', render: e => h('span', { class: 'mono small' }, e.target || '') },
        { label: 'Change', render: e => h('span', { class: 'small' }, describe(e)) }, { label: 'Reason', render: e => e.reason || '' }], entries, { emptyText: 'No changes made yet.' }));
    } catch (e) { body.replaceChildren(errorBox(e)); }
  })();
  return root;
}
