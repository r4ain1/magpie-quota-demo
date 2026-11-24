const preference = matchMedia('(prefers-reduced-motion: reduce)');
const enabled = () => !preference.matches && !document.hidden && !!Element.prototype.animate;
const easing = 'cubic-bezier(.2,.75,.25,1)';
const running = new Set();
let committed;
let latest;
let interactedCard;

function animate(node, frames, duration) {
  if (!node) return;
  const effect = node.animate(frames, { duration, easing });
  running.add(effect);
  const forget = () => running.delete(effect);
  effect.onfinish = forget;
  effect.oncancel = forget;
  return effect;
}

function cancelEffects() {
  for (const effect of running) effect.cancel();
  running.clear();
}

preference.addEventListener('change', () => {
  if (preference.matches) cancelEffects();
});

function arrive(node) {
  animate(node, [
    { opacity: .82, transform: 'translateY(3px)' },
    { opacity: 1, transform: 'translateY(0)' }
  ], 150);
}

function meterState(group, selector = '.track > span') {
  const node = group.querySelector(selector);
  if (!node?.style.width.endsWith('%')) return;
  return { node, fraction: parseFloat(node.style.width) / 100 };
}

function sampleAmount(state, key, group, selector) {
  const node = group.querySelector(selector);
  if (node) state.amounts.set(key, { node, value: node.textContent });
}

function sampleCard(state, card) {
  const seat = card.querySelector('[data-seat]')?.dataset.seat;
  if (!seat) return;
  const key = JSON.stringify(['card', seat]);
  sampleAmount(state, key, card, '.card-number');
  const meter = meterState(card);
  if (meter) state.meters.set(key, meter);
}

document.getElementById('main')?.addEventListener('click', event => {
  const action = event.target.closest('[data-seat]');
  const card = action?.closest('.account');
  if (!committed || !card) return;
  const index = Array.prototype.indexOf.call(card.parentElement.children, card);
  interactedCard = { index, seat: action.dataset.seat };
  if (index >= 6 && !committed.meters.has(JSON.stringify(['card', action.dataset.seat]))) {
    sampleCard(committed, card);
  }
}, true);

function readState() {
  const main = document.getElementById('main');
  const state = {
    route: document.querySelector('#nav [aria-current="page"]')?.hash,
    filters: new Map(), amounts: new Map(), meters: new Map()
  };
  if (!main) return state;
  for (const section of main.children) {
    const head = section.matches('.section-head') ? section : section.firstElementChild;
    if (!head?.matches('.section-head')) continue;
    const selected = head.querySelector('.filter [aria-pressed="true"]');
    if (!selected) continue;
    const results = head.nextElementSibling;
    state.filters.set(selected.dataset.cmd, {
      value: selected.dataset.value, target: results?.firstElementChild ?? results
    });
    if (!results?.matches('.cards')) continue;
    let card = results.firstElementChild;
    for (let index = 0; card && index < 6; index++, card = card.nextElementSibling) {
      sampleCard(state, card);
    }
    if (interactedCard?.index >= 6) {
      const interacted = results.children[interactedCard.index];
      if (interacted?.querySelector('[data-seat]')?.dataset.seat === interactedCard.seat) sampleCard(state, interacted);
    }
  }
  const hero = main.querySelector(':scope > .feature-grid > .hero');
  if (hero) {
    state.hero = hero;
    state.selection = JSON.stringify(['#service', '#pool'].map(id => hero.querySelector(id)?.value));
    const seat = hero.querySelector('[data-seat]')?.dataset.seat;
    if (seat) {
      const key = JSON.stringify(['hero', seat]);
      sampleAmount(state, key, hero, '.hero-number');
      let row = hero.querySelector('.window');
      for (let index = 0; row?.matches('.window') && index < 4; index++, row = row.nextElementSibling) {
        const meter = meterState(row);
        if (meter) state.meters.set(JSON.stringify(['window', seat, row.firstElementChild.textContent]), meter);
      }
    }
  }
  return state;
}

export function beforeRender() {
  latest = { previous: committed };
  if (!enabled()) return latest;
  for (const meter of committed?.meters.values() ?? []) {
    meter.start = meter.fraction;
    if (meter.effect?.playState !== 'running') continue;
    const timing = meter.effect.effect.getComputedTiming();
    meter.start = meter.from + (meter.fraction - meter.from) * (timing.progress ?? 0);
    meter.remaining = Math.max(0, timing.duration - (meter.effect.currentTime ?? 0));
  }
  return latest;
}

function updateMeters(previous, current) {
  for (const [key, meter] of current) {
    const prior = previous.get(key);
    if (!prior) continue;
    const from = prior.start ?? prior.fraction;
    if (Math.abs(from - meter.fraction) < .0001) continue;
    const duration = prior.fraction === meter.fraction ? prior.remaining : 230;
    if (!(duration > 0)) continue;
    meter.node.classList.add('motion-meter');
    meter.node.style.transform = `scaleX(${meter.fraction})`;
    meter.from = from;
    meter.effect = animate(meter.node, [
      { transform: `scaleX(${from})` }, { transform: meter.node.style.transform }
    ], duration);
  }
}

export function afterRender(transaction) {
  if (!transaction || transaction !== latest) return;
  latest = undefined;
  cancelEffects();
  const previous = transaction.previous;
  const current = committed = readState();
  if (!previous || !enabled()) return;
  if (previous.route !== current.route) {
    arrive(document.querySelector('#main .page-head h1'));
    return;
  }
  for (const [key, filter] of current.filters) {
    if (previous.filters.get(key)?.value !== filter.value) arrive(filter.target);
  }
  if (current.selection !== previous.selection) arrive(current.hero?.querySelector('.hero-middle'));
  for (const [key, amount] of current.amounts) {
    const prior = previous.amounts.get(key);
    if (prior && prior.value !== amount.value) arrive(amount.node);
  }
  updateMeters(previous.meters, current.meters);
}

const notice = document.getElementById('notice');
if (notice) {
  const visual = document.createElement('div');
  visual.className = 'motion-notice';
  visual.setAttribute('aria-hidden', 'true');
  visual.inert = true;
  notice.after(visual);
  notice.classList.add('motion-live');
  const syncNotice = () => {
    const text = notice.textContent;
    if (text) visual.textContent = text;
    visual.toggleAttribute('data-visible', !!text);
  };
  new MutationObserver(syncNotice).observe(notice, {
    childList: true, characterData: true, subtree: true
  });
  syncNotice();
}
