/**
 * Client half: a compact memory ring in the composer dock.
 * It reads one number from the plugin's own read-only endpoint, so the figure stays on screen
 * instead of in every prompt. One timer, removed with the slot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-crash-lore',
  factory(load) {
    const React = load('react');
    const h = React.createElement;
    const POLL_MS = 15000;
    const SIZE = 16;
    const STROKE = 2.5;
    const RADIUS = (SIZE - STROKE) / 2;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
    const DANGER = 85;
    const WARN = 70;
    const RED = '#e5484d';
    const AMBER = '#d9930d';

    function colorOf(pct) {
      if (pct >= DANGER) return RED;
      if (pct >= WARN) return AMBER;
      return 'currentColor';
    }

    function hintOf(state) {
      if (!state || !state.heapMB) return '内存占用';
      const used = `${state.heapMB} / ${state.wallMB} MB`;
      if (state.pct >= DANGER) return `接近内存上限（${used}）：重启 DSH 才会释放`;
      return `内存占用 ${used}`;
    }

    function Ring(props) {
      const pct = Math.max(0, Math.min(100, props.pct));
      const color = colorOf(pct);
      const danger = pct >= DANGER;
      const arc = h('circle', { key: 'arc', cx: SIZE / 2, cy: SIZE / 2, r: RADIUS, fill: 'none', stroke: color, strokeWidth: STROKE, strokeLinecap: 'round', strokeDasharray: CIRCUMFERENCE, strokeDashoffset: CIRCUMFERENCE * (1 - pct / 100), transform: `rotate(-90 ${SIZE / 2} ${SIZE / 2})` });
      const track = h('circle', { key: 'track', cx: SIZE / 2, cy: SIZE / 2, r: RADIUS, fill: 'none', stroke: 'currentColor', strokeWidth: STROKE, opacity: 0.22 });
      const parts = [track, arc];
      if (danger) parts.push(h('text', { key: 'mark', x: SIZE / 2, y: SIZE / 2, textAnchor: 'middle', dominantBaseline: 'central', fontSize: 12, fontWeight: 700, fill: color }, '!'));
      return h('svg', { width: SIZE, height: SIZE, viewBox: `0 0 ${SIZE} ${SIZE}`, 'aria-hidden': true, style: { display: 'block', flex: 'none' } }, parts);
    }

    function Health() {
      const [state, setState] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        const pull = () => {
          Promise.resolve()
            .then(() => fetch('/crash-lore/health', { cache: 'no-store' }))
            .then((response) => (response.ok ? response.json() : null))
            .then((payload) => {
              if (alive) setState(payload && payload.enabled ? payload : { enabled: false });
            })
            .catch(() => {
              /* endpoint missing means the feature is off; keep the last reading */
            });
        };
        pull();
        const timer = setInterval(pull, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      if (!state || !state.enabled) return null;

      const pct = Number.isFinite(state.pct) ? state.pct : 0;
      const color = pct >= DANGER ? RED : pct >= WARN ? AMBER : 'inherit';
      const style = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, lineHeight: 1, color, whiteSpace: 'nowrap', userSelect: 'none' };
      return h('span', { title: hintOf(state), style }, h('span', { key: 'label', style: { opacity: 0.66 } }, '内存'), h(Ring, { key: 'ring', pct }), h('span', { key: 'pct', style: { fontVariantNumeric: 'tabular-nums' } }, `${pct}%`));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'crash-lore-health', order: 40 }, Health),
        );
      },
    };
  },
});
